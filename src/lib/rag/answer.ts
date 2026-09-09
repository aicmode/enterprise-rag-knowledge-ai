import 'server-only';

import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

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

/**
 * Room for the visible answer itself. Unchanged from the original `max_tokens`
 * budget -- a grounded answer over a handful of chunks is short by design.
 */
export const ANSWER_TOKEN_BUDGET = 900;

/**
 * Additional budget granted to reasoning models.
 *
 * `max_tokens` capped only the visible completion. Its replacement,
 * `max_completion_tokens`, caps reasoning *plus* visible tokens, so on a
 * reasoning model a straight rename would quietly shrink the answer budget --
 * and once reasoning exhausts the cap the API returns a completion with empty
 * content, which surfaces as `answer_failed` rather than as a truncated answer.
 * The headroom keeps the visible budget effectively intact.
 */
export const REASONING_TOKEN_HEADROOM = 1200;

/**
 * Whether `model` is a reasoning model (o-series, GPT-5 family).
 *
 * These reject a custom `temperature` outright -- only the default is accepted
 * -- and they spend part of `max_completion_tokens` on hidden reasoning.
 */
export function isReasoningModel(model: string): boolean {
  return /^(o[1-9]|gpt-5)/.test(model.trim().toLowerCase());
}

/**
 * Build the chat-completion request for `model`.
 *
 * Kept pure and exported so the parameter choices can be asserted in tests
 * without an API call: sending a parameter the target model rejects is a 400
 * that only shows up at runtime, in front of a user.
 */
export function buildCompletionRequest(
  model: string,
  messages: ChatCompletionCreateParamsNonStreaming['messages'],
): ChatCompletionCreateParamsNonStreaming {
  const reasoning = isReasoningModel(model);

  return {
    model,
    messages,
    // Low temperature: this is an extraction task, not a creative one. Omitted
    // for reasoning models, which accept only their default temperature.
    ...(reasoning ? {} : { temperature: 0.1 }),
    max_completion_tokens: reasoning
      ? ANSWER_TOKEN_BUDGET + REASONING_TOKEN_HEADROOM
      : ANSWER_TOKEN_BUDGET,
  };
}

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
    const completion = await openai.chat.completions.create(
      buildCompletionRequest(model, buildMessages(question, matches)),
    );

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
