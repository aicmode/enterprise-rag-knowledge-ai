import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { processDocument } from '@/lib/rag/ingest';
import { requireUser } from '@/lib/supabase/server';
import { processDocumentSchema } from '@/lib/validation/document';

// The pdf.js parser needs Node APIs, so this route cannot run on the Edge runtime.
export const runtime = 'nodejs';
// A 100-page PDF plus embedding batches takes well over the default budget.
export const maxDuration = 300;

/**
 * Run (or re-run) the ingestion pipeline for one document.
 *
 * Called right after registration, and again by the "再試行" button on a failed
 * document. Idempotency is handled inside `processDocument`, which claims the
 * row with a conditional UPDATE so two concurrent calls cannot both embed.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { supabase, user } = await requireUser();

    const parsed = processDocumentSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: parsed.error.message });
    }

    const result = await processDocument(supabase, parsed.data.documentId, user.id);

    return okJson({ status: 'ready', ...result });
  } catch (error) {
    return errorJson(error, 'documents/process', 'embedding_failed');
  }
}
