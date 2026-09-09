/**
 * Anonymous demo sessions.
 *
 * This deployment is a public portfolio demo, so there is deliberately no
 * sign-up, no password and no user table. What replaces them is a *demo
 * session*: an opaque UUID in an httpOnly cookie, minted by the proxy on the
 * first request and written into every row the visitor creates.
 *
 * That gives the two properties the product actually needs:
 *
 *  - **Zero friction.** Opening the public URL is enough to use the demo; there
 *    is nothing to fill in.
 *  - **Isolation anyway.** Two visitors do not see, cite or delete each other's
 *    PDFs and history, because every query is scoped by this id.
 *
 * The cookie is `httpOnly`, so page JavaScript cannot read it, and the id is a
 * v4 UUID, so it cannot be guessed. It is not an authentication credential and
 * nothing in the app treats it as one -- it partitions demo data, and that is
 * all it is claimed to do.
 */

export const DEMO_SESSION_COOKIE = 'rag_demo_session';

/** 30 days: long enough that a reviewer's uploads survive a coffee break. */
export const DEMO_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

/** Cookie attributes shared by the proxy and the reset endpoint. */
export function demoSessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    // Vercel serves the demo over HTTPS; local development over plain HTTP
    // would drop a `Secure` cookie entirely.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: DEMO_SESSION_MAX_AGE_SECONDS,
  };
}

/** Short label shown in the sidebar so a visitor can tell sessions apart. */
export function formatSessionLabel(sessionId: string): string {
  return sessionId.slice(0, 8);
}
