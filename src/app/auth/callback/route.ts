import { NextResponse, type NextRequest } from 'next/server';

import { createServerSupabaseClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * Email-confirmation landing point.
 *
 * Supabase sends the user here with a one-time `code`; exchanging it sets the
 * session cookie. Done as a route handler (not a page) so the cookie is written
 * on a real response before any redirect.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  const next = searchParams.get('next');

  // Only relative internal paths, so this cannot be turned into an open redirect.
  const destination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth/callback] code exchange failed', error.message);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  return NextResponse.redirect(`${origin}${destination}`);
}
