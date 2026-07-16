import type { Logging } from 'homebridge';
import type { RaumfeldClient } from './raumfeldClient.js';
import { AirPlayReceiver } from './airplayReceiver.js';
import { AirPlayStreamServer } from './airplayStreamServer.js';

export interface AirPlayTarget {
  /** Stable zone/room id (used as the receiver session key). */
  zoneId: string;
  /** Advertised AirPlay name, e.g. "Living Room". */
  name: string;
  /** Renderer udn the decoded PCM stream is pushed into. */
  rendererUdn: string;
  /** For a group: the member renderer udns (Raumfeld syncs these internally). */
  memberUdns: string[];
}

export interface AirPlayOptions {
  enabled: boolean;
  bufferMs: number;
  /** shairport-sync binary providing the AirPlay receiver. */
  binaryPath: string;
  /** Host/IP the speakers use to reach our stream server; auto-detect when unset. */
  streamHost?: string;
  streamPort: number;
}

/** Base RTSP port; each concurrent receiver gets base + index. */
const RTSP_PORT_BASE = 5000;

interface Session {
  target: AirPlayTarget;
  receiver: AirPlayReceiver;
  rtspPort: number;
}

/**
 * Advertises each Raumfeld zone (and group) as an AirPlay receiver via a
 * per-zone shairport-sync process, and on playback re-serves the decoded PCM to
 * that zone's renderer.
 *
 * Flow per zone: shairport-sync decodes AirPlay -> PCM on stdout ->
 * {@link AirPlayStreamServer} exposes it as an HTTP WAV URL -> the renderer is
 * pointed at that URL (SetAVTransportURI) and told to Play. Grouped zones target
 * the zone's (virtual) lead renderer, so Raumfeld keeps the member speakers in
 * sync internally — no manual PCM fan-out.
 *
 * If shairport-sync isn't installed, the bridge stays inert and warns once, so
 * the plugin degrades cleanly rather than advertising dead targets.
 */
export class AirPlayBridge {
  private readonly sessions = new Map<string, Session>();
  private readonly streamServer: AirPlayStreamServer;
  private available?: boolean;
  private serverStarted = false;
  private usedPorts = new Set<number>();

  constructor(
    private readonly log: Logging,
    private readonly client: RaumfeldClient,
    private readonly options: AirPlayOptions,
  ) {
    this.streamServer = new AirPlayStreamServer(log, options.streamPort, options.streamHost);
  }

  /** Reconcile advertised receivers with the current set of zones. */
  syncTargets(targets: AirPlayTarget[]): void {
    if (!this.options.enabled || !this.ensureAvailable()) {
      this.stopAll();
      return;
    }
    void this.ensureServer();

    const wanted = new Map(targets.map((t) => [t.zoneId, t]));

    // Drop receivers for zones that vanished.
    for (const [zoneId, session] of this.sessions) {
      if (!wanted.has(zoneId)) this.teardown(zoneId, session);
    }

    // Add receivers for new zones; refresh the target on existing ones.
    for (const target of targets) {
      const existing = this.sessions.get(target.zoneId);
      if (existing) {
        existing.target = target;
        continue;
      }
      this.startSession(target);
    }
  }

  stop(): void {
    this.stopAll();
    this.streamServer.stop();
    this.serverStarted = false;
  }

  private startSession(target: AirPlayTarget): void {
    const rtspPort = this.claimPort();
    const receiver = new AirPlayReceiver(this.log, this.options.binaryPath, target.name, rtspPort, {
      onSessionStart: (pcm) => {
        const session = this.sessions.get(target.zoneId);
        if (!session) return;
        this.streamServer.setSource(target.zoneId, pcm);
        const url = this.streamServer.urlFor(target.zoneId);
        this.log.debug(`AirPlay: routing "${session.target.name}" -> ${session.target.rendererUdn} via ${url}`);
        this.playOnRenderer(session.target, url).catch((err) =>
          this.log.error(`AirPlay: failed to start playback on "${session.target.name}": ${(err as Error).message}`));
      },
      onSessionEnd: () => {
        const session = this.sessions.get(target.zoneId);
        this.streamServer.clearSource(target.zoneId);
        if (!session) return;
        this.client.setPlayState(session.target.rendererUdn, 2) // 2 = STOP
          .catch((err) => this.log.debug(`AirPlay: stop on "${session.target.name}" failed: ${(err as Error).message}`));
      },
    });

    this.streamServer.register(target.zoneId);
    this.sessions.set(target.zoneId, { target, receiver, rtspPort });
    receiver.start();
    this.log.info(`AirPlay: advertising "${target.name}" (buffer ${this.options.bufferMs} ms).`);
  }

  private async playOnRenderer(target: AirPlayTarget, url: string): Promise<void> {
    await this.client.setAvTransportUri(target.rendererUdn, url);
    await this.client.setPlayState(target.rendererUdn, 0); // 0 = PLAY
  }

  private teardown(zoneId: string, session: Session): void {
    session.receiver.stop();
    this.streamServer.unregister(zoneId);
    this.usedPorts.delete(session.rtspPort);
    this.sessions.delete(zoneId);
  }

  private stopAll(): void {
    for (const [zoneId, session] of this.sessions) this.teardown(zoneId, session);
    this.sessions.clear();
    this.usedPorts.clear();
  }

  /** Check (once) that the shairport-sync binary is usable; warn if not. */
  private ensureAvailable(): boolean {
    if (this.available === undefined) {
      this.available = AirPlayReceiver.available(this.options.binaryPath);
      if (!this.available) {
        this.log.warn(
          `AirPlay: shairport-sync not found at "${this.options.binaryPath}"; zones will NOT appear as `
          + 'AirPlay targets. Install shairport-sync on the Homebridge host, set airplay.binaryPath, '
          + 'or set airplay.enabled=false to silence this.',
        );
      }
    }
    return this.available;
  }

  private async ensureServer(): Promise<void> {
    if (this.serverStarted) return;
    this.serverStarted = true;
    try {
      await this.streamServer.start();
    } catch (err) {
      this.serverStarted = false;
      this.log.error(`AirPlay: stream server failed to start: ${(err as Error).message}`);
    }
  }

  private claimPort(): number {
    let port = RTSP_PORT_BASE;
    // shairport-sync uses the RTSP port plus separate RTP UDP ports (timing/
    // control/audio); space instances well apart so those don't collide.
    while (this.usedPorts.has(port)) port += 10;
    this.usedPorts.add(port);
    return port;
  }
}
