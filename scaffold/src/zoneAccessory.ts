import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { RaumfeldPlatform } from './platform.js';
import type { RaumfeldRoom, RaumfeldZone } from './raumfeldClient.js';
import { SoapFault } from './raumfeldClient.js';

/**
 * Delay before snapping the On tile back after a Play that had nothing to play.
 * Long enough for HAP to apply the requested value first, short enough that the
 * tile reads as "refused to stick" rather than "turned itself off".
 */
const NOTHING_QUEUED_REVERT_MS = 250;

export interface UpdateState {
  room?: RaumfeldRoom;
  zone?: RaumfeldZone;
  /** True when this room is bound into an active Raumfeld group -> locked in HomeKit. */
  lockedInGroup: boolean;
  /** Renderer udn this accessory writes to directly (its own, or the group lead). */
  controlUdn: string;
  /** Other renderer udns kept in sync for a group (volume/mute), when syncGroupVolume. */
  memberUdns?: string[];
  /** For a locked member: the group lead renderer that writes are routed to. */
  groupLeadUdn?: string;
  syncGroupVolume?: boolean;
}

/**
 * Wraps a single HomeKit accessory (a room OR a group). Modeled as a Fan so the
 * Apple Home app renders a working tile: On = play/pause, RotationSpeed = volume
 * (0-100). Home does NOT render a third-party SmartSpeaker (shows "Not Supported"),
 * so Fan is the closest service with an on/off toggle + a 0-100 slider that Home
 * actually controls. Semantics are cosmetic only — no real fan involved.
 *
 * Locking rule: when `lockedInGroup` is true this member room is not
 * independently controllable, so any write is routed to the group lead renderer
 * (see writeTarget()) rather than moving the member alone — the group is the
 * real controllable unit while it exists.
 */
export class ZoneAccessory {
  private readonly speaker: Service;
  private locked = false;
  private controlUdn = '';
  private memberUdns: string[] = [];
  private groupLeadUdn?: string;
  private syncGroupVolume = true;

  constructor(
    private readonly platform: RaumfeldPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = this.platform;

    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Teufel Raumfeld')
      .setCharacteristic(Characteristic.Model, accessory.context.model ?? 'Speaker')
      .setCharacteristic(Characteristic.SerialNumber, accessory.context.id ?? 'unknown');

    // Migrate accessories cached from an earlier SmartSpeaker build: strip the
    // stale service so Home doesn't show the "Not Supported" tile alongside the Fan.
    const stale = this.accessory.getService(Service.SmartSpeaker);
    if (stale) this.accessory.removeService(stale);

    this.speaker = this.accessory.getService(Service.Fan)
      ?? this.accessory.addService(Service.Fan, accessory.displayName);

    // On = play / pause. TargetMediaState enum: 0 PLAY, 1 PAUSE.
    this.speaker.getCharacteristic(Characteristic.On)
      .onSet(this.wrapWrite('play/pause', async (value) => {
        try {
          await this.platform.client.setPlayState(this.writeTarget(), value ? 0 : 1);
        } catch (err) {
          if (err instanceof SoapFault && err.isTransitionUnavailable) {
            this.revertNothingQueued();
            return;
          }
          throw err;
        }
      }));

    // RotationSpeed (0-100) = volume.
    this.speaker.getCharacteristic(Characteristic.RotationSpeed)
      .onSet(this.wrapWrite('volume', (value) =>
        this.platform.client.setVolume(this.writeTarget(), Number(value), this.syncTargets())));
  }

  /**
   * Wrap a write so a failed SOAP call surfaces as a clean HAP status (Home
   * reverts the control) instead of an unhandled rejection that Homebridge logs
   * as "Unhandled error thrown inside write handler".
   */
  private wrapWrite(label: string, fn: (value: CharacteristicValue) => Promise<void>) {
    return async (value: CharacteristicValue): Promise<void> => {
      try {
        await fn(value);
      } catch (err) {
        const { HapStatusError, HAPStatus } = this.platform.api.hap;
        this.platform.log.warn(
          `${this.accessory.displayName}: ${label} write failed — ${err instanceof Error ? err.message : String(err)}`,
        );
        throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      }
    };
  }

  /**
   * Play faulted because the zone has nothing queued. The Home app can't render
   * a custom message — a rejected write only carries a numeric HAP status, and
   * Home picks its own wording — so rather than surface this as an error we let
   * the write succeed and snap the tile back to off: it visibly refuses to
   * stick, and the reason goes to the log where it can actually be read.
   *
   * The revert is deferred because HAP assigns the requested value *after* this
   * handler resolves; updating in-line would just be overwritten.
   */
  private revertNothingQueued(): void {
    this.platform.log.info(
      `${this.accessory.displayName}: nothing is queued — start audio from AirPlay or the Raumfeld app first.`,
    );
    setTimeout(
      () => this.speaker.updateCharacteristic(this.platform.Characteristic.On, false),
      NOTHING_QUEUED_REVERT_MS,
    );
  }

  /** Called by the platform on every sync pass. */
  update(state: UpdateState): void {
    const { Characteristic } = this.platform;
    const src: RaumfeldZone | RaumfeldRoom | undefined = state.zone ?? state.room;
    if (!src) return;

    this.locked = state.lockedInGroup;
    this.controlUdn = state.controlUdn;
    this.memberUdns = state.memberUdns ?? [];
    this.groupLeadUdn = state.groupLeadUdn;
    this.syncGroupVolume = state.syncGroupVolume ?? true;

    // Only push characteristics the host actually reported. A failed/skipped
    // enrich leaves volume/playing undefined; writing 0/false here would clobber
    // the last-known HomeKit state with bogus values. Mute is folded into On:
    // a muted or paused zone reads as the Fan being off.
    if (src.volume !== undefined) this.setChar(Characteristic.RotationSpeed, src.volume);
    if (src.playing !== undefined || src.mute !== undefined) {
      const on = src.playing !== false && src.mute !== true;
      this.setChar(Characteristic.On, on);
    }
    if (src.name) this.setChar(Characteristic.ConfiguredName, src.name);

    // The "in use" lock is enforced by routing member writes to the group lead
    // (see writeTarget()). Home already shows grouped members as controlled
    // together via the group accessory, so no extra fault characteristic is set.
  }

  /** Where a write for this accessory should land right now. */
  private writeTarget(): string {
    if (this.locked && this.groupLeadUdn) {
      this.platform.log.debug(
        `${this.accessory.displayName} is in an active group; routing control to the group lead.`,
      );
      return this.groupLeadUdn;
    }
    return this.controlUdn;
  }

  /** Extra renderers to keep in lock-step for a group (empty for a single room). */
  private syncTargets(): string[] {
    if (this.locked) return [];
    return this.syncGroupVolume ? this.memberUdns : [];
  }

  private setChar(characteristic: Parameters<Service['updateCharacteristic']>[0], value: CharacteristicValue): void {
    this.speaker.updateCharacteristic(characteristic, value);
  }
}
