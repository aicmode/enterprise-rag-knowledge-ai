import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { getRagConfig } from '@/lib/config/env';
import { AppError, toAppError } from '@/lib/errors';
import { createAdminClient } from '@/lib/supabase/admin';
import type { DocumentRow } from '@/lib/types';
import { storagePathBelongsToUser, validatePageCount } from '@/lib/validation/document';
import { DOCUMENTS_BUCKET } from './bucket';
import { chunkPages } from './chunking';
import { embedTexts } from './embedding';
import { extractPdfPages } from './pdf';

/**
 * The ingestion pipeline.
 *
 *   Storage PDF -> page-wise text -> page-aware chunks -> embeddings -> pgvector
 *
 * Failure policy: page-level OCR failures are recoverable when at least one
 * page remains usable; the document is marked `ready` with an explicit page
 * warning. Extraction-wide or downstream failures mark it `failed` and remove
 * all chunks. A document is never exposed with half-written embedding batches.
 */

export interface IngestResult {
  documentId: string;
  pageCount: number;
  chunkCount: number;
  nativePageCount: number;
  ocrPageCount: number;
  skippedPageNumbers: number[];
}

/**
 * Claim a document for processing.
 *
 * The conditional `.in('status', ['uploaded', 'failed'])` acts as an optimistic
 * lock: two concurrent process requests race on this UPDATE and exactly one
 * sees a row come back. The loser gets `already_processing` instead of starting
 * a second, duplicate embedding run.
 */
async function claimForProcessing(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
): Promise<DocumentRow> {
  const { data, error } = await supabase
    .from('documents')
    .update({ status: 'processing', error_message: null })
    .eq('id', documentId)
    .eq('user_id', userId)
    .in('status', ['uploaded', 'failed'])
    .select('*')
    .maybeSingle();

  if (error) {
    throw new AppError('database_failed', { cause: error, detail: error.message });
  }

  if (!data) {
    // Either the document does not belong to the caller, or it is already
    // processing / ready. Distinguish the two so the UI can say something useful.
    const { data: existing } = await supabase
      .from('documents')
      .select('status')
      .eq('id', documentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (!existing) throw new AppError('not_found', { detail: 'document not found for user' });
    throw new AppError('already_processing', { detail: `status is ${existing.status}` });
  }

  return data as DocumentRow;
}

/** Record a terminal failure with a message that is safe to show the user. */
async function markFailed(documentId: string, userMessage: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('documents')
    .update({ status: 'failed', error_message: userMessage })
    .eq('id', documentId);

  if (error) {
    console.error('[ingest] failed to record failure state', error.message);
  }
}

/**
 * Remove any chunks from a previous attempt.
 *
 * Retry correctness depends on this: without it a re-run would either violate
 * the (document_id, page_number, chunk_index) unique constraint or, if the
 * chunk boundaries shifted, leave stale chunks that keep surfacing in search.
 */
async function deleteExistingChunks(admin: SupabaseClient, documentId: string): Promise<void> {
  const { error } = await admin.from('document_chunks').delete().eq('document_id', documentId);
  if (error) {
    throw new AppError('database_failed', { cause: error, detail: error.message });
  }
}

/**
 * Run the full pipeline for one document.
 *
 * @param supabase user-scoped client, used for the ownership-checked status claim
 * @param userId   the authenticated user's id (never taken from the request body)
 */
export async function processDocument(
  supabase: SupabaseClient,
  documentId: string,
  userId: string,
): Promise<IngestResult> {
  const document = await claimForProcessing(supabase, documentId, userId);

  try {
    // Defence in depth: the path was built server-side from the user's id, but
    // re-verify before handing it to a client that bypasses RLS.
    if (!storagePathBelongsToUser(document.storage_path, userId)) {
      throw new AppError('forbidden', {
        detail: 'storage path does not belong to the requesting user',
      });
    }

    const admin = createAdminClient();

    // --- 1. Fetch the PDF back out of the private bucket -------------------
    const { data: blob, error: downloadError } = await admin.storage
      .from(DOCUMENTS_BUCKET)
      .download(document.storage_path);

    if (downloadError || !blob) {
      throw new AppError('storage_failed', {
        cause: downloadError,
        detail: downloadError?.message ?? 'download returned no data',
      });
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());

    // --- 2. Page-wise text extraction --------------------------------------
    const extraction = await extractPdfPages(bytes);

    const pageCheck = validatePageCount(extraction.pageCount);
    if (!pageCheck.ok) {
      throw new AppError(pageCheck.code, { detail: `page count ${extraction.pageCount}` });
    }

    // --- 3. Page-aware chunking --------------------------------------------
    const config = getRagConfig();
    const chunks = chunkPages(extraction.pages, config);

    if (chunks.length === 0) {
      throw new AppError('pdf_no_text', { detail: 'chunking produced no chunks' });
    }

    // --- 4. Embeddings (batched, order-preserving) -------------------------
    const embeddings = await embedTexts(chunks.map((chunk) => chunk.content));

    if (embeddings.length !== chunks.length) {
      throw new AppError('embedding_failed', {
        detail: `embedding count ${embeddings.length} != chunk count ${chunks.length}`,
      });
    }

    // --- 5. Persist ---------------------------------------------------------
    // Ownership is already established, so the admin client is used here purely
    // to avoid re-evaluating the chunk RLS policy once per inserted row.
    await deleteExistingChunks(admin, documentId);

    const rows = chunks.map((chunk, i) => ({
      document_id: documentId,
      page_number: chunk.pageNumber,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      content_length: chunk.contentLength,
      embedding: JSON.stringify(embeddings[i]),
    }));

    // Insert in batches: a single statement with hundreds of 1536-dim vectors
    // makes for an unnecessarily large request body.
    const INSERT_BATCH = 100;
    for (let i = 0; i < rows.length; i += INSERT_BATCH) {
      const { error: insertError } = await admin
        .from('document_chunks')
        .insert(rows.slice(i, i + INSERT_BATCH));

      if (insertError) {
        throw new AppError('database_failed', {
          cause: insertError,
          detail: insertError.message,
        });
      }
    }

    // --- 6. Ready -----------------------------------------------------------
    const partialWarning =
      extraction.skippedPageNumbers.length > 0
        ? `一部のページ（P.${extraction.skippedPageNumbers.join(', P.')}）は文字を読み取れなかったため、利用可能なページのみ登録しました。`
        : null;

    const { error: readyError } = await admin
      .from('documents')
      .update({
        status: 'ready',
        page_count: extraction.pageCount,
        error_message: partialWarning,
      })
      .eq('id', documentId);

    if (readyError) {
      throw new AppError('database_failed', { cause: readyError, detail: readyError.message });
    }

    return {
      documentId,
      pageCount: extraction.pageCount,
      chunkCount: chunks.length,
      nativePageCount: extraction.nativePageCount,
      ocrPageCount: extraction.ocrPageCount,
      skippedPageNumbers: extraction.skippedPageNumbers,
    };
  } catch (error) {
    const appError = toAppError(error, 'embedding_failed');

    console.error(`[ingest] document ${documentId} failed: ${appError.code} - ${appError.message}`);

    // Best-effort cleanup so a failed document never leaves searchable chunks.
    try {
      await deleteExistingChunks(createAdminClient(), documentId);
    } catch (cleanupError) {
      console.error('[ingest] chunk cleanup failed', cleanupError);
    }

    await markFailed(documentId, appError.userMessage);
    throw appError;
  }
}
