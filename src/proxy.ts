import { NextResponse, type NextRequest } from 'next/server';

import {
  createSessionId,
  demoSessionCookieOptions,
  DEMO_SESSION_COOKIE,
  isValidSessionId,
} from '@/lib/session';

/**
 * Edge proxy (formerly "middleware").
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`; the exported
 * function must be named `proxy`.
 *
 * Its only job here is to guarantee that every request -- page navigation and
 * API call alike -- arrives with a valid demo session cookie. This is the one
 * place that can both read the incoming cookie and write it back on the
 * response, which is why it lives in the proxy rather than in a layout: Server
 * Components are not allowed to set cookies, so a session minted there would be
 * forgotten before the next request.
 *
 * Setting the cookie on `request` as well as on `response` means the very first
 * request already sees its own session, instead of rendering an empty page and
 * only working from the second navigation onward.
 */
export function proxy(request: NextRequest) {
  const existing = request.cookies.get(DEMO_SESSION_COOKIE)?.value;

  if (isValidSessionId(existing)) {
    return NextResponse.next();
  }

  const sessionId = createSessionId();
  request.cookies.set(DEMO_SESSION_COOKIE, sessionId);

  const response = NextResponse.next({ request });
  response.cookies.set(DEMO_SESSION_COOKIE, sessionId, demoSessionCookieOptions());

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on every path except static assets and image files. The session
     * cookie has to exist before the first navigation *and* before the first
     * API call, so the matcher is broad by design.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
