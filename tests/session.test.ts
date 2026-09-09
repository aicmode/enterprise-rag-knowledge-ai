import { describe, expect, it } from 'vitest';

import {
  createSessionId,
  DEMO_SESSION_COOKIE,
  demoSessionCookieOptions,
  formatSessionLabel,
  isValidSessionId,
} from '@/lib/session';

/**
 * Demo session identity.
 *
 * With no accounts in this deployment, this cookie is the only thing keeping
 * one visitor's uploads and history away from another's, so the rules about
 * what counts as a valid id are worth pinning down.
 */
describe('isValidSessionId', () => {
  it('accepts a generated id', () => {
    expect(isValidSessionId(createSessionId())).toBe(true);
  });

  it('rejects anything that is not a UUID', () => {
    // A caller who forges the cookie must not be able to smuggle SQL, a path
    // segment, or another session's partial id through it.
    for (const value of [
      undefined,
      null,
      '',
      'not-a-uuid',
      "' or 1=1 --",
      '../../etc/passwd',
      '11111111-2222-3333-4444-55555555555', // one char short
      '11111111-2222-3333-4444-5555555555555',
    ]) {
      expect(isValidSessionId(value)).toBe(false);
    }
  });

  it('mints a different id every time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => createSessionId()));

    expect(ids.size).toBe(50);
  });
});

describe('demoSessionCookieOptions', () => {
  it('keeps the cookie out of reach of page scripts', () => {
    const options = demoSessionCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
    expect(options.path).toBe('/');
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it('uses a stable cookie name', () => {
    expect(DEMO_SESSION_COOKIE).toBe('rag_demo_session');
  });
});

describe('formatSessionLabel', () => {
  it('shows only a short prefix, never the whole id', () => {
    const id = '11111111-2222-4333-8444-555555555555';

    expect(formatSessionLabel(id)).toBe('11111111');
    expect(formatSessionLabel(id).length).toBeLessThan(id.length);
  });
});
