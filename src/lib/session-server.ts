import 'server-only';

import { cookies } from 'next/headers';

import { AppError } from '@/lib/errors';
import { DEMO_SESSION_COOKIE, isValidSessionId } from '@/lib/session';

/**
 * Resolve the current demo session id, server-side.
 *
 * The proxy guarantees the cookie exists (and is a valid UUID) before any page
 * or route handler runs, so a missing cookie here means the request bypassed
 * the proxy entirely. Rather than silently minting an id -- which a Server
 * Component cannot persist anyway, and which would hand the visitor a session
 * that disappears on the next request -- both cases are reported to the caller.
 */
export async function getSessionId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(DEMO_SESSION_COOKIE)?.value;
  return isValidSessionId(value) ? value : null;
}

/**
 * The demo session id, or a `session_unavailable` failure.
 *
 * Used by route handlers, which must not write rows that no visitor can ever
 * read back.
 */
export async function requireSessionId(): Promise<string> {
  const sessionId = await getSessionId();

  if (!sessionId) {
    throw new AppError('session_unavailable', { detail: 'demo session cookie missing or invalid' });
  }

  return sessionId;
}
