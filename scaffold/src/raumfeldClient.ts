import type { Logging } from 'homebridge';
import { setTimeout as delay } from 'node:timers/promises';
import { XMLParser } from 'fast-xml-parser';
import ssdp from 'node-ssdp';
import { RAUMFELD_HTTP_PORT } from './settings.js';

const { Client: SsdpClient } = ssdp;

export interface RaumfeldRoom {
  udn: string;          // room udn — stable identity for the HomeKit accessory + config matching
  rendererUdn: string;  // renderer udn used for UPnP/OpenHome control
  name: string;
  model: string;        // "Stereo L", "One", "Soundbar", ...
  volume?: number;      // 0-100
  mute?: boolean;
  playing?: boolean;
}

export interface RaumfeldZone {
  udn: string;             // zone / group id
  name: string;            // derived, e.g. "Living Room + Kitchen"
  leadRoomUdn: string;
  leadRendererUdn: string; // renderer we send transport/volume writes to
  rooms: RaumfeldRoom[];
  volume?: number;
  mute?: boolean;
  playing?: boolean;
}

/** Combined snapshot of the host: every room plus the active zones (groups). */
export interface RaumfeldState {
  rooms: RaumfeldRoom[];
  zones: RaumfeldZone[];
  updateId?: string;
}

/** Resolved UPnP control endpoints for a renderer, cached after description fetch. */
interface ResolvedRenderer {
  location: string;
  baseUrl: string;
  renderingControlUrl?: string;
  avTransportUrl?: string;
  modelName?: string;
}

const SOAP_SERVICE = {
  rendering: 'urn:schemas-upnp-org:service:RenderingControl:1',
  avTransport: 'urn:schemas-upnp-org:service:AVTransport:1',
} as const;

/**
 * Thin client for the Raumfeld host.
 *
 * Two surfaces are used:
 *  1. The host HTTP API on port 47365:  GET /getZones (with a long-poll
 *     ?updateId=.. for change notifications), GET /listDevices (every device's
 *     description URL), GET /connectRoomToZone, GET /dropRoom.
 *  2. UPnP / OpenHome services per renderer (RenderingControl SetVolume/SetMute,
 *     AVTransport Play/Pause/Stop) reached via SOAP. Control URLs are resolved
 *     lazily from each renderer's device description, whose location comes from
 *     /listDevices — HTTP, so it works even when Homebridge and the speakers sit
 *     on different subnets (SSDP multicast would not cross that boundary). SSDP
 *     is used only to auto-discover the host IP.
 */
export class RaumfeldClient {
  private readonly parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  /** udn -> device-description LOCATION, learned from the host's /listDevices. */
  private readonly locations = new Map<string, string>();
  /** udn -> resolved control URLs (memoised). */
  private readonly renderers = new Map<string, ResolvedRenderer>();
  private locationTimer?: NodeJS.Timeout;
  private lastUpdateId?: string;
  private disposed = false;

  constructor(
    private readonly host: string,
    private readonly log: Logging,
  ) {}

  /** SSDP-discover the Raumfeld host IP. Returns undefined if none found. */
  static async discover(log: Logging): Promise<string | undefined> {
    log.debug('SSDP search for the Raumfeld host…');
    const client = new SsdpClient();
    const candidates = new Set<string>();

    client.on('response', (_headers: Record<string, string>, _code: number, rinfo: { address: string }) => {
      if (rinfo?.address) candidates.add(rinfo.address);
    });

    try {
      // Raumfeld hosts advertise a MediaServer; ssdp:all is the widest net.
      client.search('urn:schemas-upnp-org:device:MediaServer:1');
      client.search('ssdp:all');
      await delay(3000);

      for (const address of candidates) {
        if (await RaumfeldClient.probe(address)) {
          log.info(`Discovered Raumfeld host at ${address}`);
          return address;
        }
      }
      log.debug(`SSDP saw ${candidates.size} device(s) but none served /getZones on :${RAUMFELD_HTTP_PORT}.`);
      return undefined;
    } finally {
      client.stop();
    }
  }

  /** True if `address` answers the Raumfeld zone API. */
  private static async probe(address: string): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`http://${address}:${RAUMFELD_HTTP_PORT}/getZones`, {}, 2000);
      return res.ok;
    } catch {
      return false;
    }
  }

  get baseUrl(): string {
    return `http://${this.host}:${RAUMFELD_HTTP_PORT}`;
  }

  async connect(): Promise<void> {
    this.log.info(`Connecting to Raumfeld host at ${this.baseUrl}`);
    const res = await fetchWithTimeout(`${this.baseUrl}/getZones`, {}, 4000);
    if (!res.ok) throw new Error(`Host returned HTTP ${res.status} for /getZones`);
    // Learn every device's description URL from the host over HTTP. Unlike SSDP
    // this works across subnets (Homebridge and the speakers on different VLANs),
    // and includes the per-zone virtual renderers used for group control.
    await this.refreshDeviceLocations();
    this.locationTimer = setInterval(() => {
      this.refreshDeviceLocations().catch(() => undefined);
    }, 60000);
    this.locationTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    if (this.locationTimer) clearInterval(this.locationTimer);
    this.locationTimer = undefined;
  }

  /**
   * Long-poll the host for zone changes. Resolves as soon as the `updateId`
   * advances (a group was made/dissolved in the Raumfeld app), or after the
   * server's poll window elapses. Callers loop on this to react instantly
   * without hammering the host with fixed polling.
   */
  async waitForChange(timeoutMs = 30000): Promise<void> {
    const url = this.lastUpdateId
      ? `${this.baseUrl}/getZones?updateId=${encodeURIComponent(this.lastUpdateId)}`
      : `${this.baseUrl}/getZones`;
    try {
      const res = await fetchWithTimeout(url, {}, timeoutMs);
      this.captureUpdateId(res);
    } catch {
      // Timeout / transient network error — caller will retry.
    }
  }

  /** All known rooms (assigned + unassigned). */
  async getRooms(): Promise<RaumfeldRoom[]> {
    return (await this.getState()).rooms;
  }

  /** Active zones. A zone with >1 room is a multiroom group. */
  async getZones(): Promise<RaumfeldZone[]> {
    return (await this.getState()).zones;
  }

  /** Single round-trip snapshot of rooms + zones. */
  async getState(): Promise<RaumfeldState> {
    const res = await fetchWithTimeout(`${this.baseUrl}/getZones`, {}, 6000);
    if (!res.ok) throw new Error(`/getZones -> HTTP ${res.status}`);
    this.captureUpdateId(res);
    const state = this.parseZoneConfig(await res.text());
    await this.enrich(state);
    return state;
  }

  // --- Transport / volume control -----------------------------------------

  /**
   * Play / pause / stop via AVTransport. `targetMediaState` follows HomeKit's
   * TargetMediaState enum (0 PLAY, 1 PAUSE, 2 STOP).
   */
  async setPlayState(rendererUdn: string, targetMediaState: number): Promise<void> {
    const action = targetMediaState === 0 ? 'Play' : targetMediaState === 1 ? 'Pause' : 'Stop';
    const args: Record<string, string | number> = { InstanceID: 0 };
    if (action === 'Play') args.Speed = '1';
    await this.soap(rendererUdn, 'avTransport', action, args);
  }

  /**
   * Set volume (0-100). For a group pass the member renderer udns in `alsoUdns`
   * so each speaker tracks the group volume (config: syncGroupVolume).
   */
  async setVolume(rendererUdn: string, volume: number, alsoUdns: string[] = []): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    for (const udn of [rendererUdn, ...alsoUdns]) {
      await this.soap(udn, 'rendering', 'SetVolume', {
        InstanceID: 0,
        Channel: 'Master',
        DesiredVolume: clamped,
      });
    }
  }

  async setMute(rendererUdn: string, mute: boolean, alsoUdns: string[] = []): Promise<void> {
    for (const udn of [rendererUdn, ...alsoUdns]) {
      await this.soap(udn, 'rendering', 'SetMute', {
        InstanceID: 0,
        Channel: 'Master',
        DesiredMute: mute ? 1 : 0,
      });
    }
  }

  // --- Group management (authored in the Raumfeld app; mutated rarely here) ---

  async connectRoomToZone(roomUdn: string, zoneUdn: string): Promise<void> {
    const url = `${this.baseUrl}/connectRoomToZone?roomUDN=${encodeURIComponent(roomUdn)}`
      + `&zoneUDN=${encodeURIComponent(zoneUdn)}`;
    const res = await fetchWithTimeout(url, {}, 5000);
    if (!res.ok) throw new Error(`connectRoomToZone -> HTTP ${res.status}`);
  }

  async dropRoom(roomUdn: string): Promise<void> {
    const url = `${this.baseUrl}/dropRoom?roomUDN=${encodeURIComponent(roomUdn)}`;
    const res = await fetchWithTimeout(url, {}, 5000);
    if (!res.ok) throw new Error(`dropRoom -> HTTP ${res.status}`);
  }

  // --- internals -----------------------------------------------------------

  private captureUpdateId(res: Response): void {
    // The host reports the current zone-config version as a header.
    const id = res.headers.get('updateid') ?? res.headers.get('updateId') ?? undefined;
    if (id) this.lastUpdateId = id;
  }

  /**
   * Parse the /getZones XML into rooms + zones. Shape (attributes vary by
   * firmware, structure is stable):
   *   <zoneConfig>
   *     <zones>
   *       <zone udn="…"><room udn="…" name="…"><renderer udn="…"/></room>…</zone>
   *     </zones>
   *     <unassignedRooms><room …>…</room></unassignedRooms>
   *   </zoneConfig>
   */
  private parseZoneConfig(xml: string): RaumfeldState {
    const doc = this.parser.parse(xml);
    const cfg = doc.zoneConfig ?? {};
    const rooms: RaumfeldRoom[] = [];
    const zones: RaumfeldZone[] = [];

    for (const zoneNode of asArray(cfg.zones?.zone)) {
      const zoneRooms = asArray(zoneNode.room).map((r) => this.toRoom(r));
      rooms.push(...zoneRooms);
      if (zoneRooms.length === 0) continue;
      const lead = zoneRooms[0];
      // A zone's udn is itself a MediaRenderer (the group's virtual renderer):
      // controlling it drives all member speakers in sync. Fall back to the
      // lead room's renderer if the host doesn't expose a zone renderer.
      const zoneUdn = attr(zoneNode, 'udn') ?? lead.udn;
      zones.push({
        udn: zoneUdn,
        name: zoneRooms.map((r) => r.name).join(' + '),
        leadRoomUdn: lead.udn,
        leadRendererUdn: zoneUdn,
        rooms: zoneRooms,
      });
    }

    for (const roomNode of asArray(cfg.unassignedRooms?.room)) {
      rooms.push(this.toRoom(roomNode));
    }

    return { rooms, zones, updateId: this.lastUpdateId };
  }

  private toRoom(node: Record<string, unknown>): RaumfeldRoom {
    const rendererNode = asArray((node as { renderer?: unknown }).renderer)[0] as
      | Record<string, unknown>
      | undefined;
    const udn = attr(node, 'udn') ?? '';
    const rendererUdn = (rendererNode && attr(rendererNode, 'udn')) || udn;
    return {
      udn,
      rendererUdn,
      name: attr(node, 'name') ?? 'Speaker',
      // Model isn't in /getZones; filled in by enrich() from the device description.
      model: this.renderers.get(rendererUdn)?.modelName ?? 'Speaker',
    };
  }

  /** Best-effort volume/mute/model/play-state fill via SOAP. Never throws. */
  private async enrich(state: RaumfeldState): Promise<void> {
    const targets = new Map<string, RaumfeldRoom>();
    for (const room of state.rooms) targets.set(room.rendererUdn, room);

    await Promise.all(
      [...targets.values()].map(async (room) => {
        try {
          const resolved = await this.resolveRenderer(room.rendererUdn);
          if (resolved?.modelName) room.model = resolved.modelName;
          const vol = await this.queryVolume(room.rendererUdn);
          if (vol) {
            room.volume = vol.volume;
            room.mute = vol.mute;
          }
        } catch (err) {
          this.log.debug(`enrich(${room.name}) skipped: ${(err as Error).message}`);
        }
      }),
    );

    // Zones inherit their lead room's state.
    for (const zone of state.zones) {
      const lead = zone.rooms.find((r) => r.rendererUdn === zone.leadRendererUdn) ?? zone.rooms[0];
      zone.volume = lead?.volume;
      zone.mute = lead?.mute;
      zone.playing = lead?.playing;
    }
  }

  private async queryVolume(rendererUdn: string): Promise<{ volume: number; mute: boolean } | undefined> {
    const volXml = await this.soap(rendererUdn, 'rendering', 'GetVolume', { InstanceID: 0, Channel: 'Master' });
    if (!volXml) return undefined;
    const muteXml = await this.soap(rendererUdn, 'rendering', 'GetMute', { InstanceID: 0, Channel: 'Master' });
    const volume = Number(extractTag(volXml, 'CurrentVolume') ?? '0');
    const mute = (extractTag(muteXml ?? '', 'CurrentMute') ?? '0') === '1';
    return { volume, mute };
  }

  /**
   * Refresh the udn -> description-URL map from the host's /listDevices. This
   * enumerates every speaker, connector and per-zone virtual renderer with an
   * HTTP location that is reachable across subnets (no SSDP multicast needed).
   */
  private async refreshDeviceLocations(): Promise<void> {
    if (this.disposed) return;
    const res = await fetchWithTimeout(`${this.baseUrl}/listDevices`, {}, 5000);
    if (!res.ok) return;
    const doc = this.parser.parse(await res.text());
    for (const dev of asArray(doc.devices?.device)) {
      const udn = attr(dev, 'udn');
      const location = attr(dev, 'location');
      if (udn && location) this.locations.set(udn, location);
    }
  }

  /** Resolve (and cache) a renderer's control URLs from its device description. */
  private async resolveRenderer(rendererUdn: string): Promise<ResolvedRenderer | undefined> {
    const cached = this.renderers.get(rendererUdn);
    if (cached) return cached;

    // A newly-appeared renderer may not be in the map yet — refresh once.
    if (!this.locations.has(rendererUdn)) await this.refreshDeviceLocations();
    const location = this.locations.get(rendererUdn);
    if (!location) return undefined;

    const res = await fetchWithTimeout(location, {}, 4000);
    if (!res.ok) return undefined;
    const doc = this.parser.parse(await res.text());
    const device = doc.root?.device ?? doc.device;
    const base = new URL(location);
    const baseUrl = `${base.protocol}//${base.host}`;

    const resolved: ResolvedRenderer = {
      location,
      baseUrl,
      modelName: firstDefined(device?.modelName, device?.modelNumber) as string | undefined,
    };
    for (const svc of collectServices(device)) {
      const type = String(svc.serviceType ?? '');
      const controlUrl = String(svc.controlURL ?? '');
      if (!controlUrl) continue;
      const abs = new URL(controlUrl, baseUrl).toString();
      if (type === SOAP_SERVICE.rendering) resolved.renderingControlUrl = abs;
      if (type === SOAP_SERVICE.avTransport) resolved.avTransportUrl = abs;
    }
    this.renderers.set(rendererUdn, resolved);
    return resolved;
  }

  /** Send a SOAP action to a renderer's service. Returns the response body, or undefined if unreachable. */
  private async soap(
    rendererUdn: string,
    service: keyof typeof SOAP_SERVICE,
    action: string,
    args: Record<string, string | number>,
  ): Promise<string | undefined> {
    const resolved = await this.resolveRenderer(rendererUdn);
    const controlUrl = service === 'rendering' ? resolved?.renderingControlUrl : resolved?.avTransportUrl;
    if (!controlUrl) {
      this.log.debug(`No ${service} control URL for ${rendererUdn}; skipping ${action}.`);
      return undefined;
    }

    const serviceType = SOAP_SERVICE[service];
    const body = buildSoapEnvelope(serviceType, action, args);
    const res = await fetchWithTimeout(
      controlUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${serviceType}#${action}"`,
        },
        body,
      },
      5000,
    );
    if (!res.ok) throw new Error(`SOAP ${action} -> HTTP ${res.status}`);
    return res.text();
  }
}

// --- module-local helpers ---------------------------------------------------

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildSoapEnvelope(serviceType: string, action: string, args: Record<string, string | number>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `<${k}>${escapeXml(String(v))}</${k}>`)
    .join('');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"'
    + ' s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
    + '<s:Body>'
    + `<u:${action} xmlns:u="${serviceType}">${inner}</u:${action}>`
    + '</s:Body></s:Envelope>';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1];
}

/** fast-xml-parser gives a single object for one child and an array for many. */
function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function attr(node: unknown, name: string): string | undefined {
  const v = (node as Record<string, unknown>)?.[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

/** Flatten a UPnP device tree (device + embedded deviceList) into its services. */
function collectServices(device: unknown): Array<Record<string, unknown>> {
  const services: Array<Record<string, unknown>> = [];
  const visit = (dev: Record<string, unknown> | undefined) => {
    if (!dev) return;
    const list = (dev.serviceList as { service?: unknown } | undefined)?.service;
    for (const svc of asArray(list)) services.push(svc as Record<string, unknown>);
    const nested = (dev.deviceList as { device?: unknown } | undefined)?.device;
    for (const d of asArray(nested)) visit(d as Record<string, unknown>);
  };
  visit(device as Record<string, unknown>);
  return services;
}
