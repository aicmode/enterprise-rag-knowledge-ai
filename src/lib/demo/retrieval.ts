import type { MatchedChunk } from '@/lib/types';
import { DEMO_CHUNKS, type DemoChunk } from './corpus';

/**
 * Deterministic, offline retrieval for the public demo.
 *
 * This is the piece that replaces `embedQuery()` + `match_document_chunks()`
 * when `AI_RUNTIME_MODE=demo`. It is a plain lexical matcher: no model, no
 * network, no API key, and no floating-point state carried between calls, so
 * the same question always produces the same ranking and the same 一致度.
 *
 * It is not pretending to be an embedding. A character-n-gram matcher has no
 * notion of meaning -- it cannot tell that 「リモートワーク」 and 「在宅勤務」
 * are the same thing, which is precisely what the real pipeline's embeddings
 * are for. The corpus closes that gap explicitly with per-chunk `keywords`, and
 * the README says so rather than letting the demo imply that lexical matching
 * is what the product does.
 *
 * Everything below is pure, so the ranking rules are unit-testable without a
 * database and without a provider.
 */

/**
 * Question-shaped noise stripped before matching.
 *
 * Japanese questions end in a predictable tail (「〜ですか」「〜教えてください」)
 * that appears in no document passage but does add n-grams to the query, which
 * would dilute every containment score by a constant amount. Removing it is the
 * lexical equivalent of dropping stop words.
 */
const QUESTION_NOISE = [
  'を教えてください',
  'について教えて',
  'を教えて',
  '教えてください',
  'でしょうか',
  'ますでしょうか',
  'でしょう',
  'ください',
  'について',
  'ですか',
  'ますか',
  'なのか',
  'とは',
] as const;

/**
 * Fold a string down to the characters that carry meaning.
 *
 * NFKC first, so full-width digits and Latin letters match their half-width
 * forms; then lower-case; then drop everything that is not a letter, a digit or
 * a CJK/kana character. Punctuation and whitespace are removed rather than
 * replaced, because a Japanese passage has no word boundaries for them to mark.
 */
export function normalizeForMatching(text: string): string {
  let normalized = text.normalize('NFKC').toLowerCase();

  for (const noise of QUESTION_NOISE) {
    normalized = normalized.split(noise).join('');
  }

  return normalized.replace(/[^0-9a-z぀-ヿ㐀-䶿一-鿿]/gu, '');
}

/**
 * Character bigrams of `text`, as a set.
 *
 * Bigrams rather than whole words: Japanese is not space-delimited, so word
 * segmentation would need a dictionary (and a dependency). A string shorter
 * than two characters yields itself, so a one-character query still matches.
 */
export function characterBigrams(text: string): Set<string> {
  const normalized = normalizeForMatching(text);
  const grams = new Set<string>();

  if (normalized.length === 0) return grams;
  if (normalized.length === 1) {
    grams.add(normalized);
    return grams;
  }

  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.add(normalized.slice(i, i + 2));
  }

  return grams;
}

/** Share of `query`'s n-grams that also occur in `target`. Asymmetric on purpose:
 *  a long passage should not be penalised for covering more than was asked. */
export function containment(query: Set<string>, target: Set<string>): number {
  if (query.size === 0) return 0;

  let hits = 0;
  for (const gram of query) {
    if (target.has(gram)) hits += 1;
  }

  return hits / query.size;
}

/** Symmetric overlap, used where both sides are short phrases (question vs question). */
export function diceCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;

  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) shared += 1;
  }

  return (2 * shared) / (a.size + b.size);
}

/** How much of each additional keyword hit is still unexplained; see below. */
const KEYWORD_DECAY = 0.6;

/**
 * Strength of the keyword signal: how strongly a question names what a passage
 * is about.
 *
 * Deliberately *not* `hits / keywords.length`. Under that ratio, describing a
 * passage more thoroughly would lower its score for the same question, so the
 * honest thing (listing every phrase a reader might use) would be punished.
 * Diminishing returns on the hit count instead -- one hit 0.40, two 0.64, three
 * 0.78 -- which depends on what the question actually said and not on how long
 * the keyword list happens to be.
 */
export function keywordCoverage(question: string, keywords: readonly string[]): number {
  if (keywords.length === 0) return 0;

  const normalizedQuestion = normalizeForMatching(question);
  if (normalizedQuestion.length === 0) return 0;

  const hits = keywords.filter((keyword) => {
    const normalizedKeyword = normalizeForMatching(keyword);
    return normalizedKeyword.length > 0 && normalizedQuestion.includes(normalizedKeyword);
  }).length;

  return 1 - KEYWORD_DECAY ** hits;
}

/** Scores are rounded so a displayed 一致度 is byte-identical across runs. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Score one passage against a question.
 *
 * Two independent signals are combined with a noisy-OR (`1 - (1-a)(1-b)`)
 * rather than a weighted sum: either strong lexical overlap *or* an outright
 * keyword mention is enough to make a passage relevant, and a weighted sum
 * would cap a passage that scores perfectly on one signal and nothing on the
 * other. The result is capped below 1.0 -- nothing in a demo should claim a
 * perfect match.
 */
export function scoreDemoChunk(question: string, chunk: DemoChunk): number {
  const questionGrams = characterBigrams(question);
  if (questionGrams.size === 0) return 0;

  const lexical = containment(questionGrams, characterBigrams(chunk.content));
  const keyword = keywordCoverage(question, chunk.keywords);
  const combined = 1 - (1 - lexical) * (1 - keyword);

  return round(Math.min(combined, 0.99));
}

export interface DemoRetrievalOptions {
  topK: number;
  similarityThreshold: number;
  /** Restrict retrieval to these chunk ids, preserving scoring. */
  chunkIds?: readonly string[];
}

/**
 * Rank the sample corpus against a question.
 *
 * Returns the same `MatchedChunk` rows `match_document_chunks` returns, so
 * `buildCitations()` and the citation cards downstream run unchanged.
 *
 * Ties are broken by chunk id so the order is total, and therefore stable: two
 * passages that score identically must not swap places between two identical
 * requests.
 */
export function retrieveDemoChunks(
  question: string,
  { topK, similarityThreshold, chunkIds }: DemoRetrievalOptions,
): MatchedChunk[] {
  const pool = chunkIds
    ? chunkIds
        .map((id) => DEMO_CHUNKS.find((chunk) => chunk.chunk_id === id))
        .filter((chunk): chunk is DemoChunk => chunk !== undefined)
    : DEMO_CHUNKS;

  return pool
    .map((chunk) => {
      // `keywords` is a retrieval-time hint, not part of a search result: the
      // row handed downstream is exactly the `MatchedChunk` shape pgvector
      // returns.
      const { keywords, ...row } = chunk;
      void keywords;
      return { ...row, similarity: scoreDemoChunk(question, chunk) };
    })
    .filter((chunk) => chunk.similarity >= similarityThreshold)
    .sort((a, b) =>
      b.similarity === a.similarity
        ? a.chunk_id.localeCompare(b.chunk_id)
        : b.similarity - a.similarity,
    )
    .slice(0, Math.max(1, topK));
}
