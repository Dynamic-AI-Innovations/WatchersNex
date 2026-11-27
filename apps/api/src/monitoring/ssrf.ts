import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

/**
 * SSRF guard (Technical Architecture, Section 7; threat T-01).
 *
 * Monitors may only reach public internet addresses. Every address a hostname
 * resolves to is checked, the connection is pinned to the checked address
 * (defeating DNS rebinding), and every redirect hop is checked again.
 */

const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
].map((cidr) => ipaddr.IPv4.parseCIDR(cidr));

const BLOCKED_V6 = [
  '::/128', '::1/128', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/32', '2001:db8::/32',
  '2002::/16', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8',
].map((cidr) => ipaddr.IPv6.parseCIDR(cidr));

/** True for any address a monitor must not connect to, including anything unparseable. */
export function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  if (parsed.kind() === 'ipv4') {
    const v4 = parsed as ipaddr.IPv4;
    return BLOCKED_V4.some((range) => v4.match(range));
  }
  const v6 = parsed as ipaddr.IPv6;
  return BLOCKED_V6.some((range) => v6.match(range));
}

export interface TargetPolicy {
  /** Decides whether an address is off limits. Tests may substitute their own. */
  isBlocked(address: string): boolean;
}

export const PUBLIC_ONLY: TargetPolicy = { isBlocked: isBlockedAddress };

export class TargetRejected extends Error {
  constructor(
    readonly reason: 'scheme' | 'credentials' | 'port' | 'host' | 'blocked' | 'dns',
    message: string,
  ) {
    super(message);
  }
}

const ALLOWED_LOW_PORTS = new Set([80, 443]);

/**
 * Parses and checks a monitor URL without network access. The WHATWG parser
 * normalises numeric and octal host forms (http://2130706433/, http://0177.1/)
 * to dotted IPv4, so they meet the same address check below.
 */
export function parseTargetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetRejected('host', 'Enter a full URL, including http:// or https://.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetRejected('scheme', 'Only http:// and https:// addresses can be monitored.');
  }
  if (url.username || url.password) {
    throw new TargetRejected('credentials', 'Remove the username and password from the URL. Credentials in URLs end up in logs.');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_LOW_PORTS.has(port) && port < 1024) {
    throw new TargetRejected('port', 'Ports below 1024 other than 80 and 443 cannot be monitored.');
  }
  if (!url.hostname) throw new TargetRejected('host', 'The URL has no host.');
  return url;
}

/** Strips the brackets WHATWG keeps around IPv6 literals in URL.hostname. */
export function bareHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export interface ResolvedTarget {
  address: string;
  family: 4 | 6;
}

/** Resolves a hostname and returns an address to pin to, or throws if any address is blocked. */
export async function resolveTarget(hostname: string, policy: TargetPolicy = PUBLIC_ONLY): Promise<ResolvedTarget> {
  const host = bareHost(hostname);
  if (ipaddr.isValid(host)) {
    if (policy.isBlocked(host)) throw blocked();
    return { address: host, family: ipaddr.parse(host).kind() === 'ipv6' ? 6 : 4 };
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new TargetRejected('dns', `The host name "${host}" could not be resolved.`);
  }
  if (records.length === 0) throw new TargetRejected('dns', `The host name "${host}" could not be resolved.`);
  // If any address is private, refuse outright rather than "pick a public one":
  // a name that mixes public and private answers is a classic rebinding setup.
  if (records.some((r) => policy.isBlocked(r.address))) throw blocked();
  const first = records[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

function blocked(): TargetRejected {
  return new TargetRejected(
    'blocked',
    'This address points to a private, local or reserved network. WatchersNex only monitors public internet addresses.',
  );
}
