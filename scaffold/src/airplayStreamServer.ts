import type { Logging } from 'homebridge';
import { createServer, type Server, type ServerResponse } from 'node:http';
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

interface ZoneStream {
  source?: Readable;
  readonly responses: Set<ServerResponse>;
  onData?: (chunk: Buffer) => void;
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
    if (this.server) return;
    const server = createServer((req, res) => this.handle(req.url ?? '', res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Bind on all interfaces: the speakers may sit on another subnet.
      server.listen(this.port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
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
    if (!this.zones.has(zoneId)) this.zones.set(zoneId, { responses: new Set() });
  }

  /** Drop a zone endpoint and disconnect any renderer pulling it. */
  unregister(zoneId: string): void {
    this.clearSource(zoneId);
    this.zones.delete(zoneId);
  }

  /** The URL a renderer should be told to play for this zone. */
  urlFor(zoneId: string): string {
    return `http://${this.baseHost()}:${this.port}/airplay/${encodeURIComponent(zoneId)}.wav`;
  }

  /**
   * Attach a live PCM source for a zone (the receiver's decoded output). Draining
   * starts immediately; bytes go to any connected renderer, else are discarded.
   */
  setSource(zoneId: string, source: Readable): void {
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    this.clearSource(zoneId);
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
    source.on('data', onData);
    source.once('end', () => this.clearSource(zoneId));
    source.once('error', () => this.clearSource(zoneId));
  }

  /** Detach the current PCM source and end all renderer connections for a zone. */
  clearSource(zoneId: string): void {
    const zone = this.zones.get(zoneId);
    if (!zone) return;
    if (zone.source && zone.onData) zone.source.off('data', zone.onData);
    zone.source = undefined;
    zone.onData = undefined;
    for (const res of zone.responses) res.end();
    zone.responses.clear();
  }

  private handle(url: string, res: ServerResponse): void {
    const match = /^\/airplay\/([^/]+)\.wav$/.exec(url);
    const zoneId = match ? decodeURIComponent(match[1]) : undefined;
    const zone = zoneId ? this.zones.get(zoneId) : undefined;
    if (!zone) {
      res.writeHead(404).end();
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
