import type { Logging } from 'homebridge';
import type { RaumfeldClient } from './raumfeldClient.js';

export interface AirPlayTarget {
  /** Stable zone/room id (used as the receiver session key). */
  zoneId: string;
  /** Advertised AirPlay name, e.g. "Living Room". */
  name: string;
  /** Renderer udn the decoded PCM stream is pushed into. */
  rendererUdn: string;
  /** For a group: the member renderer udns to keep in sync. */
  memberUdns: string[];
}

export interface AirPlayOptions {
  enabled: boolean;
  bufferMs: number;
}

interface Session {
  target: AirPlayTarget;
  /** True once a receiver is actually advertising for this zone. */
  active: boolean;
}

/**
 * Advertises each Raumfeld zone (and group) as an AirPlay receiver and, on
 * selection in the iOS output picker, pushes the decoded PCM into that zone's
 * renderer via OpenHome SetChannel / a play-URL (see handoff README §AirPlay).
 *
 * The audio path itself is delegated to a shairport-sync / airtunes2 style
 * receiver — a native component, spawned per zone. This class owns the
 * *lifecycle* (which zones are advertised, session bookkeeping, teardown) and
 * exposes a single seam, {@link startReceiver}, where that receiver is wired
 * in. AirPlay 1 single-zone is a valid first milestone; group sync is layered
 * on by fanning the same stream to `memberUdns`.
 */
export class AirPlayBridge {
  private readonly sessions = new Map<string, Session>();
  /** Warn once, not per zone, that the native receiver isn't wired in this build. */
  private warnedUnavailable = false;

  constructor(
    private readonly log: Logging,
    private readonly client: RaumfeldClient,
    private readonly options: AirPlayOptions,
  ) {}

  /** Reconcile advertised receivers with the current set of zones. */
  syncTargets(targets: AirPlayTarget[]): void {
    if (!this.options.enabled) {
      this.stopAll();
      return;
    }

    const wanted = new Map(targets.map((t) => [t.zoneId, t]));

    // Drop receivers for zones that vanished.
    for (const [zoneId, session] of this.sessions) {
      if (!wanted.has(zoneId)) {
        this.stopReceiver(session);
        this.sessions.delete(zoneId);
      }
    }

    // Add receivers for new zones; refresh the target on existing ones.
    for (const target of targets) {
      const existing = this.sessions.get(target.zoneId);
      if (existing) {
        existing.target = target;
        continue;
      }
      const session: Session = { target, active: false };
      this.sessions.set(target.zoneId, session);
      this.startReceiver(session);
    }
  }

  stop(): void {
    this.stopAll();
  }

  private stopAll(): void {
    for (const session of this.sessions.values()) this.stopReceiver(session);
    this.sessions.clear();
  }

  /**
   * Bring up an AirPlay receiver for one zone. Integration seam: spawn
   * shairport-sync (or embed node_airtunes2) advertising `target.name`, decode
   * to PCM, and on stream start hand the URL/PCM to the renderer via
   * `client.setPlayState` / an OpenHome SetChannel call, fanning to
   * `target.memberUdns` for a synced group.
   */
  private startReceiver(session: Session): void {
    const { name, rendererUdn, memberUdns } = session.target;
    // The native receiver (shairport-sync / airtunes2) is not spawned in this
    // build. Do NOT flip `active`: an advertised-but-nonexistent receiver would
    // show up in the iOS picker and silently fail on selection. Report the
    // feature as unavailable (once) and leave the session inactive until the
    // process launch is wired into this seam.
    if (!this.warnedUnavailable) {
      this.warnedUnavailable = true;
      this.log.warn(
        'AirPlay: native receiver not built into this release; zones will NOT appear as '
        + 'AirPlay targets. Set airplay.enabled=false to silence this.',
      );
    }
    this.log.debug(
      `AirPlay: would advertise "${name}" -> renderer ${rendererUdn}`
      + (memberUdns.length ? ` (+${memberUdns.length} synced)` : '')
      + `, buffer ${this.options.bufferMs} ms (receiver not wired).`,
    );
    session.active = false;
    void this.client; // referenced here once the receiver hands PCM to the renderer.
  }

  private stopReceiver(session: Session): void {
    if (!session.active) return;
    this.log.info(`AirPlay: withdrawing "${session.target.name}".`);
    session.active = false;
  }
}
