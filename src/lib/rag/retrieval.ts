import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { AppError } from '@/lib/errors';
import type { MatchedChunk } from '@/lib/types';

/**
 * Vector retrieval.
 *
 * Note the client that is passed in: this is always the **user-scoped**
 * Supabase client, never the service-role one. The `match_document_chunks` RPC
 * derives identity from `auth.uid()`, so calling it with an admin client would
 * simply return nothing -- by design. There is no parameter through which a
 * caller could request another user's chunks.
 */

export interface RetrievalOptions {
  topK: number;
  similarityThreshold: number;
}

export async function retrieveRelevantChunks(
  supabase: SupabaseClient,
  queryEmbedding: number[],
  options: RetrievalOptions,
): Promise<MatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_document_chunks', {
    // supabase-js serialises the array to the pgvector literal format.
    query_embedding: JSON.stringify(queryEmbedding),
    match_threshold: options.similarityThreshold,
    match_count: options.topK,
  });

  if (error) {
    throw new AppError('retrieval_failed', { cause: error, detail: error.message });
  }

  return (data ?? []) as MatchedChunk[];
}

/**
 * Count the caller's documents that are actually usable for answering.
 *
 * Used to distinguish two very different "no answer" situations: the user has
 * not uploaded anything yet (guide them to /documents) versus they have
 * documents but nothing matched (the answer really is "not in your files").
 */
export async function countReadyDocuments(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'ready');

  if (error) {
    throw new AppError('database_failed', { cause: error, detail: error.message });
  }

  return count ?? 0;
}
