import 'server-only';

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

import { assertPublicEnv } from '@/lib/config/public-env';
import { AppError } from '@/lib/errors';

/**
 * Request-scoped Supabase client that acts *as the signed-in user*.
 *
 * This is the client used for essentially all application data access,
 * including vector search, so RLS applies to every query. The service-role
 * client (`./admin.ts`) is reserved for the few operations that genuinely need
 * to bypass it.
 */
export async function createServerSupabaseClient() {
  const { supabaseUrl, supabaseAnonKey } = assertPublicEnv();
  const cookieStore = await cookies();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot mutate cookies. Session refresh is handled
          // by the middleware, so ignoring this is safe and expected.
        }
      },
    },
  });
}

/**
 * Resolve the authenticated user or throw.
 *
 * Always uses `getUser()` (which validates the JWT against the Auth server)
 * rather than `getSession()` (which trusts the cookie). Server-side
 * authorization decisions must never be made from an unverified cookie.
 */
export async function requireUser() {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    throw new AppError('unauthorized', { cause: error, detail: 'no authenticated user' });
  }

  return { supabase, user: data.user };
}
