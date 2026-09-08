'use client';

import type { SupabaseClient } from '@supabase/supabase-js';

import { DOCUMENTS_BUCKET } from '@/lib/rag/bucket';

/**
 * Direct browser -> Supabase Storage upload with real progress reporting.
 *
 * Why not POST the PDF to our own API route? Because routing a 10 MB body
 * through a serverless function means buffering the whole file in the function,
 * paying for that execution time, and running into platform request-body size
 * limits -- all to hand the bytes straight to Storage anyway. Uploading
 * directly is faster, cheaper, and keeps the function budget for the work that
 * actually needs a server (parsing and embedding).
 *
 * Progress: `fetch()` still cannot report upload progress, so this uses XHR
 * against a signed upload URL. The request shape (PUT, multipart body with a
 * `cacheControl` field and the file under the empty-string key) mirrors exactly
 * what `supabase-js`'s own `uploadToSignedUrl` sends.
 */

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export class UploadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'UploadError';
  }
}

export async function uploadPdfWithProgress({
  supabase,
  storagePath,
  file,
  onProgress,
  signal,
}: {
  supabase: SupabaseClient;
  storagePath: string;
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<void> {
  // A signed upload URL carries its own short-lived token, so the PUT does not
  // need the session; the token is only issued because RLS let us create it.
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error || !data) {
    throw new UploadError(error?.message ?? 'failed to create signed upload url');
  }

  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', data.signedUrl, true);
    // Never overwrite: each upload targets a fresh document-id folder, so a
    // collision means something is wrong and should surface as an error.
    xhr.setRequestHeader('x-upsert', 'false');

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      onProgress?.({
        loaded: event.loaded,
        total: event.total,
        percent: Math.round((event.loaded / event.total) * 100),
      });
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
        resolve();
      } else {
        reject(new UploadError(`storage upload failed with status ${xhr.status}`, xhr.status));
      }
    });

    xhr.addEventListener('error', () => reject(new UploadError('network error during upload')));
    xhr.addEventListener('abort', () => reject(new UploadError('upload aborted')));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', file);

    xhr.send(body);
  });
}
