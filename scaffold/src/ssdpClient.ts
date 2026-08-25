import { createSocket, type Socket } from 'node:dgram';

/**
 * Minimal SSDP M-SEARCH client.
 *
 * This replaces `node-ssdp`, which is unmaintained and pulls in `ip`
 * (GHSA-2p57-rm9w-gvfp); npm's suggested "fix" for that advisory is a downgrade
 * to node-ssdp 1.0.0. Discovery here only ever needs one thing — the source
 * addresses of whatever answers an M-SEARCH — so the ~100 lines below cover the
 * whole requirement with no dependency at all.
 *
 * One socket is bound per local interface address on purpose: the OS multicast
 * route resolves to a single interface, so a search sent on the default socket
 * never reaches a host sitting on another NIC's subnet (see the multi-homed case
 * in RaumfeldClient.discover).
 */

const SSDP_MULTICAST_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/** Raumfeld hosts advertise a MediaServer; `ssdp:all` is the wider net. */
export const DEFAULT_SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:MediaServer:1',
  'ssdp:all',
];

export interface SsdpLogger {
  debug(message: string): void;
}

export interface SsdpSearchOptions {
  /** Local IPv4 addresses to bind to. Empty/omitted uses the default route only. */
  addresses?: string[];
  searchTargets?: string[];
  /** How long to collect responses before resolving. */
  timeoutMs?: number;
  log?: SsdpLogger;
}

/**
 * Send an M-SEARCH from every given local address and collect the source
 * addresses that reply. Never rejects: an interface that cannot join the
 * multicast group (point-to-point tunnels, a NIC that just went down) is logged
 * and skipped so it can't take the rest of the search down with it.
 */
export async function ssdpSearch(options: SsdpSearchOptions = {}): Promise<string[]> {
  const {
    addresses = [],
    searchTargets = DEFAULT_SEARCH_TARGETS,
    timeoutMs = 3000,
    log,
  } = options;

  const binds: (string | undefined)[] = addresses.length ? [...new Set(addresses)] : [undefined];
  const responders = new Set<string>();
  const sockets: Socket[] = [];

  await Promise.all(binds.map(async (address) => {
    const label = address ?? 'default';
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    // Late errors (a NIC disappearing mid-search) must not become an unhandled
    // 'error' event, which would crash Homebridge.
    socket.on('error', (err) => log?.debug(`SSDP socket error on ${label}: ${err.message}`));
    socket.on('message', (_msg, rinfo) => {
      if (rinfo?.address) responders.add(rinfo.address);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onBindError = (err: Error): void => reject(err);
        socket.once('error', onBindError);
        socket.bind({ address, port: 0 }, () => {
          socket.off('error', onBindError);
          resolve();
        });
      });
    } catch (err) {
      log?.debug(`SSDP could not bind to ${label}: ${(err as Error).message}`);
      closeQuietly(socket);
      return;
    }

    sockets.push(socket);
    if (address) {
      // Pin the outgoing multicast to this interface rather than the default route.
      try {
        socket.setMulticastInterface(address);
      } catch (err) {
        log?.debug(`SSDP could not pin multicast to ${label}: ${(err as Error).message}`);
      }
    }
    try {
      socket.setMulticastTTL(4);
    } catch {
      // Not fatal — the default TTL still reaches the local segment.
    }

    for (const target of searchTargets) {
      const packet = buildMSearch(target, Math.max(1, Math.round(timeoutMs / 1000)));
      socket.send(packet, SSDP_PORT, SSDP_MULTICAST_ADDRESS, (err) => {
        if (err) log?.debug(`SSDP send failed on ${label}: ${err.message}`);
      });
    }
  }));

  try {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
  } finally {
    for (const socket of sockets) closeQuietly(socket);
  }

  return [...responders];
}

/** An M-SEARCH request per UPnP Device Architecture 1.1, §1.3.2. */
function buildMSearch(searchTarget: string, mxSeconds: number): Buffer {
  return Buffer.from([
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_MULTICAST_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mxSeconds}`,
    `ST: ${searchTarget}`,
    '',
    '',
  ].join('\r\n'), 'ascii');
}

/** close() throws on a socket that never bound; there is nothing to clean up then. */
function closeQuietly(socket: Socket): void {
  try {
    socket.close();
  } catch {
    // already closed or never bound
  }
}
