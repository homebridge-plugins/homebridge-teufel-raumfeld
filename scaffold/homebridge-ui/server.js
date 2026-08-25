import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { XMLParser } from 'fast-xml-parser';
import { isIP } from 'node:net';

// Shared with the plugin itself so discovery and the address guards can't drift
// apart. Requires `npm run build` to have produced dist/ (the published tarball
// always ships it).
import { isPrivateIPv4 } from '../dist/net.js';
import { ssdpSearch } from '../dist/ssdpClient.js';

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
    const candidates = await ssdpSearch({ timeoutMs: 3000 });
    for (const address of candidates) {
      if (await this.probe(address)) return address;
    }
    return null;
  }

  // Unicast-probe a CIDR in bounded-concurrency batches; works across subnets.
  async sweepSubnet(cidr) {
    const hosts = enumerateCidr(cidr);
    if (!hosts) {
      throw new RequestError(
        `Invalid discovery subnet "${cidr}". Expected a private block with prefix /22–/30, `
        + 'e.g. 192.168.20.0/24 (10/8, 172.16/12, 192.168/16 or 100.64/10).',
        { status: 400 },
      );
    }
    const CONCURRENCY = 32;
    for (let i = 0; i < hosts.length; i += CONCURRENCY) {
      const batch = hosts.slice(i, i + CONCURRENCY);
      const hits = await Promise.all(batch.map(async (ip) => ((await this.probe(ip, 1000)) ? ip : null)));
      const found = hits.find((ip) => ip);
      if (found) return found;
    }
    return null;
  }

  // True if `address` answers the Raumfeld zone API. Non-private addresses are
  // never probed, so neither discovery path can be aimed off the LAN.
  async probe(address, timeoutMs = 2000) {
    if (!isPrivateIPv4(address)) return false;
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
    const baseUrl = baseUrlForHost(host);
    let text;
    try {
      const { res, text: responseText } = await fetchTextWithTimeout(`${baseUrl}/getZones`, 5000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = responseText;
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

// Expand a CIDR (/22../32) into usable host IPs; undefined if malformed, too
// wide, or outside private space. The private-range check matters here: this
// endpoint is reachable from the browser, and without it a logged-in UI session
// could aim a 1022-host concurrent sweep at arbitrary public address space.
function enumerateCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr).trim());
  if (!m) return undefined;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix < 22 || prefix > 32) return undefined;
  if (!isPrivateIPv4(octets.join('.'))) return undefined;

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
    // No redirects: a 3xx would let a probed host bounce us to an address that
    // never passed the private-range check.
    return await fetch(url, { redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch and consume a response body under one deadline. */
async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return { res, text: '' };
    }
    return { res, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Accept only a bare IPv4/IPv6 address or DNS hostname, never a URL fragment. */
function baseUrlForHost(value) {
  const host = String(value).trim();
  const ipVersion = isIP(host);
  if (ipVersion === 6) return `http://[${host}]:${RAUMFELD_HTTP_PORT}`;
  if (ipVersion === 4 || isHostname(host)) return `http://${host}:${RAUMFELD_HTTP_PORT}`;
  throw new RequestError(`Invalid Raumfeld host "${host}".`, { status: 400 });
}

function isHostname(value) {
  if (!value || value.length > 253 || value.includes('..')) return false;
  const labels = value.replace(/\.$/, '').split('.');
  return labels.every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

// eslint-disable-next-line no-new
(() => new RaumfeldUiServer())();
