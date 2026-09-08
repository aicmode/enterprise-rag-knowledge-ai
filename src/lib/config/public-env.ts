/**
 * The only environment values that may cross into the browser bundle.
 *
 * Next.js inlines `NEXT_PUBLIC_*` at build time, so these must be referenced as
 * full static property accesses (not `process.env[key]`) for the replacement to
 * happen. Anything secret belongs in `./env.ts`, which is `server-only`.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
} as const;

export function assertPublicEnv(): { supabaseUrl: string; supabaseAnonKey: string } {
  if (!publicEnv.supabaseUrl || !publicEnv.supabaseAnonKey) {
    throw new Error(
      'Supabase public environment is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.',
    );
  }
  return { supabaseUrl: publicEnv.supabaseUrl, supabaseAnonKey: publicEnv.supabaseAnonKey };
}
