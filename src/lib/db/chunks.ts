import 'server-only';

import { AppError } from '@/lib/errors';
import type { MatchedChunk } from '@/lib/types';
import { query, toVectorLiteral, transaction } from './client';

/**
 * Chunk persistence and vector retrieval.
 */

export interface ChunkInsert {
  pageNumber: number;
  chunkIndex: number;
  content: string;
  contentLength: number;
  embedding: readonly number[];
}

/**
 * Replace a document's chunks in one transaction.
 *
 * Delete-then-insert rather than upsert: a re-run with different chunk
 * boundaries must not leave stale chunks behind, because those would keep
 * surfacing in search with page numbers that no longer match anything the user
 * would recognise. Doing it inside a transaction means a failure halfway
 * through cannot leave the document with a partial corpus.
 *
 * Rows are inserted in batches with a multi-row VALUES list -- one round trip
 * per batch instead of one per chunk, which matters when a 100-page PDF
 * produces several hundred 1536-dimension vectors.
 */
export async function replaceDocumentChunks(
  documentId: string,
  chunks: readonly ChunkInsert[],
): Promise<number> {
  const INSERT_BATCH = 50;

  return transaction(async (client) => {
    await client.query('delete from document_chunks where document_id = $1', [documentId]);

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH) {
      const batch = chunks.slice(offset, offset + INSERT_BATCH);

      const values: unknown[] = [documentId];
      const tuples = batch.map((chunk) => {
        const base = values.length;
        values.push(
          chunk.pageNumber,
          chunk.chunkIndex,
          chunk.content,
          chunk.contentLength,
          toVectorLiteral(chunk.embedding),
        );
        return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector)`;
      });

      await client.query(
        `insert into document_chunks
           (document_id, page_number, chunk_index, content, content_length, embedding)
         values ${tuples.join(', ')}`,
        values,
      );
    }

    return chunks.length;
  });
}

export async function deleteDocumentChunks(documentId: string): Promise<void> {
  await query('delete from document_chunks where document_id = $1', [documentId]);
}

export async function countDocumentChunks(documentId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    'select count(*)::text as count from document_chunks where document_id = $1',
    [documentId],
  );
  return Number(rows[0]?.count ?? 0);
}

export interface RetrievalOptions {
  topK: number;
  similarityThreshold: number;
}

/**
 * Cosine similarity search over one session's ready documents.
 *
 * The session id is the *first* argument of `match_document_chunks`, and it is
 * always the value resolved from the httpOnly cookie -- never anything from a
 * request body. There is no parameter through which a caller could ask for
 * another visitor's chunks.
 */
export async function retrieveRelevantChunks(
  sessionId: string,
  queryEmbedding: readonly number[],
  options: RetrievalOptions,
): Promise<MatchedChunk[]> {
  try {
    return await query<MatchedChunk>(
      `select chunk_id, document_id, document_title, file_name,
              page_number, chunk_index, content, similarity
         from match_document_chunks($1, $2::vector, $3, $4)`,
      [sessionId, toVectorLiteral(queryEmbedding), options.similarityThreshold, options.topK],
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw new AppError('retrieval_failed', { cause: error.cause, detail: error.message });
    }
    throw error;
  }
}
