import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { MAX_DOCUMENTS_PER_SESSION } from '@/lib/config/rag';
import { countDocuments, createDocument } from '@/lib/db/documents';
import { AppError } from '@/lib/errors';
import { resolveClientKey } from '@/lib/security/client-key';
import { consumeDemoQuota } from '@/lib/security/rate-limit';
import { maybeSweepDemoRetention } from '@/lib/security/retention';
import { requireSessionId } from '@/lib/session-server';
import { registerDocumentSchema } from '@/lib/validation/document';

export const runtime = 'nodejs';

/**
 * Create the metadata row for a PDF the browser is about to upload.
 *
 * Registration comes *first* so the upload parts have a row to hang off, and so
 * the per-session document quota is enforced before any bytes are accepted --
 * rejecting a 10 MB upload after it has already been transferred would be a
 * waste of the visitor's bandwidth and the demo's budget.
 *
 * The row is always written with the session id resolved from the demo-session
 * cookie; nothing about ownership is taken from the request body.
 *
 * Two limits apply, and they answer different questions. The per-session count
 * bounds how much one visitor can have registered *at once* -- but it counts
 * live rows, so deleting a document frees a slot, and a fresh cookie starts
 * from zero. The fingerprint-scoped `document_register` quota bounds how many
 * registrations happen per day regardless of either, which is what actually
 * caps the ingestion work this endpoint leads to.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();

    const parsed = registerDocumentSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: parsed.error.message });
    }

    const clientKey = resolveClientKey(request);
    await consumeDemoQuota(clientKey, 'document_register');
    maybeSweepDemoRetention();

    const existing = await countDocuments(sessionId);
    if (existing >= MAX_DOCUMENTS_PER_SESSION) {
      throw new AppError('quota_exceeded', {
        detail: `session already has ${existing} documents`,
      });
    }

    const { documentId, title, fileName, fileSize } = parsed.data;

    const document = await createDocument({ documentId, sessionId, title, fileName, fileSize });

    return okJson({ document }, 201);
  } catch (error) {
    return errorJson(error, 'documents/register', 'database_failed');
  }
}
