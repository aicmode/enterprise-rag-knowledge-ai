import { describe, expect, it } from 'vitest';

import { MAX_QUESTION_LENGTH } from '@/lib/config/rag';
import { askRequestSchema, feedbackSchema, validateQuestion } from '@/lib/validation/question';

describe('validateQuestion', () => {
  it('accepts a normal question', () => {
    const result = validateQuestion('有給休暇は何日前までに申請が必要ですか？');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('有給休暇は何日前までに申請が必要ですか？');
  });

  it('trims surrounding whitespace', () => {
    const result = validateQuestion('  有給休暇について  ');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('有給休暇について');
  });

  it('rejects an empty question', () => {
    const result = validateQuestion('');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toBeTruthy();
  });

  it('rejects a whitespace-only question', () => {
    expect(validateQuestion('     ').ok).toBe(false);
  });

  it('rejects a single character as too short', () => {
    expect(validateQuestion('あ').ok).toBe(false);
  });

  it('accepts a question at exactly the maximum length', () => {
    expect(validateQuestion('あ'.repeat(MAX_QUESTION_LENGTH)).ok).toBe(true);
  });

  it('rejects a question one character over the maximum', () => {
    const result = validateQuestion('あ'.repeat(MAX_QUESTION_LENGTH + 1));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(String(MAX_QUESTION_LENGTH));
  });

  it('returns a Japanese message the UI can display directly', () => {
    const result = validateQuestion('');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(/[぀-ヿ一-鿿]/.test(result.message)).toBe(true);
  });
});

describe('askRequestSchema', () => {
  it('accepts a well-formed body', () => {
    expect(askRequestSchema.safeParse({ question: '経費精算の締め日は？' }).success).toBe(true);
  });

  it('rejects a missing question field', () => {
    expect(askRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-string question', () => {
    expect(askRequestSchema.safeParse({ question: 42 }).success).toBe(false);
    expect(askRequestSchema.safeParse({ question: null }).success).toBe(false);
  });

  it('rejects a null body', () => {
    expect(askRequestSchema.safeParse(null).success).toBe(false);
  });
});

describe('feedbackSchema', () => {
  const questionId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  it('accepts helpful and not_helpful', () => {
    expect(feedbackSchema.safeParse({ questionId, rating: 'helpful' }).success).toBe(true);
    expect(feedbackSchema.safeParse({ questionId, rating: 'not_helpful' }).success).toBe(true);
  });

  it('rejects an unknown rating value', () => {
    expect(feedbackSchema.safeParse({ questionId, rating: 'amazing' }).success).toBe(false);
  });

  it('rejects a non-UUID question id', () => {
    expect(feedbackSchema.safeParse({ questionId: 'abc', rating: 'helpful' }).success).toBe(false);
  });

  it('allows an optional comment and rejects an over-long one', () => {
    expect(
      feedbackSchema.safeParse({ questionId, rating: 'helpful', comment: 'ページが正確でした' })
        .success,
    ).toBe(true);

    expect(
      feedbackSchema.safeParse({ questionId, rating: 'helpful', comment: 'あ'.repeat(2001) })
        .success,
    ).toBe(false);
  });
});
