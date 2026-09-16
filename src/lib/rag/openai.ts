import 'server-only';

import OpenAI from 'openai';

import { assertLiveAiProviderAllowed } from '@/lib/config/ai-runtime';
import { getOpenAIApiKey } from '@/lib/config/env';

/**
 * Shared OpenAI client.
 *
 * Server-only by construction: the key is read from `getOpenAIApiKey()`, which
 * is itself `server-only`, so there is no path by which `OPENAI_API_KEY` reaches
 * the browser bundle. The browser never talks to OpenAI directly -- it talks to
 * our own route handlers, which are authenticated.
 *
 * **This function is the chokepoint for billable traffic.** Every OpenAI call
 * in the application -- embeddings, answering, OCR -- needs the client it
 * returns, so the runtime-mode guard is placed here rather than only in the
 * route handlers that happen to exist today. In `AI_RUNTIME_MODE=demo` there is
 * no client to be had, which means a route added next year cannot spend money
 * by forgetting a check: the failure mode of a missing guard is a refusal, not
 * a bill.
 *
 * The guard runs *before* the memoised instance is handed back, so a client
 * constructed earlier in the process cannot be reused past a refusal.
 */
let client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  assertLiveAiProviderAllowed('openai_client');

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
