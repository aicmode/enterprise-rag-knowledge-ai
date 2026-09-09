import 'server-only';

import { z } from 'zod';

import { resolveRagConfig, type RagConfig } from './rag';

/**
 * Server-side environment access.
 *
 * `import 'server-only'` makes it a *build error* for a Client Component to
 * pull this file into the browser bundle, so the database URL and the OpenAI
 * key cannot leak by accident during a refactor. This application has no
 * `NEXT_PUBLIC_*` variables at all: the browser talks only to this app's own
 * route handlers, never directly to Postgres or OpenAI.
 */

/**
 * Validation is split by *what the caller actually needs*, not by what a fully
 * configured deployment happens to have.
 *
 * The two groups used to be one schema, which meant the database URL could not
 * be read back without an OpenAI key also being present. That coupling turned a
 * missing or rotated `OPENAI_API_KEY` into a 500 on operations that never call
 * OpenAI at all -- deleting a document, or asking a question while no documents
 * are registered yet. Losing the ability to answer questions is expected when
 * the model provider is unconfigured; losing the ability to delete your own PDF
 * is not.
 *
 * Each group is still validated at its point of use, so a genuinely
 * misconfigured deployment fails loudly on the first request that needs the
 * missing variable.
 */
const databaseEnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required')
    .refine(
      (value) => /^postgres(ql)?:\/\//.test(value),
      'DATABASE_URL must be a postgres:// connection string',
    ),
});

const openAiEnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
});

export type ServerEnv = z.infer<typeof databaseEnvSchema> & { rag: RagConfig };

let cached: ServerEnv | null = null;
let cachedOpenAIKey: string | null = null;

/** Report a configuration problem by variable name, never by value. */
function configError(issues: { path: PropertyKey[] }[]): Error {
  const missing = issues.map((issue) => issue.path.join('.')).join(', ');
  return new Error(`Invalid server environment configuration: ${missing}`);
}

/**
 * Validate and return the database-side server environment plus RAG tuning.
 *
 * Called lazily from request handlers rather than at module load so that
 * `next build` does not require production secrets to be present.
 */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = databaseEnvSchema.safeParse({ DATABASE_URL: process.env.DATABASE_URL });

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

/** The Postgres connection string, validated on first use. */
export function getDatabaseUrl(): string {
  return getServerEnv().DATABASE_URL;
}

/**
 * The OpenAI API key, validated on first use.
 *
 * Kept separate from `getServerEnv()` so that only the embedding, OCR and
 * answering paths depend on it.
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
