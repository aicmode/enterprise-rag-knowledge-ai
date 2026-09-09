// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Server environment validation.
 *
 * The point of these tests is the *split*: database configuration and OpenAI
 * configuration are validated independently. An integration run against a real
 * database with no `OPENAI_API_KEY` showed why it matters -- deleting a
 * document and asking a question with no documents registered both returned a
 * 500, even though neither operation calls OpenAI.
 *
 * The module caches after its first successful parse, so every test resets the
 * module registry and re-imports.
 */

const DATABASE_VARS = {
  DATABASE_URL: 'postgresql://user:pass@db.example.com/ragdb',
};

const ORIGINAL = { ...process.env };

async function loadEnvModule() {
  vi.resetModules();
  return import('@/lib/config/env');
}

beforeEach(() => {
  for (const key of [
    ...Object.keys(DATABASE_VARS),
    'OPENAI_API_KEY',
    'OPENAI_CHAT_MODEL',
    'OPENAI_OCR_MODEL',
    'RAG_TOP_K',
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('getServerEnv', () => {
  it('resolves the database configuration without an OpenAI key present', async () => {
    Object.assign(process.env, DATABASE_VARS);

    const { getServerEnv, getDatabaseUrl } = await loadEnvModule();

    expect(getServerEnv().DATABASE_URL).toBe(DATABASE_VARS.DATABASE_URL);
    expect(getDatabaseUrl()).toBe(DATABASE_VARS.DATABASE_URL);
  });

  it('still resolves RAG tuning without an OpenAI key present', async () => {
    Object.assign(process.env, DATABASE_VARS, {
      RAG_TOP_K: '7',
      OPENAI_OCR_MODEL: 'gpt-5-mini-test',
    });

    const { getRagConfig } = await loadEnvModule();

    expect(getRagConfig().topK).toBe(7);
    expect(getRagConfig().ocrModel).toBe('gpt-5-mini-test');
  });

  it('names the missing variable and never its value', async () => {
    const { getServerEnv } = await loadEnvModule();

    expect(() => getServerEnv()).toThrow(/DATABASE_URL/);
  });

  it('rejects a connection string that is not a postgres URL', async () => {
    process.env.DATABASE_URL = 'mysql://user:pass@db.example.com/ragdb';

    const { getServerEnv } = await loadEnvModule();

    expect(() => getServerEnv()).toThrow(/DATABASE_URL/);
  });

  it('accepts both postgres:// and postgresql:// schemes', async () => {
    process.env.DATABASE_URL = 'postgres://user:pass@db.example.com/ragdb';

    const { getDatabaseUrl } = await loadEnvModule();

    expect(getDatabaseUrl()).toBe('postgres://user:pass@db.example.com/ragdb');
  });
});

describe('getOpenAIApiKey', () => {
  it('returns the key when it is configured', async () => {
    Object.assign(process.env, DATABASE_VARS, { OPENAI_API_KEY: 'openai-key' });

    const { getOpenAIApiKey } = await loadEnvModule();

    expect(getOpenAIApiKey()).toBe('openai-key');
  });

  it('throws naming OPENAI_API_KEY when it is missing', async () => {
    Object.assign(process.env, DATABASE_VARS);

    const { getOpenAIApiKey } = await loadEnvModule();

    expect(() => getOpenAIApiKey()).toThrow(/OPENAI_API_KEY/);
  });

  it('is independent of the database configuration', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';

    const { getOpenAIApiKey, getServerEnv } = await loadEnvModule();

    expect(getOpenAIApiKey()).toBe('openai-key');
    expect(() => getServerEnv()).toThrow(/DATABASE_URL/);
  });
});
