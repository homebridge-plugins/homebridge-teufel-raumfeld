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

/** A UPnP SOAP fault (HTTP 500 + optional <errorCode>). */
export class SoapFault extends Error {
  constructor(
    readonly action: string,
    readonly httpStatus: number,
    readonly upnpCode?: number,
  ) {
    super(`SOAP ${action} -> HTTP ${httpStatus}${upnpCode !== undefined ? ` (UPnP ${upnpCode})` : ''}`);
    this.name = 'SoapFault';
  }

  /**
   * True when the fault means "can't transition right now" rather than a broken
   * transport — chiefly 701 (transition not available), i.e. Play issued with
   * nothing queued. Callers can treat this as a benign no-op.
   */
  get isTransitionUnavailable(): boolean {
    return this.upnpCode === 701;
  }
}

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

  /**
   * Discover the Raumfeld host IP. Tries SSDP multicast first; if that finds
   * nothing and a `subnet` (CIDR) is given, falls back to a unicast sweep of
   * that subnet. Multicast is link-local (routers don't forward 239.255.255.250),
   * so the unicast sweep is the only auto-discovery that works when Homebridge
   * and the speakers sit on different subnets/VLANs. Returns undefined if none.
   */
  static async discover(log: Logging, subnet?: string): Promise<string | undefined> {
    const viaSsdp = await RaumfeldClient.discoverViaSsdp(log);
    if (viaSsdp) return viaSsdp;

    if (subnet) {
      log.debug(`SSDP found nothing; unicast-sweeping ${subnet} for the Raumfeld host…`);
      const viaSweep = await RaumfeldClient.sweepSubnet(subnet, log);
      if (viaSweep) {
        log.info(`Discovered Raumfeld host at ${viaSweep} (unicast sweep of ${subnet})`);
        return viaSweep;
      }
      log.debug(`No host in ${subnet} answered /getZones on :${RAUMFELD_HTTP_PORT}.`);
    }
    return undefined;
  }

  private static async discoverViaSsdp(log: Logging): Promise<string | undefined> {
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

  /**
   * Unicast-probe every usable host in a CIDR (e.g. "192.168.20.0/24"), in
   * bounded-concurrency batches, and return the first that serves /getZones.
   * Prefix must be /22..\/30 to keep the sweep to at most ~1022 probes.
   */
  private static async sweepSubnet(cidr: string, log: Logging): Promise<string | undefined> {
    const hosts = enumerateCidr(cidr);
    if (!hosts) {
      log.warn(`Discovery subnet "${cidr}" is not a valid CIDR (expected e.g. 192.168.20.0/24, prefix /22–/30).`);
      return undefined;
    }
    const CONCURRENCY = 32;
    for (let i = 0; i < hosts.length; i += CONCURRENCY) {
      const batch = hosts.slice(i, i + CONCURRENCY);
      const hits = await Promise.all(
        batch.map(async (ip) => ((await RaumfeldClient.probe(ip, 1000)) ? ip : undefined)),
      );
      const found = hits.find((ip) => ip !== undefined);
      if (found) return found;
    }
    return undefined;
  }

  /** True if `address` answers the Raumfeld zone API. */
  private static async probe(address: string, timeoutMs = 2000): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`http://${address}:${RAUMFELD_HTTP_PORT}/getZones`, {}, timeoutMs);
      void res.body?.cancel(); // probe only needs the status; release the socket
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
    await res.text().catch(() => undefined); // consume body so the socket can be reused
    if (!res.ok) throw new Error(`Host returned HTTP ${res.status} for /getZones`);
    // Learn every device's description URL from the host over HTTP. Unlike SSDP
    // this works across subnets (Homebridge and the speakers on different VLANs),
    // and includes the per-zone virtual renderers used for group control.
    await this.refreshDeviceLocations();
    this.locationTimer = setInterval(() => {
      this.refreshDeviceLocations().catch((err) =>
        this.log.debug(`Device-location refresh failed: ${(err as Error).message}`));
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
  async waitForChange(timeoutMs = 30000): Promise<boolean> {
    const url = this.lastUpdateId
      ? `${this.baseUrl}/getZones?updateId=${encodeURIComponent(this.lastUpdateId)}`
      : `${this.baseUrl}/getZones`;
    try {
      const res = await fetchWithTimeout(url, {}, timeoutMs);
      // Always drain the body so the connection can be reused, even on non-2xx.
      await res.text().catch(() => undefined);
      if (!res.ok) return false;
      this.captureUpdateId(res);
      return true;
    } catch {
      // Timeout / transient network error — caller backs off and retries.
      return false;
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
    if (!res.ok) {
      void res.body?.cancel();
      throw new Error(`/getZones -> HTTP ${res.status}`);
    }
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
    // Play on a zone with nothing queued faults with UPnP 701; that fault is
    // left to propagate so the caller can decide how to present it (see
    // SoapFault.isTransitionUnavailable). Swallowing it here would report a
    // write as successful that never started any audio.
    await this.soapRequired(rendererUdn, 'avTransport', action, args);
  }

  /**
   * Point a renderer at a media URI (UPnP AVTransport SetAVTransportURI), then
   * the caller issues Play. `metadata` is a DIDL-Lite document describing the
   * item; many renderers accept an empty string. NOTE: spike/experimental — used
   * to test whether a Raumfeld renderer will play a foreign HTTP stream (the
   * precondition for the AirPlay re-serve path). Not yet wired into the plugin.
   */
  async setAvTransportUri(rendererUdn: string, uri: string, metadata = ''): Promise<void> {
    await this.soapRequired(rendererUdn, 'avTransport', 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: metadata,
    });
  }

  /**
   * Set volume (0-100). For a group pass the member renderer udns in `alsoUdns`
   * so each speaker tracks the group volume (config: syncGroupVolume). Every
   * target is attempted; failures are aggregated so one dead member doesn't
   * leave the rest unsynchronised.
   */
  async setVolume(rendererUdn: string, volume: number, alsoUdns: string[] = []): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    await this.fanOut([rendererUdn, ...alsoUdns], 'SetVolume', (udn) =>
      this.soapRequired(udn, 'rendering', 'SetVolume', {
        InstanceID: 0,
        Channel: 'Master',
        DesiredVolume: clamped,
      }));
  }

  async setMute(rendererUdn: string, mute: boolean, alsoUdns: string[] = []): Promise<void> {
    await this.fanOut([rendererUdn, ...alsoUdns], 'SetMute', (udn) =>
      this.soapRequired(udn, 'rendering', 'SetMute', {
        InstanceID: 0,
        Channel: 'Master',
        DesiredMute: mute ? 1 : 0,
      }));
  }

  /** Run a write against every renderer; aggregate failures instead of stopping at the first. */
  private async fanOut(udns: string[], action: string, op: (udn: string) => Promise<unknown>): Promise<void> {
    const results = await Promise.allSettled(udns.map(op));
    const failures = results.flatMap((r, i) =>
      r.status === 'rejected' ? [`${udns[i]}: ${(r.reason as Error).message}`] : []);
    if (failures.length) throw new Error(`${action} failed for ${failures.length}/${udns.length}: ${failures.join('; ')}`);
  }

  // --- Group management (authored in the Raumfeld app; mutated rarely here) ---

  async connectRoomToZone(roomUdn: string, zoneUdn: string): Promise<void> {
    const url = `${this.baseUrl}/connectRoomToZone?roomUDN=${encodeURIComponent(roomUdn)}`
      + `&zoneUDN=${encodeURIComponent(zoneUdn)}`;
    const res = await fetchWithTimeout(url, {}, 5000);
    void res.body?.cancel(); // no body needed; release the socket
    if (!res.ok) throw new Error(`connectRoomToZone -> HTTP ${res.status}`);
  }

  async dropRoom(roomUdn: string): Promise<void> {
    const url = `${this.baseUrl}/dropRoom?roomUDN=${encodeURIComponent(roomUdn)}`;
    const res = await fetchWithTimeout(url, {}, 5000);
    void res.body?.cancel(); // no body needed; release the socket
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
    const cfg = doc.zoneConfig;
    // A 200 with an unexpected body (captive portal, wrong host, firmware quirk)
    // must NOT parse to an empty snapshot — that would prune every accessory.
    // Throw so the caller (safeSync) skips this pass and keeps the last good state.
    if (!cfg || typeof cfg !== 'object') {
      throw new Error('Unexpected /getZones payload: missing <zoneConfig> root');
    }
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
        name: sanitizeHapName(zoneRooms.map((r) => r.name).join(' + ')),
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
      name: sanitizeHapName(attr(node, 'name') ?? 'Speaker'),
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
          const playing = await this.queryTransportState(room.rendererUdn);
          if (playing !== undefined) room.playing = playing;
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

  /** Current AVTransport play state -> true when PLAYING/TRANSITIONING, else false. */
  private async queryTransportState(rendererUdn: string): Promise<boolean | undefined> {
    const xml = await this.soap(rendererUdn, 'avTransport', 'GetTransportInfo', { InstanceID: 0 });
    if (!xml) return undefined;
    const state = extractTag(xml, 'CurrentTransportState');
    if (!state) return undefined;
    return state === 'PLAYING' || state === 'TRANSITIONING';
  }

  /**
   * Refresh the udn -> description-URL map from the host's /listDevices. This
   * enumerates every speaker, connector and per-zone virtual renderer with an
   * HTTP location that is reachable across subnets (no SSDP multicast needed).
   */
  private async refreshDeviceLocations(): Promise<void> {
    if (this.disposed) return;
    const res = await fetchWithTimeout(`${this.baseUrl}/listDevices`, {}, 5000);
    if (!res.ok) {
      void res.body?.cancel();
      return;
    }
    const doc = this.parser.parse(await res.text());
    for (const dev of asArray(doc.devices?.device)) {
      const udn = attr(dev, 'udn');
      const location = attr(dev, 'location');
      if (!udn || !location) continue;
      // A renderer that moved (new IP/description URL) must drop its memoised
      // control endpoints, otherwise writes keep hitting the stale address.
      if (this.locations.get(udn) !== location) this.renderers.delete(udn);
      this.locations.set(udn, location);
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
    if (!res.ok) {
      void res.body?.cancel();
      return undefined;
    }
    const doc = this.parser.parse(await res.text());
    const device = doc.root?.device ?? doc.device;
    // Relative controlURLs resolve against <URLBase> when the description
    // provides one, else against the description's own URL (which carries the
    // correct path) — NOT the bare origin, which drops any base path.
    const urlBase = firstDefined(doc.root?.URLBase, doc.URLBase) as string | undefined;
    const resolveBase = urlBase ? new URL(urlBase).toString() : location;
    const baseUrl = urlBase ? new URL(urlBase).origin : new URL(location).origin;

    const resolved: ResolvedRenderer = {
      location,
      baseUrl,
      modelName: firstDefined(device?.modelName, device?.modelNumber) as string | undefined,
    };
    for (const svc of collectServices(device)) {
      const type = String(svc.serviceType ?? '');
      const controlUrl = String(svc.controlURL ?? '');
      if (!controlUrl) continue;
      const abs = new URL(controlUrl, resolveBase).toString();
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
    if (!res.ok) {
      // UPnP faults come back as HTTP 500 with a SOAP body carrying an
      // <errorCode>. Surface it so callers can tell "can't do that right now"
      // (e.g. 701 transition-not-available: Play with nothing queued) from a
      // genuine transport failure.
      const faultBody = await res.text().catch(() => '');
      const errorCode = Number(extractTag(faultBody, 'errorCode'));
      throw new SoapFault(action, res.status, Number.isFinite(errorCode) ? errorCode : undefined);
    }
    return res.text();
  }

  /**
   * Like {@link soap} but for control actions: a missing endpoint is a hard
   * failure, not a silent no-op. Callers surface the error to HomeKit so a
   * write that couldn't be delivered isn't reported as success.
   */
  private async soapRequired(
    rendererUdn: string,
    service: keyof typeof SOAP_SERVICE,
    action: string,
    args: Record<string, string | number>,
  ): Promise<string> {
    const resolved = await this.resolveRenderer(rendererUdn);
    const controlUrl = service === 'rendering' ? resolved?.renderingControlUrl : resolved?.avTransportUrl;
    if (!controlUrl) {
      throw new Error(`No ${service} endpoint for ${rendererUdn}; cannot ${action}`);
    }
    const body = await this.soap(rendererUdn, service, action, args);
    if (body === undefined) throw new Error(`${service} ${action} for ${rendererUdn} was not delivered`);
    return body;
  }
}

// --- module-local helpers ---------------------------------------------------

/**
 * Expand a CIDR into its usable host IPs (drops network + broadcast for /<31).
 * Returns undefined for malformed input or an over-wide prefix (< /22), which
 * would balloon the sweep. Supports /22../32.
 */
function enumerateCidr(cidr: string): string[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix < 22 || prefix > 32) return undefined;

  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const size = 2 ** (32 - prefix);
  const network = base & (size === 2 ** 32 ? 0 : ~(size - 1) >>> 0);
  // /31 and /32 have no network/broadcast to skip; larger blocks drop both.
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? network + size - 1 : network + size - 2;

  const hosts: string[] = [];
  for (let n = first; n <= last; n++) {
    hosts.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return hosts;
}

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  // Phase 1: bound the header exchange. Always cleared once fetch settles, so a
  // caller that never touches the body leaves no armed timer behind.
  const headerTimer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(headerTimer);
  }
  // Phase 2: fetch resolves on headers, so a stalled body could still hang. Bound
  // each body read with its own timer on the same controller, cleared on settle.
  const wrap = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const bodyTimer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fn(...a);
      } finally {
        clearTimeout(bodyTimer);
      }
    };
  res.text = wrap(res.text.bind(res));
  res.json = wrap(res.json.bind(res));
  res.arrayBuffer = wrap(res.arrayBuffer.bind(res));
  return res;
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

/**
 * Pull a SOAP scalar out by local name, tolerating a namespace prefix and
 * attributes on the tag (e.g. `<u:CurrentVolume ...>`, `<CurrentVolume>`).
 * The previous prefix-blind `<tag>` match silently read prefixed values as
 * empty, which HomeKit then saw as volume 0 / not muted / paused.
 */
function extractTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}>`).exec(xml);
  return m?.[1]?.trim();
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

/**
 * HomeKit's Name/ConfiguredName characteristics reject anything that isn't a
 * letter, number, space, apostrophe, or common punctuation, and the string must
 * start and end with a letter or number. Room names come straight from the host
 * and zone names are joined with " + ", so an invalid character (e.g. the "+"
 * separator) makes HAP-NodeJS warn and can stop the accessory being added in the
 * Home app. Coerce to a valid form: spell out "&"/"+" as "and", drop unsupported
 * characters, collapse whitespace, and trim non-alphanumeric edges.
 */
function sanitizeHapName(raw: string): string {
  const cleaned = raw
    .replace(/[&+]/g, ' and ')
    // Keep Unicode letters/numbers (covers umlauts like "Küche") plus the
    // punctuation HAP accepts; everything else (emoji, symbols) is dropped.
    .replace(/[^\p{L}\p{N} .,'()-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .trim();
  return cleaned || 'Speaker';
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
