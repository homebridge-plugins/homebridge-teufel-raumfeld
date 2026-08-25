import { isIP } from 'node:net';

/**
 * Address-range guards shared by the plugin and the custom-UI backend.
 *
 * Everything this plugin talks to — the Raumfeld host, its renderers, the
 * subnets it sweeps — lives on the local network. Device descriptions and
 * control URLs, though, arrive as XML *from the network*, so a host that is
 * spoofed or compromised can name any URL it likes and have the plugin fetch or
 * POST to it. Restricting those targets to private address space keeps that
 * from reaching the Homebridge admin API on localhost, a cloud metadata
 * endpoint, or anything on the public internet.
 */

/**
 * RFC1918 (10/8, 172.16/12, 192.168/16) plus CGNAT (100.64/10), which is what
 * Tailscale and some ISP routers hand out.
 *
 * Deliberately excluded: loopback (127/8 — the Homebridge admin API), link-local
 * (169.254/16 — cloud instance metadata lives at 169.254.169.254), 0.0.0.0/8,
 * and all public space.
 */
export function isPrivateIPv4(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4) return false;
  const parsed = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (parsed.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return false;

  const [a, b] = parsed;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Unique local addresses (fc00::/7). IPv4-mapped forms defer to the IPv4 rules. */
export function isPrivateIPv6(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped) return isPrivateIPv4(mapped[1]);
  const head = bare.startsWith('::') ? 0 : Number.parseInt(bare.split(':')[0], 16);
  if (!Number.isInteger(head)) return false;
  return (head & 0xfe00) === 0xfc00;
}

/**
 * True only for a literal IP in private space. Hostnames are rejected on
 * purpose: resolving one here would still leave the actual connection open to
 * DNS rebinding, and the Raumfeld host reports its devices by IP anyway.
 */
export function isPrivateHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  const version = isIP(bare);
  if (version === 4) return isPrivateIPv4(bare);
  if (version === 6) return isPrivateIPv6(bare);
  return false;
}

/**
 * Parse a URL that came from the network and return it only if it is a plain
 * HTTP(S) URL pointing at a private address. Anything else — a non-HTTP scheme,
 * a hostname, loopback, a public IP, or malformed input — yields undefined.
 */
export function privateHttpUrl(raw: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!isPrivateHost(url.hostname)) return undefined;
  return url;
}
