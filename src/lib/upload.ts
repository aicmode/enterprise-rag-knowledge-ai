'use client';

import { UPLOAD_PART_SIZE_BYTES } from '@/lib/config/rag';

/**
 * Browser -> API upload, in parts, with real progress reporting.
 *
 * Two constraints shape this:
 *
 *  1. **Vercel caps a serverless function request body at 4.5 MB**, while the
 *     product accepts 10 MB PDFs. So the file is sliced client-side into
 *     `UPLOAD_PART_SIZE_BYTES` pieces and each piece is a separate request.
 *     That is what lets this project support 10 MB uploads without adding an
 *     object-storage service purely to work around the limit.
 *
 *  2. **`fetch()` still cannot report upload progress.** XHR can, so each part
 *     is sent with XHR and the per-part `loaded` byte counts are summed into a
 *     single whole-file percentage -- otherwise the progress bar would jump in
 *     visible 3 MB steps on a slow connection.
 */

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

export class UploadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/** Split a file into the byte ranges that will each become one request. */
export function planUploadParts(
  fileSize: number,
  partSize: number = UPLOAD_PART_SIZE_BYTES,
): { index: number; start: number; end: number }[] {
  if (fileSize <= 0) return [];
  if (partSize < 1) throw new Error('planUploadParts: partSize must be >= 1');

  const parts: { index: number; start: number; end: number }[] = [];

  for (let start = 0, index = 0; start < fileSize; start += partSize, index += 1) {
    parts.push({ index, start, end: Math.min(start + partSize, fileSize) });
  }

  return parts;
}

function putPart({
  url,
  blob,
  onBytes,
  signal,
}: {
  url: string;
  blob: Blob;
  onBytes: (loaded: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onBytes(event.loaded);
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onBytes(blob.size);
        resolve();
        return;
      }

      // The route returns the project's standard `{ error: { code, message } }`
      // body, so surface that message rather than a bare status code.
      let message = `upload failed with status ${xhr.status}`;
      try {
        const parsedBody = JSON.parse(xhr.responseText) as { error?: { message?: string } };
        if (parsedBody?.error?.message) message = parsedBody.error.message;
      } catch {
        // Non-JSON error body (a platform-level 413, say); keep the default.
      }

      reject(new UploadError(message, xhr.status));
    });

    xhr.addEventListener('error', () => reject(new UploadError('network error during upload')));
    xhr.addEventListener('abort', () => reject(new UploadError('upload aborted')));

    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    xhr.send(blob);
  });
}

/**
 * Upload `file` to an already-registered document, one part at a time.
 *
 * Parts are sent sequentially rather than in parallel: they are large, the
 * server writes them into one row each, and a phone on a weak connection copes
 * far better with one 3 MB request at a time than with four at once.
 */
export async function uploadPdfWithProgress({
  documentId,
  file,
  onProgress,
  signal,
}: {
  documentId: string;
  file: File;
  onProgress?: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const parts = planUploadParts(file.size);

  if (parts.length === 0) {
    throw new UploadError('file is empty');
  }

  // Bytes confirmed complete, plus the in-flight part's live count. Tracking
  // them separately keeps the total monotonic when a part reports progress.
  let completedBytes = 0;

  const report = (inFlight: number) => {
    const loaded = Math.min(completedBytes + inFlight, file.size);
    onProgress?.({
      loaded,
      total: file.size,
      percent: Math.round((loaded / file.size) * 100),
    });
  };

  report(0);

  for (const part of parts) {
    if (signal?.aborted) throw new UploadError('upload aborted');

    await putPart({
      url: `/api/documents/${documentId}/parts?index=${part.index}`,
      blob: file.slice(part.start, part.end),
      onBytes: report,
      signal,
    });

    completedBytes += part.end - part.start;
    report(0);
  }
}
