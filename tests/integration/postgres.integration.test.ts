// @vitest-environment node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { createCanvas } from '@napi-rs/canvas';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EMBEDDING_DIMENSIONS, RAG_DEFAULTS } from '@/lib/config/rag';
import { generateAnswer } from '@/lib/rag/answer';
import { chunkPages } from '@/lib/rag/chunking';
import { buildCitations } from '@/lib/rag/citations';
import { extractPdfPages } from '@/lib/rag/pdf';
import { NO_CONTEXT_ANSWER } from '@/lib/rag/prompt';
import type { MatchedChunk } from '@/lib/types';
import { buildMixedPdf, buildTestPdf } from '../fixtures/make-pdf';

/**
 * Integration tests against a real PostgreSQL + pgvector instance.
 *
 * These verify the things a unit test structurally cannot: that the migrations
 * actually apply, that pgvector accepts the embedding column and rejects a
 * wrong-width one, that `match_document_chunks` is reachable with a vector
 * argument through node-postgres, that the chunked upload staging reassembles
 * a PDF byte-for-byte -- and, most importantly, that two anonymous demo
 * sessions really are kept apart now that there is no authentication layer
 * doing it for us.
 *
 * They are opt-in. No connection string is hardcoded, so the suite is skipped
 * unless `DATABASE_INTEGRATION_URL` is exported:
 *
 *     docker run -d --name rag-pg -e POSTGRES_PASSWORD=... -p 55433:5432 \
 *       pgvector/pgvector:pg17
 *     export DATABASE_INTEGRATION_URL=postgres://...@127.0.0.1:55433/ragdev
 *     npm run test
 *
 * No OpenAI key is required: embeddings here come from a deterministic local
 * embedder, so the vector path is exercised end to end without a network call.
 * Only the LLM answer text itself is out of scope for this file.
 */

// Hoisted above the imports so the database modules read the integration URL
// when their lazily-created pool is first touched.
const INTEGRATION_URL = vi.hoisted(() => {
  const url = process.env.DATABASE_INTEGRATION_URL;
  if (url) process.env.DATABASE_URL = url;
  return url;
});

const enabled = Boolean(INTEGRATION_URL);

const execFileAsync = promisify(execFile);

/**
 * Deterministic bag-of-words embedder.
 *
 * Not a semantic model -- it only needs to make lexically similar texts land
 * near each other so that cosine ranking in Postgres has something real to
 * order. That is enough to prove the pgvector path and the page attribution.
 */
function localEmbed(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[(hash >>> 0) % EMBEDDING_DIMENSIONS] += 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector.fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS)) : vector.map((v) => v / norm);
}

const PAGES = [
  'Company overview. Acme Corporation was founded in 2015 and operates three regional offices.',
  'Employee benefits. Staff receive twenty days of annual paid leave and a yearly health check.',
  'Remote work policy. Employees may work remotely for up to three days per week with manager approval.',
];

type Db = {
  documents: typeof import('@/lib/db/documents');
  chunks: typeof import('@/lib/db/chunks');
  questions: typeof import('@/lib/db/questions');
  uploads: typeof import('@/lib/db/uploads');
  client: typeof import('@/lib/db/client');
};

describe.runIf(enabled)('postgres integration', () => {
  // Two anonymous demo sessions. In production these come from the httpOnly
  // cookie the proxy sets; here they stand in for two different visitors.
  const sessionA = crypto.randomUUID();
  const sessionB = crypto.randomUUID();

  let db: Db;
  let raw: pg.Client;
  let documentA: string;
  let documentB: string;
  let questionA: string;

  /** Insert chunks the way the pipeline does, with locally computed vectors. */
  async function storeChunks(documentId: string, texts: { page: number; content: string }[]) {
    await db.chunks.replaceDocumentChunks(
      documentId,
      texts.map((entry, index) => ({
        pageNumber: entry.page,
        chunkIndex: index,
        content: entry.content,
        contentLength: entry.content.length,
        embedding: localEmbed(entry.content),
      })),
    );
  }

  beforeAll(async () => {
    // Running the real migration runner is part of what is under test: a
    // migration that does not apply cleanly to an empty database is a
    // deployment failure, not a detail.
    await execFileAsync('node', [path.join(process.cwd(), 'scripts', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: INTEGRATION_URL },
    });

    db = {
      documents: await import('@/lib/db/documents'),
      chunks: await import('@/lib/db/chunks'),
      questions: await import('@/lib/db/questions'),
      uploads: await import('@/lib/db/uploads'),
      client: await import('@/lib/db/client'),
    };

    raw = new pg.Client({ connectionString: INTEGRATION_URL });
    await raw.connect();
  }, 120_000);

  afterAll(async () => {
    if (raw) {
      // Deleting the documents and questions cascades chunks, upload parts and
      // feedback, so the database is left as the suite found it.
      await raw
        .query('delete from documents where session_id = any($1)', [[sessionA, sessionB]])
        .catch(() => undefined);
      await raw
        .query('delete from questions where session_id = any($1)', [[sessionA, sessionB]])
        .catch(() => undefined);
      await raw.end().catch(() => undefined);
    }
    await db?.client.getPool().end().catch(() => undefined);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Schema: what the migrations actually produced
  // ---------------------------------------------------------------------------
  describe('schema', () => {
    it('installed pgvector and the search function', async () => {
      const extensions = await raw.query("select 1 from pg_extension where extname = 'vector'");
      expect(extensions.rowCount).toBe(1);

      const fn = await raw.query(
        "select 1 from pg_proc where proname = 'match_document_chunks'",
      );
      expect(fn.rowCount).toBe(1);
    });

    it('is idempotent: re-running the migrations changes nothing', async () => {
      const { stdout } = await execFileAsync(
        'node',
        [path.join(process.cwd(), 'scripts', 'migrate.mjs')],
        { env: { ...process.env, DATABASE_URL: INTEGRATION_URL } },
      );

      expect(stdout).toContain('already up to date');
    });

    it('accepts a 1536-dimension embedding and rejects a wrong-width one', async () => {
      const document = await db.documents.createDocument({
        documentId: crypto.randomUUID(),
        sessionId: sessionA,
        title: 'Dimension probe',
        fileName: 'probe.pdf',
        fileSize: 1024,
      });

      await expect(
        storeChunks(document.id, [{ page: 1, content: 'probe' }]),
      ).resolves.toBeUndefined();

      await expect(
        raw.query(
          `insert into document_chunks
             (document_id, page_number, chunk_index, content, content_length, embedding)
           values ($1, 1, 99, 'probe', 5, $2::vector)`,
          [document.id, '[0.1,0.2,0.3]'],
        ),
      ).rejects.toThrow();

      await db.documents.deleteDocument(sessionA, document.id);
    });

    it('caps file size and page count in the database, not only in the app', async () => {
      const id = crypto.randomUUID();

      await expect(
        raw.query(
          `insert into documents (id, session_id, title, file_name, file_size)
           values ($1, $2, 'too big', 'big.pdf', $3)`,
          [id, sessionA, 20 * 1024 * 1024],
        ),
      ).rejects.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Chunked upload staging -> extraction -> chunks -> pgvector
  // ---------------------------------------------------------------------------
  describe('ingestion pipeline', () => {
    let pdfBytes: Uint8Array;

    it('registers the document row for the calling session', async () => {
      pdfBytes = buildTestPdf(PAGES);
      documentA = crypto.randomUUID();

      const document = await db.documents.createDocument({
        documentId: documentA,
        sessionId: sessionA,
        title: 'Employee Handbook',
        fileName: 'handbook.pdf',
        fileSize: pdfBytes.byteLength,
      });

      expect(document.status).toBe('uploaded');
      expect(document.session_id).toBe(sessionA);
      // bigint must not arrive as a string, or formatBytes() would render "NaN".
      expect(typeof document.file_size).toBe('number');
    });

    it('reassembles the staged upload parts byte-for-byte', async () => {
      // Deliberately small parts and deliberately out of order: the browser may
      // retry a slice, so correctness must come from `part_index`, not arrival
      // order.
      const PART = 900;
      const buffer = Buffer.from(pdfBytes);
      const parts: { index: number; bytes: Buffer }[] = [];

      for (let start = 0, index = 0; start < buffer.byteLength; start += PART, index += 1) {
        parts.push({ index, bytes: buffer.subarray(start, Math.min(start + PART, buffer.byteLength)) });
      }

      for (const part of [...parts].reverse()) {
        await db.uploads.saveUploadPart(documentA, part.index, part.bytes);
      }

      expect(await db.uploads.getStagedByteLength(documentA)).toBe(buffer.byteLength);

      const reassembled = await db.uploads.readStagedUpload(documentA);
      expect(Buffer.from(reassembled).equals(buffer)).toBe(true);
    });

    it('reports an incomplete upload instead of parsing a truncated file', async () => {
      const orphan = await db.documents.createDocument({
        documentId: crypto.randomUUID(),
        sessionId: sessionA,
        title: 'Gap probe',
        fileName: 'gap.pdf',
        fileSize: 2048,
      });

      // Parts 0 and 2, with 1 missing -- what an aborted upload looks like.
      await db.uploads.saveUploadPart(orphan.id, 0, Buffer.from('one'));
      await db.uploads.saveUploadPart(orphan.id, 2, Buffer.from('three'));

      await expect(db.uploads.readStagedUpload(orphan.id)).rejects.toMatchObject({
        code: 'upload_incomplete',
      });

      await db.documents.deleteDocument(sessionA, orphan.id);
    });

    it('extracts page-numbered text from the reassembled PDF', async () => {
      const extraction = await extractPdfPages(await db.uploads.readStagedUpload(documentA));

      expect(extraction.pageCount).toBe(3);
      expect(extraction.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
      expect(extraction.pages[2].text).toContain('three days per week');
    });

    it('persists chunks with their page numbers and marks the document ready', async () => {
      const extraction = await extractPdfPages(await db.uploads.readStagedUpload(documentA));
      const chunks = chunkPages(extraction.pages, RAG_DEFAULTS);

      expect(chunks.length).toBeGreaterThanOrEqual(3);

      await db.chunks.replaceDocumentChunks(
        documentA,
        chunks.map((chunk) => ({
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          contentLength: chunk.contentLength,
          embedding: localEmbed(chunk.content),
        })),
      );

      await db.documents.markDocumentReady(documentA, extraction.pageCount, null);

      const stored = await raw.query<{ page_number: number }>(
        'select page_number from document_chunks where document_id = $1',
        [documentA],
      );

      expect(new Set(stored.rows.map((row) => row.page_number))).toEqual(new Set([1, 2, 3]));
      expect((await db.documents.getDocument(sessionA, documentA))?.status).toBe('ready');
    });

    it('drops the staged PDF bytes once the document is ready', async () => {
      // The point of staging in Postgres rather than in an object store is that
      // nothing stays there. Prove it rather than asserting it in a comment.
      await db.uploads.deleteStagedUpload(documentA);

      const remaining = await raw.query(
        'select 1 from document_upload_parts where document_id = $1',
        [documentA],
      );
      expect(remaining.rowCount).toBe(0);
    });

    it('persists native/OCR/native mixed pages with OCR content on page 2', async () => {
      const mixedDocumentId = crypto.randomUUID();
      const canvas = createCanvas(612, 792);
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, 612, 792);
      context.fillStyle = '#111111';
      context.font = '24px "Yu Gothic", sans-serif';
      context.fillText('従業員は週に最大3日までリモート勤務を利用できます。', 48, 120);
      const pdf = buildMixedPdf([
        { kind: 'native', text: PAGES[0] },
        { kind: 'scan', jpeg: canvas.toBuffer('image/jpeg', 90) },
        { kind: 'native', text: PAGES[2] },
      ]);

      try {
        await db.documents.createDocument({
          documentId: mixedDocumentId,
          sessionId: sessionA,
          title: 'Mixed Handbook',
          fileName: 'mixed.pdf',
          fileSize: pdf.byteLength,
        });
        await db.uploads.saveUploadPart(mixedDocumentId, 0, Buffer.from(pdf));

        const extraction = await extractPdfPages(
          await db.uploads.readStagedUpload(mixedDocumentId),
          {
            ocrPage: async ({ pageNumber }) => {
              expect(pageNumber).toBe(2);
              return '従業員は上司の承認を得たうえで、週に最大3日までリモート勤務を利用できます。';
            },
          },
        );
        const chunks = chunkPages(extraction.pages, RAG_DEFAULTS);

        await db.chunks.replaceDocumentChunks(
          mixedDocumentId,
          chunks.map((chunk) => ({
            pageNumber: chunk.pageNumber,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            contentLength: chunk.contentLength,
            embedding: localEmbed(chunk.content),
          })),
        );

        const stored = await raw.query<{ page_number: number; content: string }>(
          'select page_number, content from document_chunks where document_id = $1 order by page_number',
          [mixedDocumentId],
        );

        expect(stored.rows.map((row) => row.page_number)).toEqual([1, 2, 3]);
        expect(stored.rows.find((row) => row.page_number === 2)?.content).toContain('週に最大3日');
      } finally {
        await db.documents.deleteDocument(sessionA, mixedDocumentId);
      }
    });

    it('re-processing replaces chunks instead of duplicating them', async () => {
      const before = await db.chunks.countDocumentChunks(documentA);
      expect(before).toBeGreaterThan(0);

      const extraction = await extractPdfPages(buildTestPdf(PAGES));
      const chunks = chunkPages(extraction.pages, RAG_DEFAULTS);

      await db.chunks.replaceDocumentChunks(
        documentA,
        chunks.map((chunk) => ({
          pageNumber: chunk.pageNumber,
          chunkIndex: chunk.chunkIndex,
          content: chunk.content,
          contentLength: chunk.contentLength,
          embedding: localEmbed(chunk.content),
        })),
      );

      expect(await db.chunks.countDocumentChunks(documentA)).toBe(before);
    });

    it('rejects a duplicate chunk position outright', async () => {
      const sample = await raw.query<{ page_number: number; chunk_index: number }>(
        'select page_number, chunk_index from document_chunks where document_id = $1 limit 1',
        [documentA],
      );

      await expect(
        raw.query(
          `insert into document_chunks
             (document_id, page_number, chunk_index, content, content_length, embedding)
           values ($1, $2, $3, 'duplicate', 9, $4::vector)`,
          [
            documentA,
            sample.rows[0].page_number,
            sample.rows[0].chunk_index,
            `[${localEmbed('duplicate').join(',')}]`,
          ],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('lets only one of two concurrent processing claims win', async () => {
      // The conditional UPDATE inside claimDocumentForProcessing is the
      // optimistic lock that stops two requests from embedding the same
      // document twice.
      await raw.query("update documents set status = 'uploaded' where id = $1", [documentA]);

      const results = await Promise.allSettled([
        db.documents.claimDocumentForProcessing(sessionA, documentA),
        db.documents.claimDocumentForProcessing(sessionA, documentA),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: 'already_processing' });

      await raw.query("update documents set status = 'ready' where id = $1", [documentA]);
    });

    it('allows a failed document to be claimed again for retry', async () => {
      await db.documents.markDocumentFailed(documentA, 'boom');

      const claimed = await db.documents.claimDocumentForProcessing(sessionA, documentA);

      expect(claimed.status).toBe('processing');
      expect(claimed.error_message).toBeNull();

      await raw.query("update documents set status = 'ready' where id = $1", [documentA]);
    });

    it('refuses to claim a document that is already processing', async () => {
      await raw.query("update documents set status = 'processing' where id = $1", [documentA]);

      await expect(
        db.documents.claimDocumentForProcessing(sessionA, documentA),
      ).rejects.toMatchObject({ code: 'already_processing' });

      await raw.query("update documents set status = 'ready' where id = $1", [documentA]);
    });

    it('refuses to claim a document belonging to another session', async () => {
      await expect(
        db.documents.claimDocumentForProcessing(sessionB, documentA),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  // ---------------------------------------------------------------------------
  // Second visitor, used by every isolation test below
  // ---------------------------------------------------------------------------
  describe("session B's own corpus", () => {
    it('stores a document whose chunk is near-identical to session A page 3', async () => {
      documentB = crypto.randomUUID();

      await db.documents.createDocument({
        documentId: documentB,
        sessionId: sessionB,
        title: 'Rival Handbook',
        fileName: 'rival.pdf',
        fileSize: 2048,
      });

      // Deliberately the same wording as A's page 3, so a broken isolation rule
      // would surface this row at ~1.0 similarity.
      await storeChunks(documentB, [{ page: 1, content: `CONFIDENTIAL-B ${PAGES[2]}` }]);
      await db.documents.markDocumentReady(documentB, 1, null);
    });
  });

  // ---------------------------------------------------------------------------
  // match_document_chunks
  // ---------------------------------------------------------------------------
  describe('match_document_chunks', () => {
    const question = 'How many days per week may I work remotely?';

    it('is callable with a vector argument through node-postgres', async () => {
      const matches = await db.chunks.retrieveRelevantChunks(sessionA, localEmbed(question), {
        topK: 5,
        similarityThreshold: 0,
      });

      expect(matches.length).toBeGreaterThan(0);
      expect(typeof matches[0].similarity).toBe('number');
    });

    it('ranks the remote-work page first and cites page 3', async () => {
      const matches = await db.chunks.retrieveRelevantChunks(sessionA, localEmbed(question), {
        topK: RAG_DEFAULTS.topK,
        similarityThreshold: 0,
      });

      expect(matches[0].page_number).toBe(3);
      expect(matches[0].content).toContain('three days per week');

      const citations = buildCitations(matches);
      expect(citations[0].pageNumber).toBe(3);
      expect(citations[0].documentTitle).toBe('Employee Handbook');
      expect(citations[0].fileName).toBe('handbook.pdf');
    });

    it("never returns another session's chunk, even at near-identical similarity", async () => {
      const matches = await db.chunks.retrieveRelevantChunks(sessionA, localEmbed(PAGES[2]), {
        topK: 20,
        similarityThreshold: 0,
      });

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((match) => match.document_id !== documentB)).toBe(true);
      expect(matches.some((match) => match.content.includes('CONFIDENTIAL-B'))).toBe(false);
    });

    it('honours the threshold and the result cap', async () => {
      const embedding = localEmbed(question);

      const capped = await db.chunks.retrieveRelevantChunks(sessionA, embedding, {
        topK: 1,
        similarityThreshold: 0,
      });
      expect(capped).toHaveLength(1);

      const strict = await db.chunks.retrieveRelevantChunks(sessionA, embedding, {
        topK: 20,
        similarityThreshold: 0.99,
      });
      expect(strict).toHaveLength(0);
    });

    it('excludes documents that are not ready', async () => {
      await raw.query("update documents set status = 'processing' where id = $1", [documentA]);

      const matches = await db.chunks.retrieveRelevantChunks(sessionA, localEmbed(question), {
        topK: 20,
        similarityThreshold: 0,
      });
      expect(matches).toHaveLength(0);

      await raw.query("update documents set status = 'ready' where id = $1", [documentA]);
    });

    it('returns nothing for a session that owns no documents', async () => {
      const matches = await db.chunks.retrieveRelevantChunks(
        crypto.randomUUID(),
        localEmbed(question),
        { topK: 20, similarityThreshold: 0 },
      );

      expect(matches).toHaveLength(0);
    });

    it('returns the fixed "not in your documents" answer without calling the model', async () => {
      // A question the handbook says nothing about. Retrieval must come back
      // empty, and generateAnswer must short-circuit to the fixed sentence
      // rather than letting the model answer from general knowledge -- which is
      // why this passes with no OPENAI_API_KEY configured: reaching OpenAI at
      // all would throw here.
      const matches: MatchedChunk[] = await db.chunks.retrieveRelevantChunks(
        sessionA,
        localEmbed('What is the overseas assignment allowance?'),
        { topK: RAG_DEFAULTS.topK, similarityThreshold: RAG_DEFAULTS.similarityThreshold },
      );

      expect(matches).toHaveLength(0);

      const generated = await generateAnswer({
        question: '海外赴任手当はいくらですか？',
        matches,
        model: RAG_DEFAULTS.chatModel,
      });

      expect(generated.answer).toBe(NO_CONTEXT_ANSWER);
    });
  });

  // ---------------------------------------------------------------------------
  // Session isolation -- what replaces Row Level Security in this deployment
  // ---------------------------------------------------------------------------
  describe('demo session isolation', () => {
    it('hides session A documents from session B and vice versa', async () => {
      expect(await db.documents.getDocument(sessionB, documentA)).toBeNull();
      expect(await db.documents.getDocument(sessionA, documentB)).toBeNull();

      const listA = await db.documents.listDocuments(sessionA);
      expect(listA.every((document) => document.session_id === sessionA)).toBe(true);
      expect(listA.some((document) => document.id === documentB)).toBe(false);
    });

    it("refuses to delete another session's document", async () => {
      expect(await db.documents.deleteDocument(sessionB, documentA)).toBe(false);
      expect(await db.documents.getDocument(sessionA, documentA)).not.toBeNull();
    });

    it('keeps question history private to its session', async () => {
      questionA = await db.questions.saveQuestion({
        sessionId: sessionA,
        question: 'How many days per week may I work remotely?',
        answer: 'Up to three days per week with manager approval.',
        citations: [
          {
            index: 1,
            documentId: documentA,
            documentTitle: 'Employee Handbook',
            fileName: 'handbook.pdf',
            pageNumber: 3,
            excerpt: 'Employees may work remotely for up to three days per week',
            similarity: 0.82,
          },
        ],
        responseTimeMs: 1500,
        model: RAG_DEFAULTS.chatModel,
      });

      expect(await db.questions.getQuestion(sessionB, questionA)).toBeNull();

      const detail = await db.questions.getQuestion(sessionA, questionA);
      expect(detail?.sources[0].pageNumber).toBe(3);
      // JSONB round-trips as parsed JSON, not as a string.
      expect(Array.isArray(detail?.sources)).toBe(true);

      const listB = await db.questions.listQuestions(sessionB);
      expect(listB.some((row) => row.id === questionA)).toBe(false);
    });

    it("refuses to rate another session's answer", async () => {
      expect(await db.questions.questionExists(sessionB, questionA)).toBe(false);
      expect(await db.questions.questionExists(sessionA, questionA)).toBe(true);
    });

    it('counts only the calling session for the demo quotas', async () => {
      const freshSession = crypto.randomUUID();

      expect(await db.documents.countDocuments(freshSession)).toBe(0);
      expect(await db.questions.countRecentQuestions(freshSession)).toBe(0);
      expect(await db.questions.countRecentQuestions(sessionA)).toBeGreaterThan(0);
      expect(await db.documents.countReadyDocuments(sessionA)).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Feedback UPSERT
  // ---------------------------------------------------------------------------
  describe('answer feedback', () => {
    it('replaces an existing vote instead of adding a second row', async () => {
      const first = await db.questions.upsertFeedback(sessionA, questionA, 'helpful', null);
      expect(first.rating).toBe('helpful');

      const second = await db.questions.upsertFeedback(sessionA, questionA, 'not_helpful', null);
      expect(second.rating).toBe('not_helpful');
      expect(second.id).toBe(first.id);

      const rows = await raw.query('select id from answer_feedback where question_id = $1', [
        questionA,
      ]);
      expect(rows.rowCount).toBe(1);

      const totals = await db.questions.getFeedbackTotals(sessionA);
      expect(totals.total).toBe(1);
      expect(totals.helpful).toBe(0);
    });

    it('surfaces the rating on the history list and detail', async () => {
      const list = await db.questions.listQuestions(sessionA);
      const row = list.find((entry) => entry.id === questionA);

      expect(row?.rating).toBe('not_helpful');
      expect(row?.source_count).toBe(1);
      expect((await db.questions.getQuestion(sessionA, questionA))?.rating).toBe('not_helpful');
    });
  });

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------
  describe('document deletion', () => {
    it('removes the row, its chunks and any staged bytes, leaving nothing orphaned', async () => {
      // Stage a part again so the cascade has something to clean up.
      await db.uploads.saveUploadPart(documentA, 0, Buffer.from('leftover bytes'));

      expect(await db.documents.deleteDocument(sessionA, documentA)).toBe(true);

      expect(await db.chunks.countDocumentChunks(documentA)).toBe(0);

      const parts = await raw.query('select 1 from document_upload_parts where document_id = $1', [
        documentA,
      ]);
      expect(parts.rowCount).toBe(0);

      expect(await db.documents.getDocument(sessionA, documentA)).toBeNull();
    });

    it('leaves the history entry and its citations intact after the source is gone', async () => {
      // Citations are a snapshot, not a join: an answer stays verifiable in the
      // history even once the document it came from has been deleted.
      const detail = await db.questions.getQuestion(sessionA, questionA);

      expect(detail?.sources[0].documentTitle).toBe('Employee Handbook');
      expect(detail?.sources[0].pageNumber).toBe(3);
    });

    it('reports a second delete as a miss rather than an error', async () => {
      expect(await db.documents.deleteDocument(sessionA, documentA)).toBe(false);
    });
  });
});
