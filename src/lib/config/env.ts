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

/**
 * Validation is split by *what the caller actually needs*, not by what a fully
 * configured deployment happens to have.
 *
 * The two groups used to be one schema, which meant `getServerEnv()` demanded
 * an OpenAI key before it would hand back a Supabase URL. That coupling turned
 * a missing or rotated `OPENAI_API_KEY` into a 500 on operations that never
 * call OpenAI at all -- deleting a document, or asking a question while no
 * documents are registered yet. Losing the ability to answer questions is
 * expected when the model provider is unconfigured; losing the ability to
 * delete your own PDF is not.
 *
 * Each group is still validated at its point of use, so a genuinely
 * misconfigured deployment fails loudly on the first request that needs the
 * missing variable.
 */
const supabaseEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL must be a valid URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
});

const openAiEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
});

export type ServerEnv = z.infer<typeof supabaseEnvSchema> & { rag: RagConfig };

let cached: ServerEnv | null = null;
let cachedOpenAIKey: string | null = null;

/** Report a configuration problem by variable name, never by value. */
function configError(issues: { path: PropertyKey[] }[]): Error {
  const missing = issues.map((issue) => issue.path.join('.')).join(', ');
  return new Error(`Invalid server environment configuration: ${missing}`);
}

/**
 * Validate and return the Supabase-side server environment plus RAG tuning.
 *
 * Called lazily from request handlers rather than at module load so that
 * `next build` does not require production secrets to be present.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = supabaseEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (!parsed.success) {
    throw configError(parsed.error.issues);
  }

  cached = {
    ...parsed.data,
    rag: resolveRagConfig({
      RAG_CHUNK_SIZE: process.env.RAG_CHUNK_SIZE,
      RAG_CHUNK_OVERLAP: process.env.RAG_CHUNK_OVERLAP,
      RAG_TOP_K: process.env.RAG_TOP_K,
      RAG_SIMILARITY_THRESHOLD: process.env.RAG_SIMILARITY_THRESHOLD,
      OPENAI_CHAT_MODEL: process.env.OPENAI_CHAT_MODEL,
      OPENAI_OCR_MODEL: process.env.OPENAI_OCR_MODEL,
    }),
  };

  return cached;
}

/**
 * The OpenAI API key, validated on first use.
 *
 * Kept separate from `getServerEnv()` so that only the embedding and answering
 * paths depend on it.
 */
export function getOpenAIApiKey(): string {
  if (cachedOpenAIKey) return cachedOpenAIKey;

  const parsed = openAiEnvSchema.safeParse({ OPENAI_API_KEY: process.env.OPENAI_API_KEY });

  if (!parsed.success) {
    throw configError(parsed.error.issues);
  }

  cachedOpenAIKey = parsed.data.OPENAI_API_KEY;
  return cachedOpenAIKey;
}

/** RAG tuning as resolved from the environment. */
export function getRagConfig(): RagConfig {
  return getServerEnv().rag;
}
