import 'server-only';

import OpenAI from 'openai';

import { getOpenAIApiKey } from '@/lib/config/env';

/**
 * Shared OpenAI client.
 *
 * Server-only by construction: the key is read from `getOpenAIApiKey()`, which
 * is itself `server-only`, so there is no path by which `OPENAI_API_KEY` reaches
 * the browser bundle. The browser never talks to OpenAI directly -- it talks to
 * our own route handlers, which are authenticated.
 */
let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (client) return client;

  client = new OpenAI({
    apiKey: getOpenAIApiKey(),
    // Ingestion of a 100-page PDF is long-running; fail slow rather than
    // half-way.
    timeout: 60_000,
    maxRetries: 2,
  });

  return client;
}
