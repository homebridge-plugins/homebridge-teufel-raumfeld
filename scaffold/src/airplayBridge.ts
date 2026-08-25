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
  /** shairport-sync binary providing the AirPlay receiver. */
  binaryPath: string;
  /** Host/IP the speakers use to reach our stream server; auto-detect when unset. */
  streamHost?: string;
  streamPort: number;
  /** AirPlay 1 password. Unset leaves every zone open to any device on the LAN. */
  password?: string;
}

/** Base RTSP port; each concurrent receiver gets base + index. */
const RTSP_PORT_BASE = 5000;
const RECEIVER_RESTART_DELAY_MS = 5000;

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
  private usedPorts = new Set<number>();
  private desiredTargets = new Map<string, AirPlayTarget>();
  private readonly restartTimers = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly log: Logging,
    private readonly client: RaumfeldClient,
    private readonly options: AirPlayOptions,
  ) {
    this.streamServer = new AirPlayStreamServer(log, options.streamPort, options.streamHost);
  }

  /** Reconcile advertised receivers with the current set of zones. */
  async syncTargets(targets: AirPlayTarget[]): Promise<void> {
    if (this.stopped) return;
    if (!this.options.enabled || !this.ensureAvailable()) {
      this.desiredTargets.clear();
      this.stopAll();
      this.streamServer.stop();
      return;
    }

    const wanted = new Map(targets.map((t) => [t.zoneId, t]));
    this.desiredTargets = wanted;
    try {
      await this.streamServer.start();
    } catch (err) {
      this.stopAll();
      this.log.error(`AirPlay: stream server failed to start: ${(err as Error).message}`);
      return;
    }
    if (this.stopped) {
      this.streamServer.stop();
      return;
    }

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
    this.stopped = true;
    this.desiredTargets.clear();
    this.stopAll();
    this.streamServer.stop();
  }

  private startSession(target: AirPlayTarget): void {
    const rtspPort = this.claimPort();
    const receiver = new AirPlayReceiver(this.log, this.options.binaryPath, target.name, rtspPort, {
      onSessionStart: (pcm) => {
        this.cancelRestart(target.zoneId);
        const session = this.sessions.get(target.zoneId);
        if (!session) return;
        this.streamServer.setSource(target.zoneId, pcm);
        const url = this.streamServer.urlFor(target.zoneId);
        this.log.debug(`AirPlay: routing "${session.target.name}" -> ${session.target.rendererUdn}.`);
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
      onUnexpectedExit: () => this.receiverExited(target.zoneId, receiver),
    }, this.options.password);

    this.cancelRestart(target.zoneId);
    this.streamServer.register(target.zoneId);
    this.sessions.set(target.zoneId, { target, receiver, rtspPort });
    receiver.start();
    this.log.info(`AirPlay: advertising "${target.name}".`);
  }

  private async playOnRenderer(target: AirPlayTarget, url: string): Promise<void> {
    await this.client.setAvTransportUri(target.rendererUdn, url);
    await this.client.setPlayState(target.rendererUdn, 0); // 0 = PLAY
  }

  private teardown(zoneId: string, session: Session): void {
    this.cancelRestart(zoneId);
    session.receiver.stop();
    this.streamServer.unregister(zoneId);
    this.usedPorts.delete(session.rtspPort);
    this.sessions.delete(zoneId);
  }

  private stopAll(): void {
    for (const zoneId of this.restartTimers.keys()) this.cancelRestart(zoneId);
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
      } else if (!this.options.password) {
        this.log.warn(
          'AirPlay: no airplay.password is set, so every zone is advertised as an OPEN AirPlay '
          + 'receiver — any device on this network can play audio through your speakers. Set '
          + 'airplay.password to require a password.',
        );
      }
    }
    return this.available;
  }

  private receiverExited(zoneId: string, receiver: AirPlayReceiver): void {
    const session = this.sessions.get(zoneId);
    if (!session || session.receiver !== receiver) return;
    this.streamServer.clearSource(zoneId);
    this.sessions.delete(zoneId);
    this.usedPorts.delete(session.rtspPort);

    if (this.stopped || !this.desiredTargets.has(zoneId)) return;
    this.log.warn(`AirPlay: receiver for "${session.target.name}" will restart in ${RECEIVER_RESTART_DELAY_MS} ms.`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(zoneId);
      const target = this.desiredTargets.get(zoneId);
      if (!target || this.stopped || this.sessions.has(zoneId)) return;
      this.startSession(target);
    }, RECEIVER_RESTART_DELAY_MS);
    timer.unref?.();
    this.restartTimers.set(zoneId, timer);
  }

  private cancelRestart(zoneId: string): void {
    const timer = this.restartTimers.get(zoneId);
    if (timer) clearTimeout(timer);
    this.restartTimers.delete(zoneId);
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
