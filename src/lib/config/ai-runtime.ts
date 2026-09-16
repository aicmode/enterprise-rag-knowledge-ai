import 'server-only';

import { AppError } from '@/lib/errors';

/**
 * AI runtime mode -- the switch that decides whether this deployment is allowed
 * to talk to a paid AI provider at all.
 *
 * Why this exists
 * ---------------
 * The production deployment of this project is a **public portfolio demo**.
 * Anyone can open the URL, and every request is ultimately paid for by the
 * owner's OpenAI account. The demo quotas in `src/lib/security/` bound that
 * spend, but bounding a bill is not the same as not having one: a public URL
 * that can spend money is a public URL that *will* spend money.
 *
 * So the public deployment does not spend it at all. `AI_RUNTIME_MODE=demo`
 * makes every paid provider call a refusal at the provider layer, and the RAG
 * experience is served from a fixed sample corpus instead (`src/lib/demo/`).
 *
 * The three rules that make this safe
 * -----------------------------------
 *  1. **`demo` is the default.** An unset, empty, misspelled or otherwise
 *     unrecognised value resolves to `demo`. There is no input -- including no
 *     input at all -- that fails *open*.
 *  2. **The API key is never the switch.** `OPENAI_API_KEY` being present says
 *     nothing about whether it may be used. A deployment can hold a perfectly
 *     valid key and still never send a byte to OpenAI, which is exactly the
 *     state the public demo is in.
 *  3. **`live` is opt-in and must be complete.** Only an explicit
 *     `AI_RUNTIME_MODE=live` *and* a non-empty `OPENAI_API_KEY` permit a real
 *     call. `live` without a key is a configuration error reported by variable
 *     name, never by value.
 *
 * Nothing here is cached: the mode is a single string comparison, and reading
 * it fresh means a guard can never be evaluated against a stale snapshot taken
 * before the process was fully configured.
 */

export type AiRuntimeMode = 'demo' | 'live';

/** Name of the variable, used in log and error text. The value is never logged. */
export const AI_RUNTIME_MODE_ENV = 'AI_RUNTIME_MODE';

/** The mode used whenever the environment does not clearly ask for another. */
export const DEFAULT_AI_RUNTIME_MODE: AiRuntimeMode = 'demo';

export const AI_RUNTIME_MODES: readonly AiRuntimeMode[] = ['demo', 'live'];

/** Whether `raw` spells a mode this application recognises. */
export function isKnownAiRuntimeMode(raw: string | undefined | null): boolean {
  if (typeof raw !== 'string') return false;
  return (AI_RUNTIME_MODES as readonly string[]).includes(raw.trim().toLowerCase());
}

/**
 * Parse a raw environment value into a mode. Pure, so the fail-safe rules are
 * unit-testable without touching `process.env`.
 *
 * Only the exact string `live` (trimmed, case-insensitive) selects live mode.
 * Everything else -- `undefined`, `''`, `'demo'`, `'production'`, `'LIVE!'`,
 * `'true'` -- is `demo`.
 */
export function parseAiRuntimeMode(raw: string | undefined | null): AiRuntimeMode {
  if (typeof raw !== 'string') return DEFAULT_AI_RUNTIME_MODE;
  return raw.trim().toLowerCase() === 'live' ? 'live' : DEFAULT_AI_RUNTIME_MODE;
}

/**
 * Warn once per process about an unrecognised value.
 *
 * Silently treating a typo as `demo` is the safe behaviour, but it is also the
 * behaviour most likely to leave an operator wondering why `live` did nothing,
 * so it is said out loud -- by variable name only.
 */
let warnedAboutUnknownMode = false;

function warnOnceAboutUnknownMode(): void {
  if (warnedAboutUnknownMode) return;
  warnedAboutUnknownMode = true;
  console.warn(
    `[config] ${AI_RUNTIME_MODE_ENV} is set to an unrecognised value; falling back to '${DEFAULT_AI_RUNTIME_MODE}'. Valid values: ${AI_RUNTIME_MODES.join(', ')}.`,
  );
}

/** The mode this process is running in. */
export function getAiRuntimeMode(): AiRuntimeMode {
  const raw = process.env[AI_RUNTIME_MODE_ENV];

  if (typeof raw === 'string' && raw.trim() !== '' && !isKnownAiRuntimeMode(raw)) {
    warnOnceAboutUnknownMode();
  }

  return parseAiRuntimeMode(raw);
}

/** True when no paid AI provider may be called. */
export function isDemoAiRuntime(): boolean {
  return getAiRuntimeMode() === 'demo';
}

/** True when the operator has explicitly opted into real provider calls. */
export function isLiveAiRuntime(): boolean {
  return getAiRuntimeMode() === 'live';
}

/** Whether a usable API key is configured. Returns a boolean, never the key. */
export function hasOpenAIApiKey(): boolean {
  return (process.env.OPENAI_API_KEY?.trim().length ?? 0) > 0;
}

/**
 * The guard every paid provider call must pass.
 *
 * Called from the provider layer itself (`src/lib/rag/openai.ts` and each of
 * the embedding / answering / OCR entry points), not only from route handlers.
 * That placement is the point: a future route that forgets to check the mode
 * still cannot reach a billable API, because the client it would need refuses
 * to be constructed.
 *
 * @param operation short internal label for the log line, e.g. `embeddings`.
 */
export function assertLiveAiProviderAllowed(operation: string): void {
  const mode = getAiRuntimeMode();

  if (mode !== 'live') {
    throw new AppError('ai_demo_mode', {
      detail: `${operation} blocked: ${AI_RUNTIME_MODE_ENV}=${mode} forbids external AI provider calls`,
    });
  }

  if (!hasOpenAIApiKey()) {
    // Names the variable, never its value -- and says nothing about whether
    // some other secret is present.
    throw new AppError('ai_not_configured', {
      detail: `${operation} blocked: ${AI_RUNTIME_MODE_ENV}=live requires OPENAI_API_KEY to be set`,
    });
  }
}

/** Test seam: reset the once-per-process warning. */
export function resetAiRuntimeWarningsForTests(): void {
  warnedAboutUnknownMode = false;
}
