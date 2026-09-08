import { NextResponse } from 'next/server';

import { errorJson, okJson } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { DOCUMENTS_BUCKET } from '@/lib/rag/bucket';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireUser } from '@/lib/supabase/server';
import { storagePathBelongsToUser } from '@/lib/validation/document';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Delete a document, its chunks, and its PDF.
 *
 * Ordering matters. The Storage object is removed *first*, because:
 *
 *  - if Storage deletion fails we abort and the DB row survives, so the user
 *    can retry and nothing is orphaned;
 *  - if we deleted the row first and Storage then failed, the PDF would be
 *    stranded in the bucket with nothing referencing it -- invisible, still
 *    billed, and impossible to clean up from the UI.
 *
 * `document_chunks` is removed by `ON DELETE CASCADE`, so chunks can never
 * outlive their document.
 */
export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { supabase, user } = await requireUser();
    const { id } = await context.params;

    if (!UUID_RE.test(id)) {
      throw new AppError('validation_failed', { detail: 'invalid document id' });
    }

    // Ownership check through the user-scoped client (RLS applies).
    const { data: document, error: fetchError } = await supabase
      .from('documents')
      .select('id, storage_path')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (fetchError) {
      throw new AppError('database_failed', { cause: fetchError, detail: fetchError.message });
    }
    if (!document) {
      throw new AppError('not_found', { detail: 'document not found for user' });
    }
    if (!storagePathBelongsToUser(document.storage_path, user.id)) {
      throw new AppError('forbidden', { detail: 'storage path does not belong to the user' });
    }

    const admin = createAdminClient();
    const { error: storageError } = await admin.storage
      .from(DOCUMENTS_BUCKET)
      .remove([document.storage_path]);

    if (storageError) {
      throw new AppError('storage_failed', {
        cause: storageError,
        detail: storageError.message,
      });
    }

    const { error: deleteError } = await supabase
      .from('documents')
      .delete()
      .eq('id', id)
      .eq('user_id', user.id);

    if (deleteError) {
      throw new AppError('database_failed', { cause: deleteError, detail: deleteError.message });
    }

    return okJson({ deleted: true });
  } catch (error) {
    return errorJson(error, 'documents/delete', 'database_failed');
  }
}
