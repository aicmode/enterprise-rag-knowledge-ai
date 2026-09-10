import { describe, expect, it } from 'vitest';

import {
  ANSWER_TOKEN_BUDGET,
  REASONING_TOKEN_HEADROOM,
  buildCompletionRequest,
  isReasoningModel,
} from '@/lib/rag/answer';
import { buildMessages } from '@/lib/rag/prompt';
import type { MatchedChunk } from '@/lib/types';

const matches: MatchedChunk[] = [
  {
    chunk_id: 'c1',
    document_id: 'd1',
    document_title: 'Employee Handbook.pdf',
    file_name: 'employee-handbook.pdf',
    content: 'Employees may work remotely up to three days per week.',
    page_number: 3,
    chunk_index: 0,
    similarity: 0.82,
  },
];

const messages = buildMessages('How many days per week can employees work remotely?', matches);

describe('buildCompletionRequest', () => {
  /**
   * The regression this guards: `max_tokens` was rejected outright by the
   * configured chat model with `400 Unsupported parameter`, which surfaced to
   * the user as "回答の生成に失敗しました。".
   */
  it('never sends the deprecated max_tokens parameter', () => {
    for (const model of ['gpt-5-mini', 'gpt-4o-mini', 'o3-mini']) {
      const request = buildCompletionRequest(model, messages);
      expect(request).not.toHaveProperty('max_tokens');
      expect(request.max_completion_tokens).toBeGreaterThan(0);
    }
  });

  it('omits temperature for reasoning models, which accept only the default', () => {
    const request = buildCompletionRequest('gpt-5-mini', messages);
    expect(request).not.toHaveProperty('temperature');
  });

  it('keeps the low extraction temperature for classic chat models', () => {
    const request = buildCompletionRequest('gpt-4o-mini', messages);
    expect(request.temperature).toBe(0.1);
  });

  it('grants reasoning models headroom so hidden reasoning cannot starve the answer', () => {
    expect(buildCompletionRequest('gpt-4o-mini', messages).max_completion_tokens).toBe(
      ANSWER_TOKEN_BUDGET,
    );
    expect(buildCompletionRequest('gpt-5-mini', messages).max_completion_tokens).toBe(
      ANSWER_TOKEN_BUDGET + REASONING_TOKEN_HEADROOM,
    );
  });

  it('passes the configured model and prompt through untouched', () => {
    const request = buildCompletionRequest('gpt-5-mini', messages);
    expect(request.model).toBe('gpt-5-mini');
    expect(request.messages).toEqual(messages);
  });
});

describe('isReasoningModel', () => {
  it('recognises the o-series and the GPT-5 family', () => {
    for (const model of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini']) {
      expect(isReasoningModel(model)).toBe(true);
    }
  });

  it('treats classic chat models as non-reasoning', () => {
    for (const model of ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-3.5-turbo']) {
      expect(isReasoningModel(model)).toBe(false);
    }
  });
});
