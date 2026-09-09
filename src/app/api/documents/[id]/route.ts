import { NextResponse } from 'next/server';

import { errorJson, okJson } from '@/lib/api';
import { deleteDocument } from '@/lib/db/documents';
import { AppError } from '@/lib/errors';
import { requireSessionId } from '@/lib/session-server';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete a document and everything derived from it.
 *
 * A single statement does the ownership check and the delete together (`where
 * id = $1 and session_id = $2`), so there is no window between "we verified it
 * is yours" and "we deleted it". Chunks, any staged upload bytes and the
 * feedback rows go with it through `ON DELETE CASCADE`, which is why there is
 * no cleanup ordering to get wrong here and nothing can be orphaned -- the
 * database enforces it, not this handler.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();
    const { id } = await context.params;

    if (!UUID_RE.test(id)) {
      throw new AppError('validation_failed', { detail: 'invalid document id' });
    }

    const deleted = await deleteDocument(sessionId, id);

    if (!deleted) {
      throw new AppError('not_found', { detail: 'document not found for this session' });
    }

    return okJson({ deleted: true });
  } catch (error) {
    return errorJson(error, 'documents/delete', 'database_failed');
  }
}
