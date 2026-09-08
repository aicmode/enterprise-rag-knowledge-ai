import 'server-only';

import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@/lib/config/rag';
import { AppError } from '@/lib/errors';
import { getOpenAIClient } from './openai';

/**
 * Embedding generation.
 *
 * Two things this module is careful about:
 *
 *  1. **Batching, not fan-out.** A 100-page PDF can produce several hundred
 *     chunks. Firing one request per chunk (`Promise.all(chunks.map(...))`)
 *     would hit OpenAI rate limits immediately. Instead we send batches of
 *     `EMBEDDING_BATCH_SIZE` inputs sequentially -- far fewer requests, and a
 *     predictable load profile.
 *
 *  2. **Dimension checking.** The pgvector column is `vector(1536)`. If the
 *     configured model ever returned a different width, Postgres would reject
 *     the insert with an opaque error; we check up front and fail with a clear
 *     internal message instead.
 */

/** Split a list into fixed-size batches. Pure, so it is unit-testable. */
export function batchItems<T>(items: readonly T[], batchSize: number): T[][] {
  if (batchSize < 1) throw new Error('batchItems: batchSize must be >= 1');

  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

function assertDimensions(vector: readonly number[], index: number): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new AppError('embedding_failed', {
      detail: `embedding ${index} has ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`,
    });
  }
}

/**
 * Embed many texts, preserving input order.
 *
 * The returned array is index-aligned with `texts`, which is what lets the
 * caller zip embeddings back onto their chunks (and therefore onto their page
 * numbers) without any further bookkeeping.
 */
export async function embedTexts(texts: readonly string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const openai = getOpenAIClient();
  const embeddings: number[][] = [];

  for (const batch of batchItems(texts, EMBEDDING_BATCH_SIZE)) {
    let response;
    try {
      response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: batch as string[],
      });
    } catch (error) {
      throw new AppError('embedding_failed', {
        cause: error,
        detail: error instanceof Error ? error.message : 'embeddings request failed',
      });
    }

    if (response.data.length !== batch.length) {
      throw new AppError('embedding_failed', {
        detail: `expected ${batch.length} embeddings, received ${response.data.length}`,
      });
    }

    // The API documents that `data` is returned in input order, but it also
    // carries an explicit index; sorting by it removes the assumption.
    const ordered = [...response.data].sort((a, b) => a.index - b.index);

    for (const [i, item] of ordered.entries()) {
      assertDimensions(item.embedding, embeddings.length + i);
      embeddings.push(item.embedding);
    }
  }

  return embeddings;
}

/** Embed a single query string. */
export async function embedQuery(text: string): Promise<number[]> {
  const [embedding] = await embedTexts([text]);
  if (!embedding) {
    throw new AppError('embedding_failed', { detail: 'no embedding returned for query' });
  }
  return embedding;
}
