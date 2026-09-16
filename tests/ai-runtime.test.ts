import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertLiveAiProviderAllowed,
  getAiRuntimeMode,
  hasOpenAIApiKey,
  isDemoAiRuntime,
  isLiveAiRuntime,
  parseAiRuntimeMode,
  resetAiRuntimeWarningsForTests,
} from '@/lib/config/ai-runtime';
import { AppError } from '@/lib/errors';

/**
 * The runtime-mode switch.
 *
 * These tests exist because the cost of getting this wrong is asymmetric. A
 * bug that refuses a call the operator wanted is an annoyance; a bug that
 * *allows* one they did not is a bill on a public URL. So the assertions are
 * mostly about what does **not** enable live mode: no value, a blank value, a
 * misspelling, a truthy-looking string, and -- the one that matters most -- the
 * mere presence of an API key.
 */

const TOUCHED = ['AI_RUNTIME_MODE', 'OPENAI_API_KEY'] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED) delete process.env[key];
  resetAiRuntimeWarningsForTests();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('parseAiRuntimeMode', () => {
  it('defaults to demo when nothing is configured', () => {
    expect(parseAiRuntimeMode(undefined)).toBe('demo');
    expect(parseAiRuntimeMode(null)).toBe('demo');
    expect(parseAiRuntimeMode('')).toBe('demo');
    expect(parseAiRuntimeMode('   ')).toBe('demo');
  });

  it('accepts live only as an exact word, ignoring case and surrounding space', () => {
    expect(parseAiRuntimeMode('live')).toBe('live');
    expect(parseAiRuntimeMode('LIVE')).toBe('live');
    expect(parseAiRuntimeMode('  Live  ')).toBe('live');
  });

  it('falls back to demo for every unrecognised value', () => {
    // Each of these is a plausible typo or a value someone might assume works.
    for (const raw of ['demo', 'production', 'prod', 'true', '1', 'on', 'liveish', 'live!', 'LIVE=1']) {
      expect(parseAiRuntimeMode(raw)).toBe('demo');
    }
  });
});

describe('getAiRuntimeMode', () => {
  it('is demo when the variable is absent', () => {
    expect(getAiRuntimeMode()).toBe('demo');
    expect(isDemoAiRuntime()).toBe(true);
    expect(isLiveAiRuntime()).toBe(false);
  });

  it('is demo even when a valid-looking API key is present', () => {
    // The central rule: a key is a credential, not a permission.
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    expect(hasOpenAIApiKey()).toBe(true);
    expect(getAiRuntimeMode()).toBe('demo');
  });

  it('is live only when explicitly asked', () => {
    process.env.AI_RUNTIME_MODE = 'live';
    expect(getAiRuntimeMode()).toBe('live');
  });

  it('warns once, by variable name, about an unrecognised value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_RUNTIME_MODE = 'prod';

    expect(getAiRuntimeMode()).toBe('demo');
    expect(getAiRuntimeMode()).toBe('demo');

    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain('AI_RUNTIME_MODE');
    // The offending value is not echoed back into the log.
    expect(message).not.toContain('prod');
  });

  it('does not warn about a blank value, which is just "unset"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_RUNTIME_MODE = '  ';

    expect(getAiRuntimeMode()).toBe('demo');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('assertLiveAiProviderAllowed', () => {
  it('refuses in demo mode', () => {
    expect(() => assertLiveAiProviderAllowed('embeddings')).toThrow(AppError);

    try {
      assertLiveAiProviderAllowed('embeddings');
    } catch (error) {
      expect(error).toMatchObject({ code: 'ai_demo_mode', status: 503 });
    }
  });

  it('refuses in demo mode even with a key configured', () => {
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    expect(() => assertLiveAiProviderAllowed('chat_completions')).toThrow(
      expect.objectContaining({ code: 'ai_demo_mode' }),
    );
  });

  it('reports live-without-a-key as configuration, naming the variable only', () => {
    process.env.AI_RUNTIME_MODE = 'live';

    try {
      assertLiveAiProviderAllowed('ocr_vision');
      throw new Error('should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('ai_not_configured');
      // Internal detail names the variable; the user-facing message carries no
      // configuration internals at all.
      expect(appError.message).toContain('OPENAI_API_KEY');
      expect(appError.userMessage).not.toContain('OPENAI_API_KEY');
      expect(appError.userMessage).not.toContain('AI_RUNTIME_MODE');
    }
  });

  it('treats a whitespace-only key as absent', () => {
    process.env.AI_RUNTIME_MODE = 'live';
    process.env.OPENAI_API_KEY = '   ';

    expect(hasOpenAIApiKey()).toBe(false);
    expect(() => assertLiveAiProviderAllowed('embeddings')).toThrow(
      expect.objectContaining({ code: 'ai_not_configured' }),
    );
  });

  it('permits the call only with live plus a key', () => {
    process.env.AI_RUNTIME_MODE = 'live';
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    expect(() => assertLiveAiProviderAllowed('embeddings')).not.toThrow();
  });
});
