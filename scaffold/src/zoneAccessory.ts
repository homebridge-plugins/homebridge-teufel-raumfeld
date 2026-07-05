import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { RaumfeldPlatform } from './platform.js';
import type { RaumfeldRoom, RaumfeldZone } from './raumfeldClient.js';

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
 * Wraps a single HomeKit accessory (a room OR a group). Exposes a SmartSpeaker
 * with volume + mute + a current-media state.
 *
 * Locking rule: when `lockedInGroup` is true this member room is not
 * independently controllable — StatusFault flags it (Home renders it greyed,
 * "In <group> · in use") and any write is routed to the group lead renderer
 * rather than dropped, so the control still does something sensible.
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

    this.speaker = this.accessory.getService(Service.SmartSpeaker)
      ?? this.accessory.addService(Service.SmartSpeaker, accessory.displayName);

    // Play / pause via TargetMediaState.
    this.speaker.getCharacteristic(Characteristic.TargetMediaState)
      .onSet(async (value) => {
        await this.platform.client.setPlayState(this.writeTarget(), Number(value));
      });

    // Volume (0-100) + Mute.
    this.speaker.getCharacteristic(Characteristic.Volume)
      .onSet(async (value) => {
        await this.platform.client.setVolume(this.writeTarget(), Number(value), this.syncTargets());
      });

    this.speaker.getCharacteristic(Characteristic.Mute)
      .onSet(async (value) => {
        await this.platform.client.setMute(this.writeTarget(), Boolean(value), this.syncTargets());
      });
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

    this.setChar(Characteristic.Volume, src.volume ?? 0);
    this.setChar(Characteristic.Mute, src.mute ?? false);
    this.setChar(
      Characteristic.CurrentMediaState,
      src.playing ? Characteristic.CurrentMediaState.PLAY : Characteristic.CurrentMediaState.PAUSE,
    );

    // Reflect the "in use" lock so Home greys the member tile. Writes are still
    // accepted and routed to the group lead (see writeTarget()).
    this.setChar(
      Characteristic.StatusFault,
      this.locked ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
    );
    this.setChar(Characteristic.ConfiguredName, src.name);
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
