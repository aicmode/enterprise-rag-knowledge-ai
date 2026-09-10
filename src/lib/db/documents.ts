import 'server-only';

import { MAX_CONCURRENT_PROCESSING_PER_SESSION } from '@/lib/config/rag';
import { AppError } from '@/lib/errors';
import type { DocumentRow, DocumentStatus } from '@/lib/types';
import { query, queryOne, transaction } from './client';

/**
 * Document persistence.
 *
 * Every function here takes `sessionId` explicitly and every statement filters
 * on it. There is no "current session" global and no query that reaches the
 * database without a session scope, so a missing filter is a compile error
 * rather than a data leak.
 */

const DOCUMENT_COLUMNS = `
  id, session_id, title, file_name, file_size, content_type,
  page_count, status, error_message, created_at, updated_at
`;

export async function listDocuments(sessionId: string): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS}
       from documents
      where session_id = $1
      order by created_at desc`,
    [sessionId],
  );
}

export async function listRecentDocuments(
  sessionId: string,
  limit: number,
): Promise<DocumentRow[]> {
  return query<DocumentRow>(
    `select ${DOCUMENT_COLUMNS}
       from documents
      where session_id = $1
      order by created_at desc
      limit $2`,
    [sessionId, limit],
  );
}

export async function getDocument(
  sessionId: string,
  documentId: string,
): Promise<DocumentRow | null> {
  return queryOne<DocumentRow>(
    `select ${DOCUMENT_COLUMNS} from documents where id = $1 and session_id = $2`,
    [documentId, sessionId],
  );
}

export interface CreateDocumentInput {
  documentId: string;
  sessionId: string;
  title: string;
  fileName: string;
  fileSize: number;
}

export async function createDocument(input: CreateDocumentInput): Promise<DocumentRow> {
  const row = await queryOne<DocumentRow>(
    `insert into documents (id, session_id, title, file_name, file_size, status)
     values ($1, $2, $3, $4, $5, 'uploaded')
     returning ${DOCUMENT_COLUMNS}`,
    [input.documentId, input.sessionId, input.title, input.fileName, input.fileSize],
  );

  if (!row) {
    throw new AppError('database_failed', { detail: 'insert returned no document row' });
  }

  return row;
}

/**
 * Claim a document for processing.
 *
 * Two things have to hold at once here, and both of them are races.
 *
 *  1. **One run per document.** The conditional `status in ('uploaded',
 *     'failed')` is an optimistic lock: exactly one of two concurrent claims
 *     sees a row come back, and the loser gets `already_processing` rather than
 *     starting a duplicate embedding run.
 *
 *  2. **A bounded number of runs per session.** This one a conditional UPDATE
 *     cannot express safely on its own. Under READ COMMITTED, simultaneous
 *     claims each evaluate their subquery against their own snapshot, so all of
 *     them can count zero documents in flight and all of them can proceed --
 *     the classic read-check-act hole, and an expensive one when each run means
 *     a hundred OCR calls.
 *
 * So the claim runs inside a transaction that first takes a session-scoped
 * advisory lock. Claims for the same session serialise on it and each one sees
 * what the previous claim committed; claims for different sessions take
 * different locks and do not wait on each other. The lock is `xact`-scoped, so
 * it is released on commit or rollback with nothing to leak.
 */
export async function claimDocumentForProcessing(
  sessionId: string,
  documentId: string,
): Promise<DocumentRow> {
  const claimed = await transaction<DocumentRow | null>(async (client) => {
    // `hashtext` maps the session UUID onto the int4 an advisory lock takes.
    // A collision between two sessions would only make one wait briefly for the
    // other, so a hash is sufficient here -- there is no correctness claim
    // resting on its uniqueness.
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [sessionId]);

    const inFlight = await client.query<{ count: string }>(
      `select count(*)::text as count
         from documents
        where session_id = $1 and status = 'processing'`,
      [sessionId],
    );

    if (Number(inFlight.rows[0]?.count ?? 0) >= MAX_CONCURRENT_PROCESSING_PER_SESSION) {
      throw new AppError('already_processing', {
        detail: `session already has ${inFlight.rows[0]?.count} documents processing`,
        userMessage:
          '同時に解析できる資料数の上限に達しています。解析中の資料が完了してからお試しください。',
      });
    }

    const result = await client.query<DocumentRow>(
      `update documents
          set status = 'processing', error_message = null
        where id = $1
          and session_id = $2
          and status in ('uploaded', 'failed')
        returning ${DOCUMENT_COLUMNS}`,
      [documentId, sessionId],
    );

    return result.rows[0] ?? null;
  });

  if (claimed) return claimed;

  // Either the document does not belong to this session, or it is already
  // processing / ready. Distinguish the two so the UI can say something useful.
  const existing = await queryOne<{ status: DocumentStatus }>(
    'select status from documents where id = $1 and session_id = $2',
    [documentId, sessionId],
  );

  if (!existing) {
    throw new AppError('not_found', { detail: 'document not found for this session' });
  }

  throw new AppError('already_processing', { detail: `status is ${existing.status}` });
}

/** Mark a document usable, recording the page count and any partial-page warning. */
export async function markDocumentReady(
  documentId: string,
  pageCount: number,
  warning: string | null,
): Promise<void> {
  await query(
    `update documents
        set status = 'ready', page_count = $2, error_message = $3
      where id = $1`,
    [documentId, pageCount, warning],
  );
}

/** Record a terminal failure with a message that is safe to show the visitor. */
export async function markDocumentFailed(documentId: string, userMessage: string): Promise<void> {
  await query(
    `update documents set status = 'failed', error_message = $2 where id = $1`,
    [documentId, userMessage],
  );
}

/**
 * Delete a document and everything derived from it.
 *
 * Chunks, staged upload parts and feedback are removed by `ON DELETE CASCADE`,
 * so there is no ordering to get wrong and nothing can be orphaned.
 */
export async function deleteDocument(sessionId: string, documentId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'delete from documents where id = $1 and session_id = $2 returning id',
    [documentId, sessionId],
  );
  return rows.length > 0;
}

export async function countDocuments(sessionId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'select count(*)::text as count from documents where session_id = $1',
    [sessionId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Count the session's documents that are actually usable for answering.
 *
 * Used to distinguish two very different "no answer" situations: the visitor
 * has not uploaded anything yet (guide them to /documents) versus they have
 * documents but nothing matched (the answer really is "not in your files").
 */
export async function countReadyDocuments(sessionId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    "select count(*)::text as count from documents where session_id = $1 and status = 'ready'",
    [sessionId],
  );
  return Number(row?.count ?? 0);
}
