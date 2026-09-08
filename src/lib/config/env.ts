import 'server-only';

import { z } from 'zod';

import { resolveRagConfig, type RagConfig } from './rag';

/**
 * Server-side environment access.
 *
 * `import 'server-only'` makes it a *build error* for a Client Component to
 * pull this file into the browser bundle, so the service-role key and the
 * OpenAI key cannot leak by accident during a refactor. Public values live in
 * `publicEnv` below and are the only ones safe to reference from client code.
 */

const serverEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
});

export type ServerEnv = z.infer<typeof serverEnvSchema> & { rag: RagConfig };

let cached: ServerEnv | null = null;

/**
 * Validate and return the server environment.
 *
 * Called lazily from request handlers rather than at module load so that
 * `next build` does not require production secrets to be present.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    // The message names variables, never values.
    throw new Error(`Invalid server environment configuration: ${missing}`);
  }

  cached = {
    ...parsed.data,
    rag: resolveRagConfig({
      RAG_CHUNK_SIZE: process.env.RAG_CHUNK_SIZE,
      RAG_CHUNK_OVERLAP: process.env.RAG_CHUNK_OVERLAP,
      RAG_TOP_K: process.env.RAG_TOP_K,
      RAG_SIMILARITY_THRESHOLD: process.env.RAG_SIMILARITY_THRESHOLD,
      OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
    }),
  };

  return cached;
}

/** RAG tuning as resolved from the environment. */
export function getRagConfig(): RagConfig {
  return getServerEnv().rag;
}
