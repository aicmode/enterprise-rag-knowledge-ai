import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { assertPublicEnv } from '@/lib/config/public-env';

/** Routes that require a signed-in user. */
const PROTECTED_PREFIXES = ['/dashboard', '/documents', '/ask', '/history'];

/** Routes that a signed-in user should not see. */
const AUTH_ROUTES = ['/login', '/register'];

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function isAuthPath(pathname: string): boolean {
  return AUTH_ROUTES.includes(pathname);
}

/**
 * Refresh the Supabase session cookie on every request and gate protected
 * routes.
 *
 * Running this in middleware is what keeps a long-lived tab working: without
 * it the access token silently expires and Server Components start seeing an
 * anonymous user. When refresh fails (expired / revoked session) the user is
 * redirected to /login with a `redirectedFrom` hint so they land back where
 * they were.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const { supabaseUrl, supabaseAnonKey } = assertPublicEnv();

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the token with the Auth server; do not replace this
  // with getSession(), which would trust a possibly-stale cookie.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  if (!user && isProtectedPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/login';
    redirectUrl.search = '';
    redirectUrl.searchParams.set('redirectedFrom', pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (user && isAuthPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = '/dashboard';
    redirectUrl.search = '';
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
