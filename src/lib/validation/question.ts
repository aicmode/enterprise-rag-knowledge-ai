import { z } from 'zod';

import { MAX_QUESTION_LENGTH, MIN_QUESTION_LENGTH } from '@/lib/config/rag';

/**
 * Question input rules, shared by the Ask form and the API route.
 *
 * The bounds match the `questions.question` CHECK constraint so the three
 * layers (UI, API, database) cannot drift apart.
 */
export const questionSchema = z
  .string()
  .trim()
  .min(MIN_QUESTION_LENGTH, `質問は${MIN_QUESTION_LENGTH}文字以上で入力してください。`)
  .max(MAX_QUESTION_LENGTH, `質問は${MAX_QUESTION_LENGTH}文字以内で入力してください。`);

export const askRequestSchema = z.object({
  question: questionSchema,
});

export type QuestionValidation = { ok: true; value: string } | { ok: false; message: string };

/** Validate raw user input, returning a message suitable for display. */
export function validateQuestion(raw: string): QuestionValidation {
  const result = questionSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? '質問を入力してください。' };
  }
  return { ok: true, value: result.data };
}

export const feedbackSchema = z.object({
  questionId: z.string().uuid(),
  rating: z.enum(['helpful', 'not_helpful']),
  comment: z.string().trim().max(2000).nullish(),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;
