import type { Logging } from 'homebridge';
import { RAUMFELD_HTTP_PORT } from './settings.js';

export interface RaumfeldRoom {
  udn: string;
  name: string;
  model: string;      // "Stereo L", "One", "Soundbar", ...
  volume?: number;    // 0-100
  mute?: boolean;
  playing?: boolean;
}

export interface RaumfeldZone {
  udn: string;        // zone / group id
  name: string;       // e.g. "Downstairs"
  leadRoomUdn: string;
  rooms: RaumfeldRoom[];
  volume?: number;
  mute?: boolean;
  playing?: boolean;
}

/**
 * Thin client for the Raumfeld host.
 *
 * The host exposes two useful surfaces:
 *  1. An HTTP API on port 47365 for zones:  GET /getZones,
 *     GET /connectRoomToZone?roomUDN=..&zoneUDN=.., GET /dropRoom?roomUDN=..
 *     and a long-poll /getZones?updateId=.. for change notifications.
 *  2. UPnP / OpenHome services per renderer (SetVolume, Play, Pause, SetChannel
 *     for AirPlay hand-off) reached via SOAP, discoverable over SSDP
 *     (search target: urn:schemas-upnp-org:device:MediaRenderer:1 and the
 *     Raumfeld-specific device types).
 *
 * Everything below is a STUB. Implement the HTTP + SOAP calls, or wrap an
 * existing UPnP client library. Prefer GENA eventing / the long-poll updateId
 * over fixed polling so group changes made in the Raumfeld app appear instantly.
 */
export class RaumfeldClient {
  constructor(
    private readonly host: string,
    private readonly log: Logging,
  ) {}

  /** SSDP-discover the Raumfeld host IP. Returns undefined if none found. */
  static async discover(log: Logging): Promise<string | undefined> {
    log.debug('TODO: SSDP search for the Raumfeld host.');
    // Use node-ssdp Client, search ssdp:all / the Raumfeld device type,
    // resolve the host that serves /getZones on port 47365.
    return undefined;
  }

  get baseUrl(): string {
    return `http://${this.host}:${RAUMFELD_HTTP_PORT}`;
  }

  async connect(): Promise<void> {
    this.log.info(`Connecting to Raumfeld host at ${this.baseUrl}`);
    // TODO: verify reachability; open GENA subscription / long-poll loop.
  }

  dispose(): void {
    // TODO: tear down subscriptions / sockets.
  }

  /** All known rooms (individual speakers). */
  async getRooms(): Promise<RaumfeldRoom[]> {
    // TODO: derive from /getZones (rooms are nested inside zones in the XML).
    return [];
  }

  /** Active zones. A zone with >1 room is a multiroom group. */
  async getZones(): Promise<RaumfeldZone[]> {
    // TODO: GET /getZones, parse the XML into RaumfeldZone[].
    return [];
  }

  async setPlayState(rendererUdn: string, targetMediaState: number): Promise<void> {
    // TODO: SOAP Play/Pause on the renderer's AVTransport/OpenHome service.
    this.log.debug(`setPlayState(${rendererUdn}, ${targetMediaState})`);
  }

  async setVolume(rendererUdn: string, volume: number): Promise<void> {
    // TODO: SOAP SetVolume (0-100). For a group, apply to lead + members if syncGroupVolume.
    this.log.debug(`setVolume(${rendererUdn}, ${volume})`);
  }

  async setMute(rendererUdn: string, mute: boolean): Promise<void> {
    this.log.debug(`setMute(${rendererUdn}, ${mute})`);
  }

  // --- Group management (authored in the Raumfeld app; exposed here read-mostly) ---

  async connectRoomToZone(roomUdn: string, zoneUdn: string): Promise<void> {
    // GET /connectRoomToZone?roomUDN=..&zoneUDN=..
    this.log.debug(`connectRoomToZone(${roomUdn}, ${zoneUdn})`);
  }

  async dropRoom(roomUdn: string): Promise<void> {
    // GET /dropRoom?roomUDN=..  (removes room from its zone)
    this.log.debug(`dropRoom(${roomUdn})`);
  }
}
