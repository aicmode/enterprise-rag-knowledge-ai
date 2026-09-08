import type { NextRequest } from 'next/server';

import { updateSession } from '@/lib/supabase/proxy-session';

/**
 * Edge proxy (formerly "middleware").
 *
 * Next.js 16 renamed the `middleware` file convention to `proxy`; the exported
 * function must be named `proxy`. Behaviour is unchanged -- it refreshes the
 * Supabase auth cookie on every navigation and gates the protected routes.
 */
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Run on every path except static assets and image files. Auth cookie
     * refresh has to happen on navigations, so the matcher is broad by design.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
