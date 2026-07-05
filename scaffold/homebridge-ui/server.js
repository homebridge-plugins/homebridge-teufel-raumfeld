import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { XMLParser } from 'fast-xml-parser';

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

    // GET the live zone config from a host, returning rooms + zones.
    this.onRequest('/zones', async ({ host }) => this.fetchState(host));

    this.ready();
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
