'use client';

import { createBrowserClient } from '@supabase/ssr';

import { assertPublicEnv } from '@/lib/config/public-env';

/**
 * Browser Supabase client.
 *
 * Uses the anon key only. Every request it makes is subject to RLS, which is
 * what makes it safe to hand this client directly to the browser -- including
 * for the direct-to-Storage PDF upload.
 */
export function createClient() {
  const { supabaseUrl, supabaseAnonKey } = assertPublicEnv();
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
