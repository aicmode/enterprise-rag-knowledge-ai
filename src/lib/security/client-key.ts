import 'server-only';

import { createHmac } from 'node:crypto';

import { getDemoRateLimitSecret, trustsProxyHeaders } from '@/lib/config/env';

/**
 * Anonymous client fingerprint.
 *
 * The demo has no accounts, so the only thing left to attribute usage to is the
 * network the request came from. That is a weaker signal than a login, and it
 * is treated as one: it is used *only* to meter spend, never to authorise
 * anything and never to identify a person.
 *
 * Three rules follow from that.
 *
 *  1. **No raw IP is ever stored.** What reaches the database is
 *     `HMAC-SHA256(DEMO_RATE_LIMIT_SECRET, normalised ip)`, truncated. A plain
 *     `sha256(ip)` would be useless here -- IPv4 is 2^32 addresses, so an
 *     attacker with the table could simply enumerate them all and recover every
 *     address. Keying the hash with a server-side secret they do not have makes
 *     that impossible.
 *
 *  2. **No raw IP is ever returned.** The fingerprint never appears in a
 *     response body, header or error message; it exists only between this
 *     module and `demo_rate_limits`.
 *
 *  3. **Forwarded headers are not trusted by default.** `x-forwarded-for` is
 *     just a request header: if it were believed unconditionally, every limit
 *     here could be bypassed by sending a random one on each request -- strictly
 *     worse than no limit at all, because it would look like protection.
 */

/**
 * Headers that can carry the client address, most trustworthy first.
 *
 * `x-vercel-forwarded-for` is preferred because the Vercel edge sets it from
 * the connection it terminated and overwrites anything the client sent.
 * `x-forwarded-for` is the portable fallback.
 */
const IP_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for'] as const;

/**
 * The client address from an `X-Forwarded-For`-style value.
 *
 * The list is `client, proxy1, proxy2`, so the client is the left-most entry.
 * Reading the left-most entry is only sound because the caller has already
 * decided the header comes from a proxy that rewrites it (see
 * `trustsProxyHeaders`); on an untrusted path the whole header is ignored
 * rather than parsed differently.
 */
export function parseForwardedFor(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first ? first : null;
}

/**
 * Reduce an address to the unit that gets metered.
 *
 * IPv6 is truncated to its /64 prefix. A single residential IPv6 assignment is
 * routinely a /64 or larger, so metering a full 128-bit address would let one
 * machine evade every limit just by picking a new address out of its own
 * subnet. IPv4 is used whole.
 *
 * Returns `null` for anything that is not a plausible address, so that a junk
 * header cannot mint an unlimited supply of distinct buckets.
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // `[2001:db8::1]:443` -> `2001:db8::1`
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) value = bracketed[1];

  // IPv4 (optionally with a port), including the IPv4-mapped IPv6 form.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];

  const ipv4 = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/.exec(value);
  if (ipv4) {
    const octets = ipv4[1].split('.');
    if (octets.every((octet) => Number(octet) <= 255)) return octets.join('.');
    return null;
  }

  // IPv6: require it to look like one, then keep the first four groups (/64).
  if (!/^[0-9a-f:]+$/.test(value) || !value.includes(':')) return null;

  const [head, tail = ''] = value.split('::', 2);
  const headGroups = head ? head.split(':').filter(Boolean) : [];

  if (!value.includes('::')) {
    const groups = value.split(':');
    if (groups.length !== 8) return null;
    return `${groups.slice(0, 4).join(':')}::/64`;
  }

  const tailGroups = tail ? tail.split(':').filter(Boolean) : [];
  if (headGroups.length + tailGroups.length > 8) return null;

  const expanded = [
    ...headGroups,
    ...new Array<string>(8 - headGroups.length - tailGroups.length).fill('0'),
    ...tailGroups,
  ];

  return `${expanded.slice(0, 4).join(':')}::/64`;
}

/**
 * The address to meter, or `null` when none can be trusted.
 *
 * `null` is not a failure: it is the honest answer on a local `npm run dev`,
 * where there is no proxy and therefore no header worth reading. The caller
 * turns it into a single shared bucket, which is both correct for one developer
 * machine and fails *closed* -- an unrecognised deployment shares a budget
 * rather than handing every request its own.
 */
export function resolveClientIp(headers: Headers): string | null {
  if (!trustsProxyHeaders()) return null;

  for (const header of IP_HEADERS) {
    const normalized = normalizeClientIp(parseForwardedFor(headers.get(header)));
    if (normalized) return normalized;
  }

  return null;
}

/**
 * Irreversible fingerprint for one metering unit.
 *
 * The domain-separating prefix keeps this value from ever colliding with an
 * HMAC computed elsewhere over the same secret, and the version tag leaves room
 * to roll the scheme without ambiguity. 32 hex characters (128 bits) is far
 * more than enough to avoid collisions between the handful of clients a
 * portfolio demo sees, and keeps the index narrow.
 */
export function deriveClientKey(ip: string | null): string {
  const subject = ip ?? 'no-forwarded-ip';
  return createHmac('sha256', getDemoRateLimitSecret())
    .update(`rag-demo-client:v1:${subject}`)
    .digest('hex')
    .slice(0, 32);
}

/** The fingerprint for an incoming request. Never logged, never returned. */
export function resolveClientKey(request: Request): string {
  return deriveClientKey(resolveClientIp(request.headers));
}
