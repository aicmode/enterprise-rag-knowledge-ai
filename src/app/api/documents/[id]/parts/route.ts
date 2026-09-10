import { NextResponse } from 'next/server';

import { errorJson, okJson } from '@/lib/api';
import { MAX_FILE_SIZE_BYTES, UPLOAD_PART_SIZE_BYTES } from '@/lib/config/rag';
import { getDocument } from '@/lib/db/documents';
import { getStagedByteLength, saveUploadPart } from '@/lib/db/uploads';
import { AppError } from '@/lib/errors';
import { resolveClientKey } from '@/lib/security/client-key';
import { consumeDemoQuota } from '@/lib/security/rate-limit';
import { requireSessionId } from '@/lib/session-server';
import { uploadPartSchema } from '@/lib/validation/document';

export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Receive one slice of an uploaded PDF.
 *
 * Why the file arrives in pieces: a Vercel serverless function accepts at most
 * a 4.5 MB request body, but the product supports 10 MB PDFs. Rather than add
 * an object-storage service purely to get past that limit, the browser slices
 * the file into `UPLOAD_PART_SIZE_BYTES` chunks and posts them here; ingestion
 * concatenates them once and then deletes them. See `db/migrations/0001`.
 *
 * Every guard the single-shot upload had still applies, and applies *per part*:
 * the document must exist and belong to the calling session, the part index
 * must be in range, the part must not exceed the part size, and the running
 * total must not exceed the overall file limit -- so a caller cannot assemble
 * a 1 GB file out of legal-looking 3 MB pieces.
 *
 * Those guards are all *per document*, though, and registering another document
 * is cheap. The `upload_bytes` quota adds the missing per-client bound: it is
 * counted in bytes rather than in requests, so neither many small parts nor many
 * separate documents can push more `bytea` into a free-tier database than the
 * daily budget allows -- including uploads that are abandoned before processing
 * and therefore never reach the "delete the staged bytes" step.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();
    const { id } = await context.params;

    if (!UUID_RE.test(id)) {
      throw new AppError('validation_failed', { detail: 'invalid document id' });
    }

    const partIndexRaw = new URL(request.url).searchParams.get('index');
    const parsed = uploadPartSchema.safeParse({ partIndex: Number(partIndexRaw) });
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: 'invalid part index' });
    }

    // Ownership: a document id belonging to another session is indistinguishable
    // from one that does not exist.
    const document = await getDocument(sessionId, id);
    if (!document) {
      throw new AppError('not_found', { detail: 'document not found for this session' });
    }
    if (document.status === 'processing' || document.status === 'ready') {
      throw new AppError('already_processing', { detail: `status is ${document.status}` });
    }

    const body = Buffer.from(await request.arrayBuffer());

    if (body.byteLength === 0) {
      throw new AppError('validation_failed', { detail: 'empty upload part' });
    }
    if (body.byteLength > UPLOAD_PART_SIZE_BYTES) {
      throw new AppError('file_too_large', { detail: `part is ${body.byteLength} bytes` });
    }

    const alreadyStaged = await getStagedByteLength(id, parsed.data.partIndex);
    if (alreadyStaged + body.byteLength > MAX_FILE_SIZE_BYTES) {
      throw new AppError('file_too_large', {
        detail: `staged total would be ${alreadyStaged + body.byteLength} bytes`,
      });
    }

    // Charged for the bytes actually accepted, after the per-document checks
    // above and immediately before they are written.
    await consumeDemoQuota(resolveClientKey(request), 'upload_bytes', body.byteLength);

    await saveUploadPart(id, parsed.data.partIndex, body);

    return okJson({ partIndex: parsed.data.partIndex, received: body.byteLength }, 201);
  } catch (error) {
    return errorJson(error, 'documents/parts', 'database_failed');
  }
}
