import 'server-only';

import { MAX_FILE_SIZE_BYTES, STAGED_UPLOAD_RETENTION_HOURS } from '@/lib/config/rag';
import { AppError } from '@/lib/errors';
import { query, queryOne } from './client';

/**
 * Staged PDF bytes.
 *
 * The uploaded file lives here only between the browser upload and the end of
 * ingestion, in `part_index` order. Once a document reaches `ready` the parts
 * are dropped, so the database is not being used as a file store -- which is
 * exactly why this deployment needs no object-storage service at all.
 *
 * Parts are kept for `failed` documents so the "retry" button can re-run the
 * pipeline without asking the visitor to upload the same file again -- but only
 * for `STAGED_UPLOAD_RETENTION_HOURS`. On a public URL, "keep the bytes until
 * the document succeeds" is a standing invitation to fill a free-tier database
 * with uploads that are designed never to succeed, and an upload nobody has
 * retried within a day is not going to be retried. After the window the
 * document, its status and its failure reason all remain; only the bytes are
 * gone, and retrying asks for the file again instead of silently doing nothing.
 */

/** Write (or overwrite) one part of an upload. */
export async function saveUploadPart(
  documentId: string,
  partIndex: number,
  bytes: Buffer,
): Promise<void> {
  if (bytes.byteLength === 0) {
    throw new AppError('validation_failed', { detail: 'upload part is empty' });
  }

  await query(
    `insert into document_upload_parts (document_id, part_index, bytes, byte_length)
     values ($1, $2, $3, $4)
     on conflict (document_id, part_index)
       do update set bytes = excluded.bytes, byte_length = excluded.byte_length`,
    [documentId, partIndex, bytes, bytes.byteLength],
  );
}

/**
 * Total bytes staged so far, used to enforce the size limit server-side.
 *
 * `excludePartIndex` leaves out one part, so re-sending a part (a retry after a
 * dropped connection) is measured as a replacement rather than as an addition
 * -- otherwise retrying the last slice of a 10 MB file would be rejected for
 * exceeding a limit the finished file does not actually exceed.
 */
export async function getStagedByteLength(
  documentId: string,
  excludePartIndex?: number,
): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `select coalesce(sum(byte_length), 0)::text as total
       from document_upload_parts
      where document_id = $1
        and ($2::int is null or part_index <> $2::int)`,
    [documentId, excludePartIndex ?? null],
  );
  return Number(row?.total ?? 0);
}

/**
 * Reassemble the staged parts into the original file.
 *
 * Ordering by `part_index` is what makes the result byte-identical to what the
 * browser read off disk; the parts may well have been written out of order,
 * since the client is free to retry one of them.
 */
export async function readStagedUpload(documentId: string): Promise<Uint8Array> {
  const rows = await query<{ part_index: number; bytes: Buffer }>(
    'select part_index, bytes from document_upload_parts where document_id = $1 order by part_index asc',
    [documentId],
  );

  if (rows.length === 0) {
    throw new AppError('upload_incomplete', { detail: 'no staged upload parts for document' });
  }

  // A gap means the browser aborted midway; concatenating anyway would hand a
  // truncated file to the PDF parser and surface as "unreadable PDF" instead of
  // the real cause.
  for (const [index, row] of rows.entries()) {
    if (row.part_index !== index) {
      throw new AppError('upload_incomplete', {
        detail: `missing upload part ${index} (found ${row.part_index})`,
      });
    }
  }

  const total = rows.reduce((sum, row) => sum + row.bytes.byteLength, 0);

  if (total === 0) {
    throw new AppError('upload_incomplete', { detail: 'staged upload is empty' });
  }
  if (total > MAX_FILE_SIZE_BYTES) {
    throw new AppError('file_too_large', { detail: `staged upload is ${total} bytes` });
  }

  return new Uint8Array(Buffer.concat(rows.map((row) => row.bytes), total));
}

/** Drop the staged bytes; called once a document is `ready`, and on delete. */
export async function deleteStagedUpload(documentId: string): Promise<void> {
  await query('delete from document_upload_parts where document_id = $1', [documentId]);
}

/**
 * Drop staged bytes that have outlived their purpose.
 *
 * Two cases, both of which otherwise leave `bytea` in the database forever:
 *
 *  - a `failed` document whose retry window has closed;
 *  - an `uploaded` document that was registered and filled but never processed,
 *    which is what an abandoned -- or deliberately abandoned -- upload looks
 *    like.
 *
 * `ready` documents are handled at the end of ingestion and `processing` ones
 * are still using their bytes, so neither is touched here. Returns the number
 * of part rows removed.
 */
export async function pruneExpiredStagedUploads(
  retentionHours: number = STAGED_UPLOAD_RETENTION_HOURS,
): Promise<number> {
  const rows = await query<{ document_id: string }>(
    `delete from document_upload_parts p
      using documents d
      where d.id = p.document_id
        and d.status in ('failed', 'uploaded')
        and p.created_at < timezone('utc', now()) - ($1 || ' hours')::interval
      returning p.document_id`,
    [String(retentionHours)],
  );
  return rows.length;
}
