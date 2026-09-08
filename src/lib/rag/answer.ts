import 'server-only';

import { AppError } from '@/lib/errors';
import type { MatchedChunk } from '@/lib/types';
import { getOpenAIClient } from './openai';
import { buildMessages, NO_CONTEXT_ANSWER } from './prompt';

/**
 * Answer generation.
 *
 * Deliberately thin: retrieval has already decided *what* the model is allowed
 * to see, and citations are assembled elsewhere from the same rows. All this
 * does is turn grounded context into prose.
 */

export interface GenerateAnswerOptions {
  question: string;
  matches: readonly MatchedChunk[];
  model: string;
}

export interface GeneratedAnswer {
  answer: string;
  model: string;
}

export async function generateAnswer({
  question,
  matches,
  model,
}: GenerateAnswerOptions): Promise<GeneratedAnswer> {
  // Short-circuit: with no context there is nothing to ground an answer in, so
  // we return the fixed "not found" response instead of spending a model call
  // on a prompt whose only honest completion is that same sentence.
  if (matches.length === 0) {
    return { answer: NO_CONTEXT_ANSWER, model };
  }

  const openai = getOpenAIClient();

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: buildMessages(question, matches),
      // Low temperature: this is an extraction task, not a creative one.
      temperature: 0.1,
      max_tokens: 900,
    });

    const answer = completion.choices[0]?.message?.content?.trim();

    if (!answer) {
      throw new AppError('answer_failed', { detail: 'model returned an empty completion' });
    }

    return { answer, model: completion.model ?? model };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('answer_failed', {
      cause: error,
      detail: error instanceof Error ? error.message : 'chat completion failed',
    });
  }
}
