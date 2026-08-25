import type { Logging } from 'homebridge';
import { networkInterfaces } from 'node:os';
import { XMLParser } from 'fast-xml-parser';
import { isPrivateIPv4, privateHttpUrl } from './net.js';
import { ssdpSearch } from './ssdpClient.js';
import { RAUMFELD_HTTP_PORT } from './settings.js';

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

/** Floor between on-demand /listDevices refreshes triggered by an unknown udn. */
const LOCATION_REFRESH_MIN_INTERVAL_MS = 10000;

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
  /** Locations already reported as blocked, so the log isn't flooded each pass. */
  private readonly warnedLocations = new Set<string>();
  /** When /listDevices was last fetched, to throttle on-demand refreshes. */
  private lastLocationRefresh = 0;

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

    // Sweep the configured subnet if one is given, otherwise every local IPv4
    // subnet. On a multi-homed host (Wi-Fi + Ethernet, VLAN NICs, a VPN tunnel)
    // the speakers are frequently on a NIC that is not the one holding the
    // default multicast route, so the sweep — not SSDP — is what finds them.
    const subnets = subnet ? [subnet] : localSubnets();
    if (!subnets.length) {
      log.debug('SSDP found nothing and no sweepable local IPv4 subnet was detected.');
      return undefined;
    }
    for (const cidr of subnets) {
      log.debug(`SSDP found nothing; unicast-sweeping ${cidr} for the Raumfeld host…`);
      const viaSweep = await RaumfeldClient.sweepSubnet(cidr, log);
      if (viaSweep) {
        log.info(`Discovered Raumfeld host at ${viaSweep} (unicast sweep of ${cidr})`);
        return viaSweep;
      }
      log.debug(`No host in ${cidr} answered /getZones on :${RAUMFELD_HTTP_PORT}.`);
    }
    return undefined;
  }

  private static async discoverViaSsdp(log: Logging): Promise<string | undefined> {
    // One socket per interface address. The OS multicast route resolves to a
    // single interface on a multi-homed host, so an M-SEARCH sent there never
    // reaches a host sitting on another NIC's subnet; binding each explicitly
    // searches all of them.
    const addresses = localIPv4Interfaces().map((iface) => iface.address);
    log.debug(`SSDP search for the Raumfeld host on ${addresses.length || 1} interface(s)…`);

    const candidates = await ssdpSearch({ addresses, timeoutMs: 3000, log });
    for (const address of candidates) {
      if (await RaumfeldClient.probe(address)) {
        log.info(`Discovered Raumfeld host at ${address}`);
        return address;
      }
    }
    log.debug(`SSDP saw ${candidates.length} device(s) but none served /getZones on :${RAUMFELD_HTTP_PORT}.`);
    return undefined;
  }

  /**
   * Unicast-probe every usable host in a CIDR (e.g. "192.168.20.0/24"), in
   * bounded-concurrency batches, and return the first that serves /getZones.
   * Prefix must be /22..\/30 to keep the sweep to at most ~1022 probes.
   */
  private static async sweepSubnet(cidr: string, log: Logging): Promise<string | undefined> {
    const hosts = enumerateCidr(cidr);
    if (!hosts) {
      log.warn(
        `Discovery subnet "${cidr}" is not a sweepable CIDR. Expected a private block with prefix `
        + '/22–/30, e.g. 192.168.20.0/24 (10/8, 172.16/12, 192.168/16 or 100.64/10).',
      );
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

  /** True if `address` answers the Raumfeld zone API. Non-private addresses are never probed. */
  private static async probe(address: string, timeoutMs = 2000): Promise<boolean> {
    if (!isPrivateIPv4(address)) return false;
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
  private async refreshDeviceLocations({ throttled = false } = {}): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    if (throttled && now - this.lastLocationRefresh < LOCATION_REFRESH_MIN_INTERVAL_MS) return;
    this.lastLocationRefresh = now;
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
      // These URLs come off the network. A spoofed or compromised host could
      // point them at the Homebridge admin API on localhost or at the public
      // internet, and we would dutifully fetch and later POST SOAP to them.
      if (!privateHttpUrl(location)) {
        // A blocked device never lands in `locations`, so this path is retried on
        // every pass — warn once per location instead of flooding the log.
        if (!this.warnedLocations.has(location)) {
          this.warnedLocations.add(location);
          this.log.warn(`Ignoring device ${udn}: description URL "${location}" is not a private HTTP address.`);
        }
        continue;
      }
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

    // A newly-appeared renderer may not be in the map yet — refresh once. A udn
    // that stays unresolvable (blocked location, or a device the host stopped
    // listing) would otherwise re-fetch /listDevices on every enrich pass, so
    // the on-demand refresh is throttled.
    if (!this.locations.has(rendererUdn)) await this.refreshDeviceLocations({ throttled: true });
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
    // A malformed or non-private <URLBase> must not throw out of here (that would
    // abort a control write); fall back to the already-validated location.
    const rawUrlBase = firstDefined(doc.root?.URLBase, doc.URLBase) as string | undefined;
    const urlBase = rawUrlBase ? privateHttpUrl(String(rawUrlBase)) : undefined;
    if (rawUrlBase && !urlBase && !this.warnedLocations.has(String(rawUrlBase))) {
      this.warnedLocations.add(String(rawUrlBase));
      this.log.warn(`Ignoring <URLBase> "${rawUrlBase}" for ${rendererUdn}: not a private HTTP address.`);
    }
    const resolveBase = urlBase ? urlBase.toString() : location;
    const baseUrl = urlBase ? urlBase.origin : new URL(location).origin;

    const resolved: ResolvedRenderer = {
      location,
      baseUrl,
      modelName: firstDefined(device?.modelName, device?.modelNumber) as string | undefined,
    };
    for (const svc of collectServices(device)) {
      const type = String(svc.serviceType ?? '');
      const controlUrl = String(svc.controlURL ?? '');
      if (!controlUrl) continue;
      // A controlURL may be absolute, so validating the description's location
      // alone is not enough — re-check the resolved target before we ever POST
      // a SOAP body to it.
      let abs: string;
      try {
        abs = new URL(controlUrl, resolveBase).toString();
      } catch {
        continue;
      }
      if (!privateHttpUrl(abs)) {
        if (!this.warnedLocations.has(abs)) {
          this.warnedLocations.add(abs);
          this.log.warn(`Ignoring ${type} control URL "${abs}" for ${rendererUdn}: not a private HTTP address.`);
        }
        continue;
      }
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

interface LocalInterface {
  name: string;
  address: string;
  /** e.g. "10.168.11.26/24" — absent on platforms that don't report it. */
  cidr?: string;
}

/** Every non-internal IPv4 interface, link-local (169.254/16) excluded. */
function localIPv4Interfaces(): LocalInterface[] {
  const found: LocalInterface[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      // Node <18.4 reported family as the number 4; accept both spellings.
      const isIPv4 = addr.family === 'IPv4' || (addr.family as unknown as number) === 4;
      if (!isIPv4 || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue; // APIPA — nothing to find
      found.push({ name, address: addr.address, cidr: addr.cidr ?? undefined });
    }
  }
  return found;
}

/**
 * Local IPv4 subnets worth sweeping, normalised to their network address and
 * de-duplicated (two NICs on one LAN must not be swept twice). Blocks wider than
 * /22 are dropped by `enumerateCidr` — sweeping them would mean 1000s of probes.
 * Capped so a machine with many tunnels can't turn discovery into a long scan.
 */
function localSubnets(limit = 6): string[] {
  const networks = new Set<string>();
  for (const iface of localIPv4Interfaces()) {
    if (!iface.cidr) continue;
    const network = networkAddressOf(iface.cidr);
    if (!network || !enumerateCidr(network)) continue;
    networks.add(network);
    if (networks.size >= limit) break;
  }
  return [...networks];
}

/** "10.168.11.26/24" -> "10.168.11.0/24"; undefined if malformed. */
function networkAddressOf(cidr: string): string | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix > 32) return undefined;

  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const size = 2 ** (32 - prefix);
  const network = (base & (size === 2 ** 32 ? 0 : (~(size - 1) >>> 0))) >>> 0;
  const dotted = [(network >>> 24) & 255, (network >>> 16) & 255, (network >>> 8) & 255, network & 255].join('.');
  return `${dotted}/${prefix}`;
}

/**
 * Expand a CIDR into its usable host IPs (drops network + broadcast for /<31).
 * Returns undefined for malformed input, an over-wide prefix (< /22) that would
 * balloon the sweep, or a block outside private address space — a home plugin
 * has no business port-scanning the public internet. Supports /22../32.
 */
function enumerateCidr(cidr: string): string[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix < 22 || prefix > 32) return undefined;
  if (!isPrivateIPv4(octets.join('.'))) return undefined;

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

/**
 * Ceiling for any body we read from the network. A zone config or device
 * description is a few KiB; without a cap, a hostile or malfunctioning host can
 * stream indefinitely into memory, since the timeouts below bound *stalls*, not
 * a body that keeps arriving quickly.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Read a response body as text, aborting once it exceeds `maxBytes`. */
async function readTextCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Response body from ${res.url || 'host'} exceeded ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Redirect hops we will follow. The host uses exactly one per request; anything
 * past a handful is a loop or a host trying to walk us somewhere.
 */
const MAX_REDIRECTS = 5;

/**
 * Resolve one `Location` against the URL that produced it, and return it only if
 * the hop is safe to follow.
 *
 * Following redirects blindly is what makes a fetch an SSRF primitive: the first
 * URL passes the private-address check, and the 3xx then hands us to loopback or
 * the public internet. So a hop to a *different* origin must clear the guard
 * again. A same-origin hop moves us nowhere new and is always allowed — which is
 * both what the host actually does and what keeps a host configured by name
 * (`raumfeld.local`, which the guard rejects on purpose) working.
 */
function nextRedirectTarget(location: string, from: string): URL | undefined {
  let resolved: URL;
  let origin: string;
  try {
    resolved = new URL(location, from);
    origin = new URL(from).origin;
  } catch {
    return undefined;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return undefined;
  if (resolved.origin === origin) return resolved;
  return privateHttpUrl(resolved.toString());
}

async function fetchWithTimeout(
  url: string,
  init: Parameters<typeof fetch>[1],
  timeoutMs: number,
): Promise<Response> {
  let target = url;
  let hopInit: Parameters<typeof fetch>[1] = init;
  let controller: AbortController;
  let res: Response;

  // The Raumfeld host web service answers *every* /getZones and /listDevices
  // with a 307 to a per-session UUID path (`/<uuid>/getZones`), so refusing
  // redirects outright — as 0.4.0 did — breaks all host communication. Follow
  // them by hand instead, re-checking each hop against the private-address
  // guard, so the security property survives without blocking the real host.
  for (let hop = 0; ; hop++) {
    controller = new AbortController();
    // Phase 1: bound the header exchange. Always cleared once fetch settles, so a
    // caller that never touches the body leaves no armed timer behind.
    const headerTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(target, { ...hopInit, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(headerTimer);
    }

    if (res.status !== 301 && res.status !== 302 && res.status !== 303
      && res.status !== 307 && res.status !== 308) break;

    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (${MAX_REDIRECTS}) starting at ${url}`);
    }
    const location = res.headers.get('location');
    const next = location ? nextRedirectTarget(location, target) : undefined;
    if (!next) {
      throw new Error(
        `Refusing redirect from ${target} to ${location ?? '(no Location header)'}`
        + ' — redirects must stay on plain HTTP(S) in private address space',
      );
    }
    // A redirect body is dead weight (the host sends Content-Length: 0); cancel
    // it so the socket is released rather than left for the GC.
    await res.body?.cancel().catch(() => undefined);

    const method = (hopInit?.method ?? 'GET').toUpperCase();
    // Per fetch semantics: 303, and 301/302 on a POST, continue as a bodyless
    // GET. 307/308 preserve method and body — which is what the host uses, and
    // what the SOAP POSTs need.
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      hopInit = { ...hopInit, method: 'GET', body: undefined };
    }
    target = next.toString();
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
  res.text = wrap(() => readTextCapped(res, MAX_BODY_BYTES));
  res.json = wrap(async () => JSON.parse(await readTextCapped(res, MAX_BODY_BYTES)) as unknown);
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
