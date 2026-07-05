import type { PlatformAccessory, Service } from 'homebridge';
import type { RaumfeldPlatform } from './platform.js';
import type { RaumfeldRoom, RaumfeldZone } from './raumfeldClient.js';

interface UpdateState {
  room?: RaumfeldRoom;
  zone?: RaumfeldZone;
  /** True when this room is bound into an active Raumfeld group -> locked in HomeKit. */
  lockedInGroup: boolean;
}

/**
 * Wraps a single HomeKit accessory (a room OR a group). Exposes a SmartSpeaker
 * with volume + mute + a current-media name.
 *
 * Locking rule: when `lockedInGroup` is true, this member room's controls become
 * non-responsive (Home renders it greyed, "In <group> · in use"). Writes are
 * either routed to the group lead renderer or rejected, per config.
 */
export class ZoneAccessory {
  private readonly speaker: Service;
  private locked = false;
  private currentId = '';

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
        if (this.rejectIfLocked()) return;
        await this.platform.client.setPlayState(this.currentId, Number(value));
      });

    // Volume (0-100). Some Home clients surface this only via the accessory's
    // media controls; expose Volume + Mute characteristics on the service.
    this.speaker.getCharacteristic(Characteristic.Volume)
      .onSet(async (value) => {
        if (this.rejectIfLocked()) return;
        await this.platform.client.setVolume(this.currentId, Number(value));
      });

    this.speaker.getCharacteristic(Characteristic.Mute)
      .onSet(async (value) => {
        if (this.rejectIfLocked()) return;
        await this.platform.client.setMute(this.currentId, Boolean(value));
      });
  }

  /** Called by the platform on every sync pass. */
  update(state: UpdateState): void {
    const { Characteristic } = this.platform;
    const src = state.zone ?? state.room;
    if (!src) return;

    this.locked = state.lockedInGroup;
    this.currentId = state.zone ? state.zone.udn : (state.room?.udn ?? '');

    this.speaker.updateCharacteristic(Characteristic.Volume, src.volume ?? 0);
    this.speaker.updateCharacteristic(Characteristic.Mute, src.mute ?? false);
    this.speaker.updateCharacteristic(
      Characteristic.CurrentMediaState,
      src.playing ? Characteristic.CurrentMediaState.PLAY : Characteristic.CurrentMediaState.PAUSE,
    );

    // Reflect the "in use" lock. StatusFault is a lightweight signal that this
    // member is not independently controllable right now; alternatively route
    // writes to the group lead. Adjust to taste / HomeKit behaviour.
    this.speaker.updateCharacteristic(
      Characteristic.StatusFault,
      this.locked ? Characteristic.StatusFault.GENERAL_FAULT : Characteristic.StatusFault.NO_FAULT,
    );
    this.speaker.updateCharacteristic(Characteristic.Name, src.name);
  }

  /** Returns true (and logs) when the accessory is locked into a group. */
  private rejectIfLocked(): boolean {
    if (this.locked) {
      this.platform.log.info(
        `${this.accessory.displayName} is in an active Raumfeld group; control it via the group.`,
      );
      // Option: forward to group lead instead of returning. See README.
      return true;
    }
    return false;
  }
}
