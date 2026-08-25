import type { Logging } from 'homebridge';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import type { Readable } from 'node:stream';

/**
 * Local HTTP server that re-serves each zone's decoded AirPlay audio as a
 * chunked WAV stream. A Raumfeld renderer is pointed at `/airplay/<zoneId>.wav`
 * (via SetAVTransportURI) and pulls the PCM the receiver is producing.
 *
 * The shairport-sync receiver emits raw PCM in real time and MUST be drained
 * continuously or it stalls, so a zone's source is consumed as soon as it is
 * set — bytes are forwarded to any connected renderer(s) and dropped otherwise.
 * The renderer connects a moment after we call Play, so the tiny amount of audio
 * dropped before it attaches is inaudible.
 */

/** Raw PCM shairport-sync's `stdout`/pipe backend produces: CD-quality. */
export const PCM_SAMPLE_RATE = 44100;
export const PCM_CHANNELS = 2;
export const PCM_BITS = 16;

/** Advertised body length for the endless stream (~2 GiB; real end = socket close). */
const STREAM_CONTENT_LENGTH = String(0x7fffffff);
/** One renderer is expected; a second slot allows a clean reconnect overlap. */
const MAX_RESPONSES_PER_ZONE = 2;

interface ZoneStream {
  /** Rotated on every new session — see {@link AirPlayStreamServer.setSource}. */
  token: string;
  source?: Readable;
  readonly responses: Set<ServerResponse>;
  onData?: (chunk: Buffer) => void;
  onSourceEnd?: () => void;
}

export class AirPlayStreamServer {
  private server?: Server;
  private readonly zones = new Map<string, ZoneStream>();

  constructor(
    private readonly log: Logging,
    private readonly port: number,
    /** Advertised host the speakers use to reach us; auto-detected when unset. */
    private readonly advertisedHost?: string,
  ) {}

  async start(): Promise<void> {
    if (this.server?.listening) return;
    // This server is bound to every interface and answers unauthenticated
    // requests, but it lives inside the long-running Homebridge process: any
    // exception thrown synchronously out of the request handler becomes an
    // uncaught exception and takes the whole bridge down. Contain it.
    const server = createServer((req, res) => {
      try {
        this.handle(req, res);
      } catch (err) {
        this.log.debug(`AirPlay: stream request failed: ${(err as Error).message}`);
        if (!res.headersSent) res.writeHead(400);
        res.end();
      }
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Bind on all interfaces: the speakers may sit on another subnet.
        server.listen(this.port, '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (err) {
      // A failed listen must not poison future retries with a non-listening
      // server instance.
      if (this.server === server) this.server = undefined;
      server.close();
      throw err;
    }
    this.log.info(`AirPlay stream server listening on ${this.baseHost()}:${this.port}`);
  }

  stop(): void {
    for (const zoneId of [...this.zones.keys()]) this.clearSource(zoneId);
    this.zones.clear();
    this.server?.close();
    this.server = undefined;
  }

  /** Ensure a zone endpoint exists (idempotent). */
  register(zoneId: string): void {
    if (!this.zones.has(zoneId)) {
      this.zones.set(zoneId, {
        token: newToken(),
        responses: new Set(),
      });
    }
  }

  /** Drop a zone endpoint and disconnect any renderer pulling it. */
  unregister(zoneId: string): void {
    this.clearSource(zoneId);
    this.zones.delete(zoneId);
  }

  /** The URL a renderer should be told to play for this zone. */
  urlFor(zoneId: string): string {
    const zone = this.zones.get(zoneId);
    if (!zone) throw new Error(`AirPlay stream zone ${zoneId} is not registered`);
    return `http://${this.baseHost()}:${this.port}/airplay/${encodeURIComponent(zoneId)}.wav?token=${zone.token}`;
  }

  /**
   * Attach a live PCM source for a zone (the receiver's decoded output). Draining
   * starts immediately; bytes go to any connected renderer, else are discarded.
   */
  setSource(zoneId: string, source: Readable): void {
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    this.clearSource(zoneId);
    // Rotate the token per session. The URL is handed to the renderer via
    // SetAVTransportURI, and renderers echo CurrentURI back to any unauthenticated
    // caller on the LAN (GetMediaInfo/GetPositionInfo) — so a token that lived for
    // the whole process would stay valid long after it leaked. Callers read
    // urlFor() after this, so they always get the current one.
    zone.token = newToken();
    zone.source = source;
    const onData = (chunk: Buffer): void => {
      for (const res of zone.responses) {
        // Renderer may have dropped between its 'close' event and this chunk;
        // writing then throws ERR_STREAM_WRITE_AFTER_END. Skip dead sockets, and
        // drop (don't buffer) for a backpressured one — live audio can't queue.
        if (res.writableEnded || !res.writable || res.writableNeedDrain) continue;
        try {
          res.write(chunk);
        } catch {
          zone.responses.delete(res);
        }
      }
    };
    zone.onData = onData;
    const onSourceEnd = (): void => this.clearSource(zoneId);
    zone.onSourceEnd = onSourceEnd;
    source.on('data', onData);
    source.once('end', onSourceEnd);
    source.once('error', onSourceEnd);
  }

  /** Detach the current PCM source and end all renderer connections for a zone. */
  clearSource(zoneId: string): void {
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    if (zone.source && zone.onData) zone.source.off('data', zone.onData);
    if (zone.source && zone.onSourceEnd) {
      zone.source.off('end', zone.onSourceEnd);
      zone.source.off('error', zone.onSourceEnd);
    }
    zone.source = undefined;
    zone.onData = undefined;
    zone.onSourceEnd = undefined;
    for (const res of zone.responses) res.end();
    zone.responses.clear();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Node hands the raw request-target through almost unfiltered, and plenty of
    // targets it accepts are not parseable URLs (`//[` being the shortest).
    // Constructing one unguarded here used to throw straight out of the request
    // callback and crash Homebridge.
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const match = /^\/airplay\/([^/]+)\.wav$/.exec(requestUrl.pathname);
    const zoneId = match ? safeDecodeURIComponent(match[1]) : undefined;
    if (match && zoneId === undefined) {
      res.writeHead(400).end();
      return;
    }
    const zone = zoneId ? this.zones.get(zoneId) : undefined;
    const token = requestUrl.searchParams.get('token');
    if (!zone || !token || !tokensEqual(token, zone.token)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    if (!zone.source) {
      res.writeHead(503, { 'Retry-After': '1' }).end();
      return;
    }
    if (zone.responses.size >= MAX_RESPONSES_PER_ZONE) {
      res.writeHead(429, { 'Retry-After': '1' }).end();
      return;
    }

    // UPnP/DLNA renderers commonly reject chunked transfer-encoding for media, so
    // advertise a fixed (effectively endless) Content-Length instead and signal
    // the real end by closing the connection.
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': STREAM_CONTENT_LENGTH,
      Connection: 'close',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.write(wavHeader());
    zone.responses.add(res);
    this.log.debug(`AirPlay: renderer connected to zone ${zoneId} stream.`);
    const drop = (): void => {
      zone.responses.delete(res);
    };
    res.on('close', drop);
    res.on('error', drop);
  }

  private baseHost(): string {
    return this.advertisedHost ?? firstLanIPv4() ?? '127.0.0.1';
  }
}

/** 192 bits of entropy — far beyond guessing range for a LAN-facing endpoint. */
function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * A 44-byte canonical WAV header for a stream of unknown length. The RIFF/data
 * sizes are set to the maximum so players treat it as effectively endless; the
 * real end is signalled by closing the connection.
 */
function wavHeader(): Buffer {
  const blockAlign = (PCM_CHANNELS * PCM_BITS) / 8;
  const byteRate = PCM_SAMPLE_RATE * blockAlign;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(0xffffffff, 4); // RIFF chunk size (unknown/max)
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(PCM_CHANNELS, 22);
  buf.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(PCM_BITS, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(0xffffffff, 40); // data chunk size (unknown/max)
  return buf;
}

/** First non-internal IPv4, used as the stream host when none is configured. */
function firstLanIPv4(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return undefined;
}
