import { buildCitations } from '@/lib/rag/citations';
import type { Citation, MatchedChunk } from '@/lib/types';
import { matchDemoAnswer } from './answers';
import { retrieveDemoChunks } from './retrieval';
import type { DemoQuestionId } from './questions';

/**
 * The demo's answering path: question -> retrieval -> answer -> citations,
 * with no provider call anywhere in it.
 *
 * It deliberately runs the *same* last step as production. Citations are built
 * by `buildCitations()` from retrieval rows, exactly as they are for a real
 * answer, so the demo demonstrates the actual mechanism -- provenance derived
 * from search results -- rather than a mock-up of it.
 *
 * There is no path from here to OpenAI. Not on an unrecognised question, not on
 * an empty retrieval, not on an error: the three outcomes below are exhaustive.
 */

/** Recorded on `questions.model` and shown under an answer, in place of a model id. */
export const DEMO_ANSWER_MODEL = 'demo-mode / local-retrieval';

/** Outcome C: nothing in the sample corpus is close enough to the question. */
export const DEMO_GUIDANCE_ANSWER =
  '公開デモではサンプル質問を使ってRAGの動作をご確認いただけます。';

/** Outcome B: passages were found, but no prepared answer covers the question. */
export const DEMO_PARTIAL_ANSWER = `公開デモでは、あらかじめ用意したサンプル質問にのみ回答をお返ししています。

ご質問に関連する可能性のある箇所は、下の「出典」に検索結果として表示しています。「質問の例」から選んでいただくと、検索から回答までの流れ全体をご確認いただけます。`;

export interface DemoAnswerResult {
  answer: string;
  citations: Citation[];
  /** The retrieval rows behind the citations, for callers that want them. */
  matches: MatchedChunk[];
  model: string;
  /** True when the UI should present this as "found nothing", not as an answer. */
  noRelevantContext: boolean;
  /** Which prepared question was recognised, if any. Internal/diagnostic. */
  matchedQuestionId: DemoQuestionId | null;
}

export interface DemoAnswerOptions {
  topK: number;
  similarityThreshold: number;
}

/**
 * Answer a question from the sample corpus.
 *
 * Three outcomes, in order:
 *
 *  A. **A prepared question is recognised.** Its answer is returned, cited with
 *     the passages it was written from -- scored against the question that was
 *     actually typed, so the 一致度 on each card is computed, not stored.
 *  B. **No prepared answer, but the corpus has related passages.** The visitor
 *     is told the demo answers sample questions, and the retrieved passages are
 *     shown as citations. The search step is real, so an off-script question
 *     still demonstrates retrieval; what it does not do is produce prose.
 *  C. **Nothing relevant.** The guidance sentence, presented as a "not found"
 *     result.
 *
 * Deterministic in all three: the same question yields the same answer, the
 * same citations and the same scores.
 */
export function answerDemoQuestion(
  question: string,
  { topK, similarityThreshold }: DemoAnswerOptions,
): DemoAnswerResult {
  const prepared = matchDemoAnswer(question);

  if (prepared) {
    // Scored, ranked and truncated like any other retrieval -- but over the
    // passages this answer was written from, so the citations can never drift
    // away from the text they support.
    const matches = retrieveDemoChunks(question, {
      topK,
      // The passages are already known to be the grounding for this answer;
      // re-applying the corpus-wide threshold here could drop a citation for an
      // unusual phrasing and leave an answer standing with no source at all.
      similarityThreshold: 0,
      chunkIds: prepared.answer.chunkIds,
    });

    return {
      answer: prepared.answer.answer,
      citations: buildCitations(matches),
      matches,
      model: DEMO_ANSWER_MODEL,
      noRelevantContext: false,
      matchedQuestionId: prepared.answer.id,
    };
  }

  const matches = retrieveDemoChunks(question, { topK, similarityThreshold });

  if (matches.length === 0) {
    return {
      answer: DEMO_GUIDANCE_ANSWER,
      citations: [],
      matches: [],
      model: DEMO_ANSWER_MODEL,
      noRelevantContext: true,
      matchedQuestionId: null,
    };
  }

  return {
    answer: DEMO_PARTIAL_ANSWER,
    citations: buildCitations(matches),
    matches,
    model: DEMO_ANSWER_MODEL,
    noRelevantContext: false,
    matchedQuestionId: null,
  };
}
