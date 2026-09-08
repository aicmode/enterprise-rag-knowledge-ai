import 'server-only';

import OpenAI from 'openai';

import { getServerEnv } from '@/lib/config/env';

/**
 * Shared OpenAI client.
 *
 * Server-only by construction: the key is read from `getServerEnv()`, which is
 * itself `server-only`, so there is no path by which `OPENAI_API_KEY` reaches
 * the browser bundle. The browser never talks to OpenAI directly -- it talks to
 * our own route handlers, which are authenticated.
 */
let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (client) return client;

  const env = getServerEnv();
  client = new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    // Ingestion of a 100-page PDF is long-running; fail slow rather than
    // half-way.
    timeout: 60_000,
    maxRetries: 2,
  });

  return client;
}
