import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { processDocument } from '@/lib/rag/ingest';
import { resolveClientKey } from '@/lib/security/client-key';
import { consumeDemoQuota } from '@/lib/security/rate-limit';
import { maybeSweepDemoRetention } from '@/lib/security/retention';
import { requireSessionId } from '@/lib/session-server';
import { processDocumentSchema } from '@/lib/validation/document';

// The pdf.js parser needs Node APIs, so this route cannot run on the Edge runtime.
export const runtime = 'nodejs';
// A 100-page PDF plus embedding batches takes well over the default budget.
export const maxDuration = 300;

/**
 * Run (or re-run) the ingestion pipeline for one document.
 *
 * Called right after the upload parts have all landed, and again by the "再試行"
 * button on a failed document. Idempotency is handled inside `processDocument`,
 * which claims the row under an advisory lock so two concurrent calls cannot
 * both embed.
 *
 * This is the most expensive endpoint in the product: one call can OCR up to a
 * hundred page images and embed several hundred chunks. Retrying is a genuine
 * feature -- a failed document must be recoverable without a re-upload -- but an
 * unmetered retry button on a public URL is an unmetered OpenAI bill, so a run
 * costs one `document_process` unit before anything is claimed, and the pipeline
 * itself charges per OCR page and per embedded chunk as it goes.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();

    const parsed = processDocumentSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: parsed.error.message });
    }

    const clientKey = resolveClientKey(request);
    await consumeDemoQuota(clientKey, 'document_process');
    maybeSweepDemoRetention();

    const result = await processDocument(sessionId, parsed.data.documentId, clientKey);

    return okJson({ status: 'ready', ...result });
  } catch (error) {
    return errorJson(error, 'documents/process', 'embedding_failed');
  }
}
