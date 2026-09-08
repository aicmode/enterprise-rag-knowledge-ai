import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { getServerEnv } from '@/lib/config/env';

/**
 * Service-role Supabase client. **Bypasses RLS.**
 *
 * Deliberately narrow in scope. It is used only where the operation must
 * succeed independently of the caller's session, and always *after* ownership
 * has already been verified with the user-scoped client:
 *
 *  - reading the uploaded PDF back out of the private bucket during processing
 *  - writing `document_chunks` and flipping `documents.status`
 *  - deleting Storage objects when a document is removed
 *
 * `import 'server-only'` plus the absence of a `NEXT_PUBLIC_` prefix on the key
 * means this module cannot end up in the client bundle.
 */
export function createAdminClient() {
  const env = getServerEnv();

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
