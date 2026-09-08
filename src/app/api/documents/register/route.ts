import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { requireUser } from '@/lib/supabase/server';
import { registerDocumentSchema } from '@/lib/validation/document';

export const runtime = 'nodejs';

/**
 * Register the metadata row for a PDF the browser has just uploaded to Storage.
 *
 * The file itself never passes through this endpoint -- see the README on why
 * the PDF goes browser -> Storage directly rather than through a serverless
 * function.
 *
 * Security: the client proposes a `storagePath`, so it is not trusted. The path
 * is re-derived from the authenticated user id and the document id, and the
 * request is rejected unless it matches exactly. That prevents a caller from
 * registering a row that points at someone else's object.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { supabase, user } = await requireUser();

    const parsed = registerDocumentSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: parsed.error.message });
    }

    const { documentId, title, fileName, storagePath, fileSize } = parsed.data;

    const expectedPrefix = `${user.id}/${documentId}/`;
    if (!storagePath.startsWith(expectedPrefix) || storagePath.includes('..')) {
      throw new AppError('forbidden', { detail: 'storage path does not match the caller' });
    }

    const { data, error } = await supabase
      .from('documents')
      .insert({
        id: documentId,
        user_id: user.id,
        title,
        file_name: fileName,
        storage_path: storagePath,
        file_size: fileSize,
        status: 'uploaded',
      })
      .select('id, title, file_name, status, created_at')
      .single();

    if (error) {
      throw new AppError('database_failed', { cause: error, detail: error.message });
    }

    return okJson({ document: data }, 201);
  } catch (error) {
    return errorJson(error, 'documents/register', 'database_failed');
  }
}
