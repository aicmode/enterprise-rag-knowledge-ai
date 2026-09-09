// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server environment validation.
 *
 * The point of these tests is the *split*: Supabase configuration and OpenAI
 * configuration are validated independently. An integration run against a real
 * Supabase instance with no `OPENAI_API_KEY` showed why it matters -- deleting
 * a document (`createAdminClient` -> `getServerEnv`) and asking a question with
 * no documents registered (`getRagConfig` -> `getServerEnv`) both returned a
 * 500, even though neither operation calls OpenAI.
 *
 * The module caches after its first successful parse, so every test resets the
 * module registry and re-imports.
 */

const SUPABASE_VARS = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
};

const ORIGINAL = { ...process.env };

async function loadEnvModule() {
  vi.resetModules();
  return import('@/lib/config/env');
}

beforeEach(() => {
  for (const key of [
    ...Object.keys(SUPABASE_VARS),
    'OPENAI_API_KEY',
    'OPENAI_CHAT_MODEL',
    'OPENAI_OCR_MODEL',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('getServerEnv', () => {
  it('resolves Supabase configuration without an OpenAI key present', async () => {
    Object.assign(process.env, SUPABASE_VARS);

    const { getServerEnv } = await loadEnvModule();
    const env = getServerEnv();

    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe(SUPABASE_VARS.NEXT_PUBLIC_SUPABASE_URL);
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(SUPABASE_VARS.SUPABASE_SERVICE_ROLE_KEY);
  });

  it('still resolves RAG tuning without an OpenAI key present', async () => {
    Object.assign(process.env, SUPABASE_VARS, {
      RAG_TOP_K: '7',
      OPENAI_OCR_MODEL: 'gpt-5-mini-test',
    });

    const { getRagConfig } = await loadEnvModule();

    expect(getRagConfig().topK).toBe(7);
    expect(getRagConfig().ocrModel).toBe('gpt-5-mini-test');
  });

  it('names the missing Supabase variables and never their values', async () => {
    Object.assign(process.env, {
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_VARS.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-value',
    });

    const { getServerEnv } = await loadEnvModule();

    expect(() => getServerEnv()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => getServerEnv()).not.toThrow(/anon-key-value/);
  });

  it('rejects a Supabase URL that is not a URL', async () => {
    Object.assign(process.env, SUPABASE_VARS, { NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' });

    const { getServerEnv } = await loadEnvModule();

    expect(() => getServerEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe('getOpenAIApiKey', () => {
  it('returns the key when it is configured', async () => {
    Object.assign(process.env, SUPABASE_VARS, { OPENAI_API_KEY: 'openai-key' });

    const { getOpenAIApiKey } = await loadEnvModule();

    expect(getOpenAIApiKey()).toBe('openai-key');
  });

  it('throws naming OPENAI_API_KEY when it is missing', async () => {
    Object.assign(process.env, SUPABASE_VARS);

    const { getOpenAIApiKey } = await loadEnvModule();

    expect(() => getOpenAIApiKey()).toThrow(/OPENAI_API_KEY/);
  });

  it('is independent of Supabase configuration', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';

    const { getOpenAIApiKey, getServerEnv } = await loadEnvModule();

    expect(getOpenAIApiKey()).toBe('openai-key');
    expect(() => getServerEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});
