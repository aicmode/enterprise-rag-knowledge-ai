import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The claim this file exists to prove: **in demo mode, the OpenAI SDK is never
 * called.** Not "is refused with a nice message", not "is rate limited" -- not
 * called.
 *
 * Every other check in the suite is about behaviour that is visible in a
 * response body. This one is about a request that must not leave the process,
 * which is invisible by construction, so the SDK itself is replaced with spies:
 * the constructor, `embeddings.create`, `chat.completions.create` and
 * `responses.create`. A regression that reintroduced a billable call would have
 * to go through one of those four functions, and every assertion below counts
 * them at zero.
 *
 * The live-mode cases are the control. Without them, "nothing was called" would
 * also pass on an application that is simply broken, and the guard would be
 * untested rather than proven.
 */

const openAiConstructor = vi.fn();
const embeddingsCreate = vi.fn();
const chatCreate = vi.fn();
const responsesCreate = vi.fn();

// Declared inside the factory: `vi.mock` is hoisted above the rest of the file,
// so anything it closes over has to be created in here.
vi.mock('openai', () => {
  class ApiConnectionTimeoutError extends Error {}

  class MockOpenAI {
    embeddings = { create: embeddingsCreate };
    chat = { completions: { create: chatCreate } };
    responses = { create: responsesCreate };

    static APIConnectionTimeoutError = ApiConnectionTimeoutError;

    constructor(options: unknown) {
      openAiConstructor(options);
    }
  }

  return { default: MockOpenAI, APIConnectionTimeoutError: ApiConnectionTimeoutError };
});

/** Every spy that stands between the demo and a bill. */
function providerCallCount(): number {
  return (
    openAiConstructor.mock.calls.length +
    embeddingsCreate.mock.calls.length +
    chatCreate.mock.calls.length +
    responsesCreate.mock.calls.length
  );
}

const TOUCHED = ['AI_RUNTIME_MODE', 'OPENAI_API_KEY', 'DATABASE_URL'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  for (const key of TOUCHED) delete process.env[key];

  // The OpenAI client module memoises its instance, so each case gets a fresh
  // module graph. Otherwise a client built by a live-mode case would still be
  // sitting there when a demo-mode case ran.
  vi.resetModules();
  openAiConstructor.mockClear();
  embeddingsCreate.mockClear();
  chatCreate.mockClear();
  responsesCreate.mockClear();
});

afterEach(() => {
  for (const key of TOUCHED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const A_CHUNK = {
  chunk_id: 'chunk-1',
  document_id: 'doc-1',
  document_title: '就業規則',
  file_name: 'rules.pdf',
  page_number: 12,
  chunk_index: 0,
  content: '年次有給休暇の申請は、取得予定日の5営業日前までに提出すること。',
  similarity: 0.82,
};

describe('demo mode: the provider is unreachable', () => {
  it('refuses to construct the OpenAI client', async () => {
    const { getOpenAIClient } = await import('@/lib/rag/openai');

    expect(() => getOpenAIClient()).toThrow(expect.objectContaining({ code: 'ai_demo_mode' }));
    expect(openAiConstructor).not.toHaveBeenCalled();
    expect(providerCallCount()).toBe(0);
  });

  it('refuses embeddings', async () => {
    const { embedTexts, embedQuery } = await import('@/lib/rag/embedding');

    await expect(embedTexts(['社内規程のテキスト'])).rejects.toMatchObject({
      code: 'ai_demo_mode',
      status: 503,
    });
    await expect(embedQuery('有給休暇の申請期限は？')).rejects.toMatchObject({
      code: 'ai_demo_mode',
    });

    expect(embeddingsCreate).not.toHaveBeenCalled();
    expect(providerCallCount()).toBe(0);
  });

  it('refuses answer generation', async () => {
    const { generateAnswer } = await import('@/lib/rag/answer');

    await expect(
      generateAnswer({
        question: '有給休暇は何日前までに申請が必要ですか？',
        matches: [A_CHUNK],
        model: 'gpt-4o-mini',
      }),
    ).rejects.toMatchObject({ code: 'ai_demo_mode' });

    expect(chatCreate).not.toHaveBeenCalled();
    expect(providerCallCount()).toBe(0);
  });

  it('refuses OCR', async () => {
    const { ocrPageImage } = await import('@/lib/rag/ocr');

    await expect(
      ocrPageImage({ pageNumber: 1, imageDataUrl: 'data:image/png;base64,cGFnZQ==' }),
    ).rejects.toMatchObject({ code: 'ai_demo_mode' });

    expect(responsesCreate).not.toHaveBeenCalled();
    expect(providerCallCount()).toBe(0);
  });

  it('refuses all of them with a valid API key present', async () => {
    // The requirement in one test: a configured key changes nothing. This is
    // the state the public deployment is actually in.
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    const [{ embedTexts }, { generateAnswer }, { ocrPageImage }, { getOpenAIClient }] =
      await Promise.all([
        import('@/lib/rag/embedding'),
        import('@/lib/rag/answer'),
        import('@/lib/rag/ocr'),
        import('@/lib/rag/openai'),
      ]);

    expect(() => getOpenAIClient()).toThrow(expect.objectContaining({ code: 'ai_demo_mode' }));
    await expect(embedTexts(['テキスト'])).rejects.toMatchObject({ code: 'ai_demo_mode' });
    await expect(
      generateAnswer({ question: '質問', matches: [A_CHUNK], model: 'gpt-4o-mini' }),
    ).rejects.toMatchObject({ code: 'ai_demo_mode' });
    await expect(
      ocrPageImage({ pageNumber: 1, imageDataUrl: 'data:image/png;base64,cGFnZQ==' }),
    ).rejects.toMatchObject({ code: 'ai_demo_mode' });

    expect(providerCallCount()).toBe(0);
  });

  it('refuses under an unrecognised AI_RUNTIME_MODE, rather than falling through', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.AI_RUNTIME_MODE = 'production';
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    const { embedTexts } = await import('@/lib/rag/embedding');

    await expect(embedTexts(['テキスト'])).rejects.toMatchObject({ code: 'ai_demo_mode' });
    expect(providerCallCount()).toBe(0);
  });

  it('serves the ask flow end to end without touching the provider', async () => {
    // The demo answering path in full: retrieval, answer, citations. If any of
    // it reached for a model, one of the four spies would record it.
    const { answerDemoQuestion } = await import('@/lib/demo/rag');

    const result = answerDemoQuestion('有給休暇は何日前までに申請が必要ですか？', {
      topK: 5,
      similarityThreshold: 0.45,
    });

    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(providerCallCount()).toBe(0);
  });

  it('does not retry against the provider when the demo path finds nothing', async () => {
    const { answerDemoQuestion } = await import('@/lib/demo/rag');

    const result = answerDemoQuestion('明日の株価はどうなりますか', {
      topK: 5,
      similarityThreshold: 0.45,
    });

    expect(result.noRelevantContext).toBe(true);
    expect(providerCallCount()).toBe(0);
  });
});

describe('live mode: the provider is reachable again', () => {
  it('refuses without an API key, and still calls nothing', async () => {
    process.env.AI_RUNTIME_MODE = 'live';

    const { embedTexts } = await import('@/lib/rag/embedding');

    await expect(embedTexts(['テキスト'])).rejects.toMatchObject({
      code: 'ai_not_configured',
      status: 500,
    });
    expect(providerCallCount()).toBe(0);
  });

  it('reaches embeddings when explicitly configured', async () => {
    process.env.AI_RUNTIME_MODE = 'live';
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    const { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } = await import('@/lib/config/rag');
    embeddingsCreate.mockResolvedValue({
      data: [{ index: 0, embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0) }],
    });

    const { embedTexts } = await import('@/lib/rag/embedding');
    const [embedding] = await embedTexts(['社内規程のテキスト']);

    expect(embedding).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(embeddingsCreate).toHaveBeenCalledWith({
      model: EMBEDDING_MODEL,
      input: ['社内規程のテキスト'],
    });
    expect(openAiConstructor).toHaveBeenCalledTimes(1);
  });

  it('reaches chat completions when explicitly configured', async () => {
    process.env.AI_RUNTIME_MODE = 'live';
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';

    chatCreate.mockResolvedValue({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: '5営業日前までに申請してください。' } }],
    });

    const { generateAnswer } = await import('@/lib/rag/answer');
    const result = await generateAnswer({
      question: '有給休暇は何日前までに申請が必要ですか？',
      matches: [A_CHUNK],
      model: 'gpt-4o-mini',
    });

    expect(result.answer).toBe('5営業日前までに申請してください。');
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it('reaches the vision model when explicitly configured', async () => {
    process.env.AI_RUNTIME_MODE = 'live';
    process.env.OPENAI_API_KEY = 'sk-test-key-not-real';
    // OCR reads the configured model from the RAG config, which validates the
    // database group as it loads. No connection is opened.
    process.env.DATABASE_URL = 'postgres://user:password@127.0.0.1:5432/example';

    responsesCreate.mockResolvedValue({ output_text: '読み取ったテキスト' });

    const { ocrPageImage } = await import('@/lib/rag/ocr');
    const text = await ocrPageImage({
      pageNumber: 1,
      imageDataUrl: 'data:image/png;base64,cGFnZQ==',
    });

    expect(text).toBe('読み取ったテキスト');
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });
});
