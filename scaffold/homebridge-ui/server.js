import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { XMLParser } from 'fast-xml-parser';
import ssdp from 'node-ssdp';

const { Client: SsdpClient } = ssdp;
const RAUMFELD_HTTP_PORT = 47365;
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

/**
 * Custom-UI backend. The browser page (public/index.html) asks this server for
 * live host status + the current rooms/zones so it can render design 1b with
 * real data (status pill, device list, read-only zone groups) instead of a
 * static schema form.
 */
class RaumfeldUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    // Discover the Raumfeld host so the UI works with auto-discover on (empty
    // host field). SSDP first, then a unicast CIDR sweep for cross-subnet setups.
    // Mirrors RaumfeldClient.discover() in src/.
    this.onRequest('/discover', async ({ subnet } = {}) => this.discoverHost(subnet));

    // GET the live zone config from a host, returning rooms + zones.
    this.onRequest('/zones', async ({ host }) => this.fetchState(host));

    this.ready();
  }

  async discoverHost(subnet) {
    const viaSsdp = await this.discoverViaSsdp();
    if (viaSsdp) return { host: viaSsdp, via: 'ssdp' };
    if (subnet) {
      const viaSweep = await this.sweepSubnet(subnet);
      if (viaSweep) return { host: viaSweep, via: 'sweep' };
    }
    return { host: null };
  }

  // SSDP-search the LAN (link-local only), return first address serving /getZones.
  async discoverViaSsdp() {
    const client = new SsdpClient();
    const candidates = new Set();
    client.on('response', (_headers, _code, rinfo) => {
      if (rinfo?.address) candidates.add(rinfo.address);
    });
    try {
      client.search('urn:schemas-upnp-org:device:MediaServer:1');
      client.search('ssdp:all');
      await new Promise((r) => setTimeout(r, 3000));
      for (const address of candidates) {
        if (await this.probe(address)) return address;
      }
      return null;
    } finally {
      client.stop();
    }
  }

  // Unicast-probe a CIDR in bounded-concurrency batches; works across subnets.
  async sweepSubnet(cidr) {
    const hosts = enumerateCidr(cidr);
    if (!hosts) throw new RequestError(`Invalid discovery subnet "${cidr}" (expected e.g. 192.168.20.0/24, prefix /22–/30).`, { status: 400 });
    const CONCURRENCY = 32;
    for (let i = 0; i < hosts.length; i += CONCURRENCY) {
      const batch = hosts.slice(i, i + CONCURRENCY);
      const hits = await Promise.all(batch.map(async (ip) => ((await this.probe(ip, 1000)) ? ip : null)));
      const found = hits.find((ip) => ip);
      if (found) return found;
    }
    return null;
  }

  // True if `address` answers the Raumfeld zone API.
  async probe(address, timeoutMs = 2000) {
    try {
      const res = await fetchWithTimeout(`http://${address}:${RAUMFELD_HTTP_PORT}/getZones`, timeoutMs);
      void res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    }
  }

  async fetchState(host) {
    if (!host) throw new RequestError('No host provided', { status: 400 });
    let text;
    try {
      const res = await fetchWithTimeout(`http://${host}:${RAUMFELD_HTTP_PORT}/getZones`, 5000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      // Surface a clean "disconnected" state rather than throwing — the pill
      // in the UI turns red and the rest of the form still works.
      return { connected: false, error: String(err.message ?? err), rooms: [], zones: [] };
    }
    return { connected: true, ...parseZoneConfig(text) };
  }
}

function parseZoneConfig(xml) {
  const cfg = parser.parse(xml).zoneConfig ?? {};
  const rooms = [];
  const zones = [];

  for (const zone of asArray(cfg.zones?.zone)) {
    const zoneRooms = asArray(zone.room).map(toRoom);
    rooms.push(...zoneRooms);
    if (zoneRooms.length === 0) continue;
    zones.push({
      udn: attr(zone, 'udn') ?? zoneRooms[0].udn,
      name: zoneRooms.map((r) => r.name).join(' + '),
      leadRoom: zoneRooms[0].name,
      members: zoneRooms.map((r) => r.name),
    });
  }
  for (const room of asArray(cfg.unassignedRooms?.room)) rooms.push(toRoom(room));

  return { rooms, zones };
}

function toRoom(node) {
  return {
    udn: attr(node, 'udn') ?? '',
    name: attr(node, 'name') ?? 'Speaker',
    model: attr(node, 'model') ?? attr(node, 'roomName') ?? 'Speaker',
  };
}

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function attr(node, name) {
  const v = node?.[`@_${name}`];
  return v === undefined ? undefined : String(v);
}

// Expand a CIDR (/22../32) into usable host IPs; undefined if malformed/too wide.
function enumerateCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix < 22 || prefix > 32) return undefined;

  const base = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
  const size = 2 ** (32 - prefix);
  const network = base & (size === 2 ** 32 ? 0 : (~(size - 1) >>> 0));
  const first = prefix >= 31 ? network : network + 1;
  const last = prefix >= 31 ? network + size - 1 : network + size - 2;

  const hosts = [];
  for (let n = first; n <= last; n++) {
    hosts.push([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return hosts;
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// eslint-disable-next-line no-new
(() => new RaumfeldUiServer())();
