// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The anonymous client fingerprint.
 *
 * This is the only thing standing between the demo's OpenAI budget and a script
 * that deletes its cookie between requests, so the properties below are the
 * whole point of the module:
 *
 *  - a forwarded header is believed only where something upstream rewrites it,
 *  - the stored value is keyed by a server-side secret and cannot be walked
 *    back to an address,
 *  - and the same client keeps the same key across sessions, cookies and time.
 *
 * The env module caches its secret after first use, so every test re-imports
 * through a fresh module registry.
 */

const SECRET = 'test-demo-rate-limit-secret-value';
const ORIGINAL = { ...process.env };

async function load(env: Record<string, string | undefined> = {}) {
  vi.resetModules();

  process.env.DEMO_RATE_LIMIT_SECRET = SECRET;
  process.env.DEMO_TRUST_PROXY_HEADERS = '1';
  delete process.env.VERCEL;

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  return import('@/lib/security/client-key');
}

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

beforeEach(() => {
  delete process.env.VERCEL;
  delete process.env.DEMO_TRUST_PROXY_HEADERS;
  delete process.env.DEMO_RATE_LIMIT_SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
});

describe('parseForwardedFor', () => {
  it('takes the client, not the proxy, from an X-Forwarded-For chain', async () => {
    const { parseForwardedFor } = await load();

    expect(parseForwardedFor('203.0.113.9, 70.41.3.18, 150.172.238.178')).toBe('203.0.113.9');
    expect(parseForwardedFor('  203.0.113.9  ')).toBe('203.0.113.9');
  });

  it('returns null for nothing at all', async () => {
    const { parseForwardedFor } = await load();

    for (const value of [null, undefined, '', '   ', ',']) {
      expect(parseForwardedFor(value)).toBeNull();
    }
  });
});

describe('normalizeClientIp', () => {
  it('keeps an IPv4 address whole, without its port', async () => {
    const { normalizeClientIp } = await load();

    expect(normalizeClientIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normalizeClientIp('203.0.113.9:44321')).toBe('203.0.113.9');
    expect(normalizeClientIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });

  it('meters IPv6 by its /64, so one host cannot mint new identities', async () => {
    const { normalizeClientIp } = await load();

    // A residential IPv6 allocation is a /64 or larger. Metering the full
    // address would let a single machine pick a fresh one per request.
    const a = normalizeClientIp('2001:db8:85a3:1::8a2e:370:7334');
    const b = normalizeClientIp('2001:db8:85a3:1::dead:beef:1');

    expect(a).toBe(b);
    expect(a).toContain('/64');

    // A different /64 is a different client.
    expect(normalizeClientIp('2001:db8:85a3:2::1')).not.toBe(a);
  });

  it('strips brackets and ports from an IPv6 literal', async () => {
    const { normalizeClientIp } = await load();

    expect(normalizeClientIp('[2001:db8:85a3:1::1]:8443')).toBe(
      normalizeClientIp('2001:db8:85a3:1::1'),
    );
  });

  it('rejects junk instead of turning it into a fresh bucket', async () => {
    const { normalizeClientIp } = await load();

    // If garbage produced a distinct bucket, a random header per request would
    // be an unlimited supply of empty quotas.
    for (const value of [
      null,
      '',
      'not-an-ip',
      'unknown',
      '999.1.1.1',
      '203.0.113.9.7',
      "'; drop table demo_rate_limits; --",
      '<script>',
    ]) {
      expect(normalizeClientIp(value)).toBeNull();
    }
  });
});

describe('resolveClientIp', () => {
  it('ignores forwarded headers when nothing upstream rewrites them', async () => {
    // The default on an unrecognised host. Believing the header here would be
    // worse than having no limit, because a new value per request looks like a
    // new client.
    const { resolveClientIp } = await load({ DEMO_TRUST_PROXY_HEADERS: '0' });

    expect(
      resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' })),
    ).toBeNull();
  });

  it('trusts them on Vercel, which sets the header at its own edge', async () => {
    const { resolveClientIp } = await load({ DEMO_TRUST_PROXY_HEADERS: undefined, VERCEL: '1' });

    expect(resolveClientIp(headers({ 'x-forwarded-for': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('prefers the platform header over the portable one', async () => {
    const { resolveClientIp } = await load();

    expect(
      resolveClientIp(
        headers({
          'x-vercel-forwarded-for': '203.0.113.9',
          'x-forwarded-for': '198.51.100.7',
        }),
      ),
    ).toBe('203.0.113.9');
  });

  it('falls through a junk header to the next one', async () => {
    const { resolveClientIp } = await load();

    expect(
      resolveClientIp(
        headers({ 'x-vercel-forwarded-for': 'unknown', 'x-forwarded-for': '198.51.100.7' }),
      ),
    ).toBe('198.51.100.7');
  });

  it('returns null when there is no header at all', async () => {
    const { resolveClientIp } = await load();

    expect(resolveClientIp(headers({}))).toBeNull();
  });
});

describe('deriveClientKey', () => {
  it('never contains the address it was derived from', async () => {
    const { deriveClientKey } = await load();

    const key = deriveClientKey('203.0.113.9');

    expect(key).not.toContain('203');
    expect(key).not.toContain('203.0.113.9');
    expect(/^[0-9a-f]{32}$/.test(key)).toBe(true);
  });

  it('is stable for the same client, so a new cookie changes nothing', async () => {
    const { deriveClientKey } = await load();

    // This is the whole defence against reset-and-retry: the key does not
    // depend on the session id, the cookie, or the request.
    expect(deriveClientKey('203.0.113.9')).toBe(deriveClientKey('203.0.113.9'));
  });

  it('separates different clients', async () => {
    const { deriveClientKey } = await load();

    expect(deriveClientKey('203.0.113.9')).not.toBe(deriveClientKey('198.51.100.7'));
    expect(deriveClientKey(null)).not.toBe(deriveClientKey('203.0.113.9'));
  });

  it('is keyed by the server secret, not by the address alone', async () => {
    // An unkeyed sha256(ip) would be reversible by enumerating IPv4. Changing
    // only the secret must change every key.
    const withSecretA = await load();
    const keyA = withSecretA.deriveClientKey('203.0.113.9');

    const withSecretB = await load({ DEMO_RATE_LIMIT_SECRET: 'a-completely-different-secret' });
    const keyB = withSecretB.deriveClientKey('203.0.113.9');

    expect(keyA).not.toBe(keyB);
  });

  it('does not match a plain sha256 of the address', async () => {
    const { createHash } = await import('node:crypto');
    const { deriveClientKey } = await load();

    const naive = createHash('sha256').update('203.0.113.9').digest('hex');

    expect(deriveClientKey('203.0.113.9')).not.toBe(naive.slice(0, 32));
  });
});

describe('resolveClientKey', () => {
  it('derives from the request headers alone, never from a cookie', async () => {
    const { resolveClientKey, deriveClientKey } = await load();

    const request = new Request('https://demo.example/api/ask', {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.9',
        // A caller controls their own cookie completely; it must not influence
        // the key, or the limit would reset with the session.
        cookie: 'rag_demo_session=11111111-2222-4333-8444-555555555555',
      },
    });

    expect(resolveClientKey(request)).toBe(deriveClientKey('203.0.113.9'));
  });

  it('gives two cookie-less requests from one address the same key', async () => {
    const { resolveClientKey } = await load();

    const make = () =>
      new Request('https://demo.example/api/ask', {
        method: 'POST',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });

    expect(resolveClientKey(make())).toBe(resolveClientKey(make()));
  });
});
