import type { Logging } from 'homebridge';
import { readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { escapeXml, type RaumfeldClient } from './raumfeldClient.js';
import { AirPlayReceiver } from './airplayReceiver.js';
import { AirPlayStreamServer, STREAM_MIME_TYPE } from './airplayStreamServer.js';

export interface AirPlayTarget {
  /** Stable zone/room id (used as the receiver session key). */
  zoneId: string;
  /** Advertised AirPlay name, e.g. "Living Room". */
  name: string;
  /** Renderer udn the decoded PCM stream is pushed into. */
  rendererUdn: string;
  /** For a group: the member renderer udns (Raumfeld syncs these internally). */
  memberUdns: string[];
  /**
   * Set for a room that is in no zone. It has no zone renderer to play on yet,
   * so one is created at session start and `rendererUdn` is not used.
   */
  unassignedRoomUdn?: string;
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
  /**
   * Where to record the pids of running receivers. A Homebridge that dies
   * without a clean shutdown leaves its shairport-sync children running, still
   * holding their RTSP ports; the next start reads this file and stops them.
   */
  pidFile?: string;
  /**
   * Where to write the shairport-sync config every receiver is started with
   * (see {@link SHAIRPORT_CONFIG}). Unset: receivers read the system config.
   */
  configFile?: string;
}

/** Base RTSP port; each concurrent receiver gets base + index. */
const RTSP_PORT_BASE = 5000;
const RECEIVER_RESTART_DELAY_MS = 5000;
const RECEIVER_RESTART_MAX_DELAY_MS = 5 * 60_000;
/**
 * shairport-sync applies the sender's AirPlay volume to the PCM itself: at half
 * volume on an iPhone that is around -30 dB, and the Raumfeld zone volume then
 * attenuates again, so playback was measured near-inaudible. Deliver full scale
 * and leave volume to Raumfeld. There is no command-line flag for this.
 */
const SHAIRPORT_CONFIG = `// Written by homebridge-teufel-raumfeld on every start; edits are overwritten.
general = {
  ignore_volume_control = "yes";
};
`;
/** How long a leftover receiver gets to exit on SIGTERM before SIGKILL. */
const ORPHAN_EXIT_TIMEOUT_MS = 3000;

interface Session {
  target: AirPlayTarget;
  receiver: AirPlayReceiver;
  rtspPort: number;
  /** Renderer the current session was started on; Stop goes to the same one. */
  playingUdn?: string;
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
  /** Consecutive unexpected exits per zone; reset once a session streams audio. */
  private readonly restartFailures = new Map<string, number>();
  private stopped = false;
  private reaping?: Promise<void>;
  /** The config file receivers are started with, once it has been written. */
  private configFile?: string | null;

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
    // Once, before any receiver starts: leftovers would hold the ports.
    this.reaping ??= this.reapOrphans();
    await this.reaping;
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
      // A crashed receiver waits out its backoff; starting it here would turn
      // a receiver that exits immediately into a loop at the zone-update rate.
      if (this.restartTimers.has(target.zoneId)) continue;
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
        this.restartFailures.delete(target.zoneId);
        const session = this.sessions.get(target.zoneId);
        if (!session) return;
        this.streamServer.setSource(target.zoneId, pcm);
        const url = this.streamServer.urlFor(target.zoneId);
        this.playOnRenderer(session, url).catch((err) =>
          this.log.error(`AirPlay: failed to start playback on "${session.target.name}": ${(err as Error).message}`));
      },
      onSessionEnd: () => {
        const session = this.sessions.get(target.zoneId);
        this.streamServer.clearSource(target.zoneId);
        if (!session?.playingUdn) return;
        const udn = session.playingUdn;
        session.playingUdn = undefined;
        this.client.setPlayState(udn, 2) // 2 = STOP
          .catch((err) => this.log.debug(`AirPlay: stop on "${session.target.name}" failed: ${(err as Error).message}`));
      },
      onUnexpectedExit: () => this.receiverExited(target.zoneId, receiver),
    }, this.options.password, this.receiverConfigFile());

    this.cancelRestart(target.zoneId);
    this.streamServer.register(target.zoneId);
    this.sessions.set(target.zoneId, { target, receiver, rtspPort });
    receiver.start();
    this.writePidFile();
    this.log.info(`AirPlay: advertising "${target.name}".`);
  }

  private async playOnRenderer(session: Session, url: string): Promise<void> {
    const { target } = session;
    const udn = target.unassignedRoomUdn
      ? await this.client.zoneRendererForRoom(target.unassignedRoomUdn)
      : target.rendererUdn;
    this.log.debug(`AirPlay: routing "${target.name}" -> ${udn}.`);
    session.playingUdn = udn;
    await this.client.setAvTransportUri(udn, url, streamDidl(url, target.name));
    await this.client.setPlayState(udn, 0); // 0 = PLAY
  }

  private teardown(zoneId: string, session: Session): void {
    this.cancelRestart(zoneId);
    this.restartFailures.delete(zoneId);
    session.receiver.stop();
    this.streamServer.unregister(zoneId);
    this.usedPorts.delete(session.rtspPort);
    this.sessions.delete(zoneId);
    this.writePidFile();
  }

  private stopAll(): void {
    for (const zoneId of this.restartTimers.keys()) this.cancelRestart(zoneId);
    for (const [zoneId, session] of this.sessions) this.teardown(zoneId, session);
    this.sessions.clear();
    this.usedPorts.clear();
    this.writePidFile();
  }

  /** Write {@link SHAIRPORT_CONFIG} once; undefined if there is none to use. */
  private receiverConfigFile(): string | undefined {
    if (this.configFile === undefined) {
      this.configFile = null;
      if (this.options.configFile) {
        try {
          writeFileSync(this.options.configFile, SHAIRPORT_CONFIG);
          this.configFile = this.options.configFile;
        } catch (err) {
          this.log.warn(`AirPlay: could not write ${this.options.configFile} (${(err as Error).message}); `
            + 'receivers use the system shairport-sync config, so the AirPlay volume will also attenuate.');
        }
      }
    }
    return this.configFile ?? undefined;
  }

  /** Record the pids of the receivers running right now. */
  private writePidFile(): void {
    if (!this.options.pidFile) return;
    const pids = [...this.sessions.values()].map((s) => s.receiver.pid).filter((pid) => pid !== undefined);
    try {
      writeFileSync(this.options.pidFile, pids.join('\n'));
    } catch (err) {
      this.log.debug(`AirPlay: could not write ${this.options.pidFile}: ${(err as Error).message}`);
    }
  }

  /** Stop receivers a previous run left behind (see {@link AirPlayOptions.pidFile}). */
  private async reapOrphans(): Promise<void> {
    if (!this.options.pidFile) return;
    let recorded: number[];
    try {
      recorded = readFileSync(this.options.pidFile, 'utf8').split(/\s+/).map(Number);
    } catch {
      return; // first run, nothing recorded
    }
    const orphans = recorded.filter((pid) => Number.isInteger(pid) && pid > 1
      && AirPlayReceiver.isReceiverProcess(pid, this.options.binaryPath));
    if (!orphans.length) return;

    this.log.info(`AirPlay: stopping ${orphans.length} receiver(s) left running by a previous start.`);
    for (const pid of orphans) signal(pid, 'SIGTERM');
    const deadline = Date.now() + ORPHAN_EXIT_TIMEOUT_MS;
    while (orphans.some(isAlive) && Date.now() < deadline) await delay(100);
    for (const pid of orphans.filter(isAlive)) signal(pid, 'SIGKILL');
    this.writePidFile();
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
    this.writePidFile();

    if (this.stopped || !this.desiredTargets.has(zoneId)) return;
    // Double the delay on every consecutive crash, so a receiver that can never
    // start (bad build, port taken) settles to one attempt every few minutes.
    const failures = (this.restartFailures.get(zoneId) ?? 0) + 1;
    this.restartFailures.set(zoneId, failures);
    const delay = Math.min(RECEIVER_RESTART_DELAY_MS * 2 ** (failures - 1), RECEIVER_RESTART_MAX_DELAY_MS);
    this.log.warn(`AirPlay: receiver for "${session.target.name}" will restart in ${delay} ms.`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(zoneId);
      const target = this.desiredTargets.get(zoneId);
      if (!target || this.stopped || this.sessions.has(zoneId)) return;
      this.startSession(target);
    }, delay);
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // already gone
  }
}

/**
 * DIDL-Lite for the stream. With empty metadata a renderer has to guess the
 * format from the response; the protocolInfo here names it up front.
 */
function streamDidl(url: string, zoneName: string): string {
  return '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/"'
    + ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">'
    + '<item id="airplay" parentID="0" restricted="1">'
    + `<dc:title>${escapeXml(`AirPlay (${zoneName})`)}</dc:title>`
    + '<upnp:class>object.item.audioItem.musicTrack</upnp:class>'
    + `<res protocolInfo="http-get:*:${STREAM_MIME_TYPE}:*">${escapeXml(url)}</res>`
    + '</item></DIDL-Lite>';
}
