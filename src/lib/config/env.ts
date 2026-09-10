import 'server-only';

import { randomBytes } from 'node:crypto';

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
let cachedRateLimitSecret: string | null = null;

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

/**
 * Secret keying the anonymous client fingerprint used by the demo rate limits.
 *
 * Why a secret at all: the fingerprint is derived from the visitor's IP, and an
 * unkeyed `sha256(ip)` is not anonymous -- the entire IPv4 space is 2^32
 * hashes, so anyone holding the table could enumerate it and recover every
 * address. An HMAC under a key that never leaves the server cannot be reversed
 * that way.
 *
 * When the variable is absent the process falls back to a random per-instance
 * secret. That keeps `npm run dev`, `next build` and the test suite working
 * with no configuration, and it still produces working limits -- they simply do
 * not survive a restart or span two serverless instances. Production is warned
 * about it loudly rather than silently downgraded, and the warning names the
 * variable, never a value.
 */
export function getDemoRateLimitSecret(): string {
  if (cachedRateLimitSecret) return cachedRateLimitSecret;

  const configured = process.env.DEMO_RATE_LIMIT_SECRET?.trim();

  if (configured && configured.length >= 16) {
    cachedRateLimitSecret = configured;
    return cachedRateLimitSecret;
  }

  console.warn(
    configured
      ? '[config] DEMO_RATE_LIMIT_SECRET is too short (min 16 chars); using an ephemeral per-instance secret. Demo rate limits will not persist across restarts.'
      : '[config] DEMO_RATE_LIMIT_SECRET is not set; using an ephemeral per-instance secret. Demo rate limits will not persist across restarts.',
  );

  cachedRateLimitSecret = randomBytes(32).toString('hex');
  return cachedRateLimitSecret;
}

/**
 * Whether forwarded client-IP headers may be believed.
 *
 * `x-forwarded-for` is an ordinary request header. Trusting it on a host that
 * does not overwrite it would make every IP-based limit *worse* than having
 * none, because a fresh value on each request would look like a fresh client.
 *
 * So it is trusted only where something upstream is known to rewrite it:
 * Vercel (which sets `VERCEL=1` in every runtime and terminates the connection
 * at its edge), or an operator who has explicitly said so with
 * `DEMO_TRUST_PROXY_HEADERS=1` because they run behind their own proxy.
 */
export function trustsProxyHeaders(): boolean {
  const override = process.env.DEMO_TRUST_PROXY_HEADERS?.trim();
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;
  return process.env.VERCEL === '1';
}

/** RAG tuning as resolved from the environment. */
export function getRagConfig(): RagConfig {
  return getServerEnv().rag;
}
