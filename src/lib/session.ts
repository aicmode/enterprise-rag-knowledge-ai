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
 * What actually provides that isolation is the id itself: a v4 UUID carries 122
 * bits of randomness, so one visitor cannot arrive at another's id, and every
 * query is scoped by it.
 *
 * `httpOnly` and `SameSite=Lax` are set as well, but it is worth being precise
 * about what they do, because it is easy to overstate. `httpOnly` stops page
 * JavaScript -- including injected script -- from *reading* the value; it does
 * not make the value unforgeable. Anyone can send whatever cookie they like
 * from outside a browser, and every visitor is free to delete or replace their
 * own. The isolation rests on unguessability and on session-scoped queries, not
 * on the cookie flags.
 *
 * The flags are also why this id is not signed. A signature would prove the
 * server issued the value, but anyone may request a fresh one, and no other
 * visitor's id can be guessed, so signing would close no attack -- only add
 * moving parts.
 *
 * It is not an authentication credential and nothing in the app treats it as
 * one. In particular, nothing that costs money is metered against it: because a
 * visitor controls this cookie, a quota counted per session resets whenever
 * they want it to. Those live in `src/lib/security/` and are keyed on an
 * anonymous client fingerprint instead.
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
