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
import { AirPlayBridge, type AirPlayTarget } from './airplayBridge.js';
import { RaumfeldClient, type RaumfeldState, type RaumfeldRoom } from './raumfeldClient.js';

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
 *    the group lead and Home shows it as the greyed "in use" tile.
 */
export class RaumfeldPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Restored + newly-created accessories, keyed by UUID. */
  public readonly accessories = new Map<string, PlatformAccessory>();
  private readonly handlers = new Map<string, ZoneAccessory>();

  public client!: RaumfeldClient;
  private airplay?: AirPlayBridge;
  private pollTimer?: NodeJS.Timeout;
  private running = false;

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
      this.running = false;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.airplay?.stop();
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

    this.airplay = new AirPlayBridge(this.log, this.client, {
      enabled: this.config.airplay?.enabled !== false,
      bufferMs: this.config.airplay?.bufferMs ?? 220,
    });

    this.running = true;

    // Initial sync, then react to group changes. We prefer the host's long-poll
    // (`updateId`) so groups made in the Raumfeld app show up instantly, and keep
    // a slow interval as a safety net for missed events / volume drift.
    await this.safeSync();
    void this.longPollLoop();

    // Safety-net poll (the long-poll above does the real-time work). Kept
    // infrequent so we don't hammer the host; honours a larger pollInterval.
    const safetyNetSeconds = Math.max(30, this.config.pollInterval ?? 2);
    this.pollTimer = setInterval(() => void this.safeSync(), safetyNetSeconds * 1000);
  }

  /** Block on the host until a zone change lands, then resync — forever. */
  private async longPollLoop(): Promise<void> {
    while (this.running) {
      await this.client.waitForChange();
      if (!this.running) break;
      await this.safeSync();
    }
  }

  private async safeSync(): Promise<void> {
    try {
      await this.sync();
    } catch (err) {
      this.log.debug('Sync skipped:', (err as Error).message);
    }
  }

  /**
   * Reconcile HomeKit accessories with the current rooms + zones on the host.
   *  1. Fetch rooms and zones (single round trip).
   *  2. Ensure a room accessory for every exposed room; mark members that are
   *     bound into a group as locked, and route their writes to the group lead.
   *  3. Ensure a group accessory per active zone (if exposeGroups).
   *  4. Prune accessories for rooms/zones that no longer exist or were hidden.
   *  5. Refresh AirPlay receivers.
   */
  private async sync(): Promise<void> {
    const state: RaumfeldState = await this.client.getState();
    const seen = new Set<string>();
    const syncGroupVolume = this.config.multiroom?.syncGroupVolume !== false;

    // room udn -> the group lead renderer it should be controlled through.
    const groupLeadByRoom = new Map<string, string>();
    for (const zone of state.zones) {
      if (zone.rooms.length > 1) {
        for (const room of zone.rooms) groupLeadByRoom.set(room.udn, zone.leadRendererUdn);
      }
    }

    // 2. Rooms.
    for (const room of state.rooms) {
      if (!this.isExposed(room)) continue;
      const accessory = this.ensureAccessory(room.udn, room.name, room.model);
      seen.add(accessory.UUID);
      const lockedInGroup = groupLeadByRoom.has(room.udn);
      this.handlerFor(accessory).update({
        room,
        lockedInGroup,
        controlUdn: room.rendererUdn,
        groupLeadUdn: groupLeadByRoom.get(room.udn),
        syncGroupVolume,
      });
    }

    // 3. Group accessories.
    const airplayTargets: AirPlayTarget[] = [];
    if (this.config.multiroom?.exposeGroups !== false) {
      for (const zone of state.zones.filter((z) => z.rooms.length > 1)) {
        const accessory = this.ensureAccessory(zone.udn, zone.name, 'Group');
        seen.add(accessory.UUID);
        const memberUdns = zone.rooms
          .map((r) => r.rendererUdn)
          .filter((udn) => udn !== zone.leadRendererUdn);
        this.handlerFor(accessory).update({
          zone,
          lockedInGroup: false,
          controlUdn: zone.leadRendererUdn,
          memberUdns,
          syncGroupVolume,
        });
        airplayTargets.push({ zoneId: zone.udn, name: zone.name, rendererUdn: zone.leadRendererUdn, memberUdns });
      }
    }

    // Ungrouped, exposed rooms are AirPlay targets too.
    for (const room of state.rooms) {
      if (!this.isExposed(room) || groupLeadByRoom.has(room.udn)) continue;
      airplayTargets.push({ zoneId: room.udn, name: room.name, rendererUdn: room.rendererUdn, memberUdns: [] });
    }

    // 4. Prune.
    this.prune(seen);

    // 5. AirPlay.
    this.airplay?.syncTargets(airplayTargets);
  }

  /** Remove accessories not present in this sync pass (ungrouped/hidden/gone). */
  private prune(seen: Set<string>): void {
    for (const [uuid, accessory] of this.accessories) {
      if (seen.has(uuid)) continue;
      this.log.info('Removing accessory:', accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.handlers.delete(uuid);
    }
  }

  private handlerFor(accessory: PlatformAccessory): ZoneAccessory {
    let handler = this.handlers.get(accessory.UUID);
    if (!handler) {
      handler = new ZoneAccessory(this, accessory);
      this.handlers.set(accessory.UUID, handler);
    }
    return handler;
  }

  private isExposed(room: RaumfeldRoom): boolean {
    const entry = this.config.devices?.find((d) => d.udn === room.udn);
    return entry ? entry.exposed !== false : true;
  }

  /** Create-or-restore a cached accessory for the given stable id. */
  private ensureAccessory(id: string, name: string, model: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${id}`);
    const existing = this.accessories.get(uuid);
    if (existing) {
      existing.context.model = model;
      return existing;
    }

    this.log.info('Adding accessory:', name);
    const accessory = new this.api.platformAccessory(name, uuid);
    accessory.context.id = id;
    accessory.context.model = model;
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.set(uuid, accessory);
    return accessory;
  }
}
