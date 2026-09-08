import { redirect } from 'next/navigation';

import { createServerSupabaseClient } from '@/lib/supabase/server';

// Reads the auth cookie, so it can never be a static page.
export const dynamic = 'force-dynamic';

/**
 * Root entry point.
 *
 * There is no marketing page: this is an internal tool, so the root simply
 * routes to the dashboard or to sign-in depending on session state.
 */
export default async function RootPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  redirect(user ? '/dashboard' : '/login');
}
