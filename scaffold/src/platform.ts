import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { ZoneAccessory } from './zoneAccessory.js';
import { RaumfeldClient, type RaumfeldZone, type RaumfeldRoom } from './raumfeldClient.js';

export interface RaumfeldConfig extends PlatformConfig {
  autoDiscover?: boolean;
  host?: string;
  pollInterval?: number;
  airplay?: { enabled?: boolean; bufferMs?: number };
  multiroom?: { exposeGroups?: boolean; syncGroupVolume?: boolean };
  devices?: Array<{ udn: string; name: string; model: string; exposed: boolean }>;
}

/**
 * Dynamic platform. Discovers the Raumfeld host, mirrors its rooms/zones as
 * HomeKit accessories, and keeps them in sync.
 *
 * KEY BEHAVIOUR (see handoff README, "Multiroom"):
 *  - Zone groups are authored in the Raumfeld app, NOT here. We read them from
 *    the host and mirror them live.
 *  - An active group is exposed as ONE controllable accessory (the lead renderer).
 *  - Each member room's accessory is marked in-use / not independently controllable
 *    while its room is bound into an active group. Writes on a member are routed to
 *    the group (or no-op'd) and Home shows it as the greyed "in use" tile.
 */
export class RaumfeldPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Restored + newly-created accessories, keyed by UUID. */
  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, ZoneAccessory>();

  public client!: RaumfeldClient;
  private pollTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logging,
    public readonly config: RaumfeldConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', () => {
      this.bootstrap().catch((err) => this.log.error('Bootstrap failed:', err));
    });
    this.api.on('shutdown', () => {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.client?.dispose();
    });
  }

  /** Homebridge calls this for every accessory restored from disk cache. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Restoring accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private async bootstrap(): Promise<void> {
    const host = this.config.autoDiscover !== false
      ? await RaumfeldClient.discover(this.log)
      : this.config.host;

    if (!host) {
      this.log.error('No Raumfeld host found. Enable auto-discover or set "host" in config.');
      return;
    }

    this.client = new RaumfeldClient(host, this.log);
    await this.client.connect();

    // Initial sync, then poll (or subscribe to GENA events) for changes.
    await this.sync();
    const seconds = this.config.pollInterval ?? 2;
    this.pollTimer = setInterval(() => {
      this.sync().catch((err) => this.log.debug('Sync error:', err));
    }, seconds * 1000);
  }

  /**
   * Reconcile HomeKit accessories with the current rooms + zones on the host.
   * TODO: implement the diff:
   *   1. Fetch rooms and zones from the host.
   *   2. For each exposed room -> ensure a room accessory exists.
   *   3. For each active zone (group) -> ensure a group accessory exists (if exposeGroups).
   *   4. Mark member rooms as in-use/locked; route their writes to the group lead.
   *   5. Remove accessories for rooms/zones that no longer exist (unregister + drop cache).
   */
  private async sync(): Promise<void> {
    const rooms: RaumfeldRoom[] = await this.client.getRooms();
    const zones: RaumfeldZone[] = await this.client.getZones();

    const grouped = new Set<string>();
    for (const zone of zones) {
      if (zone.rooms.length > 1) zone.rooms.forEach((r) => grouped.add(r.udn));
    }

    for (const room of rooms) {
      if (this.isExposed(room) === false) continue;
      const accessory = this.ensureAccessory(room.udn, room.name, room.model);
      const handler = this.handlers.get(accessory.UUID)
        ?? new ZoneAccessory(this, accessory);
      this.handlers.set(accessory.UUID, handler);
      handler.update({ room, lockedInGroup: grouped.has(room.udn) });
    }

    if (this.config.multiroom?.exposeGroups !== false) {
      for (const zone of zones.filter((z) => z.rooms.length > 1)) {
        const accessory = this.ensureAccessory(zone.udn, zone.name, 'Group');
        const handler = this.handlers.get(accessory.UUID)
          ?? new ZoneAccessory(this, accessory);
        this.handlers.set(accessory.UUID, handler);
        handler.update({ zone, lockedInGroup: false });
      }
    }

    // TODO: prune accessories not seen in this sync pass.
  }

  private isExposed(room: RaumfeldRoom): boolean {
    const entry = this.config.devices?.find((d) => d.udn === room.udn);
    return entry ? entry.exposed !== false : true;
  }

  /** Create-or-restore a cached accessory for the given stable id. */
  private ensureAccessory(id: string, name: string, model: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}`);
    const existing = this.accessories.get(uuid);
    if (existing) return existing;

    this.log.info('Adding accessory:', name);
    const accessory = new this.api.platformAccessory(name, uuid);
    accessory.context.id = id;
    accessory.context.model = model;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(uuid, accessory);
    return accessory;
  }
}
