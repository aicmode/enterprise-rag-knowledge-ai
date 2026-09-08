import { describe, expect, it } from 'vitest';

import {
  buildContextBlock,
  buildMessages,
  buildUserPrompt,
  NO_CONTEXT_ANSWER,
  SYSTEM_PROMPT,
} from '@/lib/rag/prompt';
import type { MatchedChunk } from '@/lib/types';

function match(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunk_id: 'chunk-1',
    document_id: 'doc-1',
    document_title: '就業規則',
    file_name: '就業規則.pdf',
    page_number: 12,
    chunk_index: 0,
    content: '年次有給休暇の申請は5営業日前までに行うこと。',
    similarity: 0.9,
    ...overrides,
  };
}

describe('SYSTEM_PROMPT', () => {
  it('constrains the model to the supplied context', () => {
    expect(SYSTEM_PROMPT).toContain('コンテキスト');
    expect(SYSTEM_PROMPT).toContain('推測');
  });

  it('gives the model an explicit way to say it does not know', () => {
    expect(SYSTEM_PROMPT).toContain(NO_CONTEXT_ANSWER);
  });

  it('tells the model not to write citations itself', () => {
    // Citations are attached by the application from retrieval rows, so the
    // model must be told to stay out of it.
    expect(SYSTEM_PROMPT).toContain('資料名やページ番号を回答本文に書かない');
  });

  it('asks for Japanese output', () => {
    expect(SYSTEM_PROMPT).toContain('日本語');
  });
});

describe('buildContextBlock', () => {
  it('is empty when there are no matches', () => {
    expect(buildContextBlock([])).toBe('');
  });

  it('labels each passage with its document and page', () => {
    const block = buildContextBlock([match()]);

    expect(block).toContain('就業規則');
    expect(block).toContain('12');
    expect(block).toContain('年次有給休暇');
  });

  it('numbers and separates multiple passages', () => {
    const block = buildContextBlock([
      match({ content: '一つ目', page_number: 1 }),
      match({ content: '二つ目', page_number: 2 }),
    ]);

    expect(block).toContain('[コンテキスト 1]');
    expect(block).toContain('[コンテキスト 2]');
    expect(block).toContain('---');
  });

  it('includes every match', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      match({ content: `内容${i}`, page_number: i + 1 }),
    );
    const block = buildContextBlock(matches);

    for (let i = 0; i < 5; i += 1) {
      expect(block).toContain(`内容${i}`);
    }
  });
});

describe('buildUserPrompt', () => {
  it('contains both the question and the context', () => {
    const prompt = buildUserPrompt('有給の申請期限は？', [match()]);

    expect(prompt).toContain('有給の申請期限は？');
    expect(prompt).toContain('年次有給休暇');
  });

  it('delimits the context so the question cannot be confused with it', () => {
    const prompt = buildUserPrompt('質問文', [match()]);

    expect(prompt).toContain('===== コンテキスト =====');
    expect(prompt).toContain('===== コンテキストここまで =====');
  });
});

describe('buildMessages', () => {
  it('produces a system turn followed by a user turn', () => {
    const messages = buildMessages('質問文', [match()]);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('sends the system prompt verbatim', () => {
    expect(buildMessages('質問文', [match()])[0].content).toBe(SYSTEM_PROMPT);
  });
});
