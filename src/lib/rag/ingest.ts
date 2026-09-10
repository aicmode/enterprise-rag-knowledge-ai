import 'server-only';

import { getRagConfig } from '@/lib/config/env';
import {
  claimDocumentForProcessing,
  markDocumentFailed,
  markDocumentReady,
} from '@/lib/db/documents';
import { deleteDocumentChunks, replaceDocumentChunks } from '@/lib/db/chunks';
import { deleteStagedUpload, readStagedUpload } from '@/lib/db/uploads';
import { AppError, toAppError } from '@/lib/errors';
import { consumeDemoQuota } from '@/lib/security/rate-limit';
import { validatePageCount } from '@/lib/validation/document';
import { chunkPages } from './chunking';
import { embedTexts } from './embedding';
import { extractPdfPages } from './pdf';
import type { OcrPage } from './ocr';

/**
 * The ingestion pipeline.
 *
 *   staged PDF bytes -> page-wise text -> page-aware chunks -> embeddings -> pgvector
 *
 * Failure policy: page-level OCR failures are recoverable when at least one
 * page remains usable; the document is marked `ready` with an explicit page
 * warning. Extraction-wide or downstream failures mark it `failed` and remove
 * all chunks. A document is never exposed with half-written embedding batches.
 *
 * Cost policy: this is the only place in the application that can start a large
 * number of OpenAI requests from a single HTTP call, so it meters as it goes
 * rather than only at the door. The route already charged one
 * `document_process` unit to get here; below, each page sent to the vision
 * model costs an `ocr_page` unit *before* the request is made, and the chunks of
 * a document cost `embedding_chunk` units before the first batch is sent. A
 * budget that runs out mid-document stops the run rather than finishing it.
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
 * Run the full pipeline for one document.
 *
 * @param sessionId  the demo session resolved from the cookie, never from the body
 * @param documentId the document to (re-)process
 * @param clientKey  anonymous client fingerprint the OpenAI budget is charged
 *                   to. Required, not optional: an optional cost guard is one
 *                   forgotten argument away from being no cost guard.
 */
export async function processDocument(
  sessionId: string,
  documentId: string,
  clientKey: string,
): Promise<IngestResult> {
  // Ownership, the per-document lock and the per-session concurrency cap, all
  // in one serialised claim: a document belonging to another session simply does
  // not match, and neither does one already being processed.
  await claimDocumentForProcessing(sessionId, documentId);

  try {
    // --- 1. Reassemble the uploaded PDF from its staged parts --------------
    const bytes = await readStagedUpload(documentId);

    // --- 2. Page-wise text extraction --------------------------------------
    // OCR runs only for pages whose native text is unusable, and each of those
    // pages is charged before its image ever reaches OpenAI. The import stays
    // lazy so a PDF that needs no OCR never loads the OpenAI client at all.
    const guardedOcrPage: OcrPage = async (input) => {
      await consumeDemoQuota(clientKey, 'ocr_page');
      const { ocrPageImage } = await import('./ocr');
      return ocrPageImage(input);
    };

    const extraction = await extractPdfPages(bytes, { ocrPage: guardedOcrPage });

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
    // Charged per chunk, in one atomic step, before the first batch leaves.
    await consumeDemoQuota(clientKey, 'embedding_chunk', chunks.length);

    const embeddings = await embedTexts(chunks.map((chunk) => chunk.content));

    if (embeddings.length !== chunks.length) {
      throw new AppError('embedding_failed', {
        detail: `embedding count ${embeddings.length} != chunk count ${chunks.length}`,
      });
    }

    // --- 5. Persist ---------------------------------------------------------
    await replaceDocumentChunks(
      documentId,
      chunks.map((chunk, i) => ({
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        contentLength: chunk.contentLength,
        embedding: embeddings[i],
      })),
    );

    // --- 6. Ready -----------------------------------------------------------
    const partialWarning =
      extraction.skippedPageNumbers.length > 0
        ? `一部のページ（P.${extraction.skippedPageNumbers.join(', P.')}）は文字を読み取れなかったため、利用可能なページのみ登録しました。`
        : null;

    await markDocumentReady(documentId, extraction.pageCount, partialWarning);

    // The document is now fully represented by its chunks, so the staged PDF
    // bytes have no further purpose. Dropping them here is what keeps the
    // database free of file storage -- a healthy corpus holds text and vectors
    // only. Best-effort: a document that is already `ready` must not be
    // reported as failed just because the cleanup did not land.
    try {
      await deleteStagedUpload(documentId);
    } catch (cleanupError) {
      console.error('[ingest] staged upload cleanup failed', cleanupError);
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
    // The staged bytes are deliberately *kept*, so "retry" can re-run the
    // pipeline without asking for the same upload twice.
    try {
      await deleteDocumentChunks(documentId);
    } catch (cleanupError) {
      console.error('[ingest] chunk cleanup failed', cleanupError);
    }

    await markDocumentFailed(documentId, appError.userMessage).catch((stateError) => {
      console.error('[ingest] failed to record failure state', stateError);
    });

    throw appError;
  }
}
