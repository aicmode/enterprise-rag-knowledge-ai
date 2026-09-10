// @vitest-environment node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { EMBEDDING_DIMENSIONS, MAX_CONCURRENT_PROCESSING_PER_SESSION } from '@/lib/config/rag';
import { DEMO_LIMITS } from '@/lib/security/demo-limits';
import { buildTestPdf } from '../fixtures/make-pdf';

/**
 * Public-demo abuse protection, against a real PostgreSQL.
 *
 * The threat this file exists for is specific and cheap to mount: the demo has
 * no accounts, so the only thing tying one request to the next used to be a
 * cookie the caller owns. Deleting it -- or pressing "reset" -- produced a new
 * session id and a brand-new empty quota, which made every limit in the
 * application advisory. Every OpenAI call the demo makes is billed to the
 * owner, so that is a cost bug, not a theoretical one.
 *
 * A unit test cannot settle any of this. Atomicity under concurrency is a
 * property of the SQL statement, not of the TypeScript around it; "a new
 * session does not reset the budget" is a property of what the rows are keyed
 * on; and "no raw IP is stored" is a claim about the table's actual contents.
 * So this runs against the database, opt-in exactly like the other integration
 * suite:
 *
 *     export DATABASE_INTEGRATION_URL=postgres://...@127.0.0.1:55433/ragdev
 *     npm run test
 *
 * No OpenAI key is needed or wanted: the two modules that would spend money are
 * mocked, which is also what lets the cost-guard tests assert the thing that
 * actually matters -- that a refused request never reaches them.
 */

const INTEGRATION_URL = vi.hoisted(() => {
  const url = process.env.DATABASE_INTEGRATION_URL;
  if (url) process.env.DATABASE_URL = url;
  // A fixed secret keeps fingerprints reproducible within the run and keeps the
  // env module from warning about an ephemeral one.
  process.env.DEMO_RATE_LIMIT_SECRET ??= 'integration-test-demo-rate-limit-secret';
  process.env.DEMO_TRUST_PROXY_HEADERS ??= '1';
  return url;
});

const enabled = Boolean(INTEGRATION_URL);
const execFileAsync = promisify(execFile);

/**
 * Stand-ins for the two modules that cost money.
 *
 * They are spies rather than stubs on purpose: "the limit returned 429" is only
 * half the requirement. The other half is that OpenAI was never called, and the
 * only way to state that is to watch the call.
 */
const embedTexts = vi.hoisted(() => vi.fn());
const ocrPageImage = vi.hoisted(() => vi.fn());

vi.mock('@/lib/rag/embedding', () => ({
  embedTexts,
  embedQuery: vi.fn(),
  batchItems: vi.fn(),
}));

vi.mock('@/lib/rag/ocr', () => ({ ocrPageImage }));

type Modules = {
  documents: typeof import('@/lib/db/documents');
  uploads: typeof import('@/lib/db/uploads');
  client: typeof import('@/lib/db/client');
  ingest: typeof import('@/lib/rag/ingest');
  rateLimit: typeof import('@/lib/security/rate-limit');
  clientKey: typeof import('@/lib/security/client-key');
  retention: typeof import('@/lib/security/retention');
};

describe.runIf(enabled)('demo abuse protection', () => {
  let m: Modules;
  let raw: pg.Client;

  /** Client keys used by this suite, so cleanup can find their rows. */
  const usedKeys = new Set<string>();

  /**
   * A fresh, unused fingerprint, so tests never inherit each other's counters.
   *
   * Derived from a unique address per call rather than a random one: two tests
   * that happened to draw the same address would share a daily budget, and the
   * failure would look like a bug in the limit rather than in the fixture.
   */
  let keyCounter = 0;
  const keyRun = crypto.randomUUID();

  function freshKey(): string {
    keyCounter += 1;
    const key = m.clientKey.deriveClientKey(`test-client:${keyRun}:${keyCounter}`);
    usedKeys.add(key);
    return key;
  }

  /** Register a document with staged bytes, the way the upload routes do. */
  async function stageDocument(
    sessionId: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const documentId = crypto.randomUUID();
    await m.documents.createDocument({
      documentId,
      sessionId,
      title: 'Abuse fixture',
      fileName: 'fixture.pdf',
      fileSize: bytes.byteLength,
    });
    await m.uploads.saveUploadPart(documentId, 0, Buffer.from(bytes));
    return documentId;
  }

  const sessions: string[] = [];

  function freshSession(): string {
    const id = crypto.randomUUID();
    sessions.push(id);
    return id;
  }

  beforeAll(async () => {
    // Migration 0003 has to apply cleanly to whatever state the database is in,
    // including one that already has 0001 and 0002.
    await execFileAsync('node', [path.join(process.cwd(), 'scripts', 'migrate.mjs')], {
      env: { ...process.env, DATABASE_URL: INTEGRATION_URL },
    });

    m = {
      documents: await import('@/lib/db/documents'),
      uploads: await import('@/lib/db/uploads'),
      client: await import('@/lib/db/client'),
      ingest: await import('@/lib/rag/ingest'),
      rateLimit: await import('@/lib/security/rate-limit'),
      clientKey: await import('@/lib/security/client-key'),
      retention: await import('@/lib/security/retention'),
    };

    raw = new pg.Client({ connectionString: INTEGRATION_URL });
    await raw.connect();
  }, 120_000);

  afterEach(() => {
    embedTexts.mockReset();
    ocrPageImage.mockReset();
  });

  afterAll(async () => {
    if (raw) {
      await raw
        .query('delete from demo_rate_limits where client_key = any($1)', [[...usedKeys]])
        .catch(() => undefined);
      await raw
        .query('delete from documents where session_id = any($1)', [sessions])
        .catch(() => undefined);
      await raw.end().catch(() => undefined);
    }
    await m?.client.getPool().end().catch(() => undefined);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------
  describe('migration 0003', () => {
    it('creates the counter table with the key the atomic UPSERT needs', async () => {
      // The primary key is not decoration: `ON CONFLICT (client_key, bucket,
      // window_start)` is what makes concurrent consumers serialise.
      const pk = await raw.query(
        `select a.attname
           from pg_index i
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indrelid = 'demo_rate_limits'::regclass and i.indisprimary
          order by a.attname`,
      );

      expect(pk.rows.map((row) => row.attname)).toEqual([
        'bucket',
        'client_key',
        'window_start',
      ]);
    });

    it('indexes expires_at, so the retention sweep is not a full scan', async () => {
      const index = await raw.query(
        `select 1 from pg_indexes
          where tablename = 'demo_rate_limits'
            and indexname = 'demo_rate_limits_expires_at_idx'`,
      );

      expect(index.rowCount).toBe(1);
    });

    it('re-applies as a no-op', async () => {
      const { stdout } = await execFileAsync(
        'node',
        [path.join(process.cwd(), 'scripts', 'migrate.mjs')],
        { env: { ...process.env, DATABASE_URL: INTEGRATION_URL } },
      );

      expect(stdout).toContain('already up to date');
    });
  });

  // ---------------------------------------------------------------------------
  // The counter itself
  // ---------------------------------------------------------------------------
  describe('consumeDemoQuota', () => {
    it('allows up to the budget and refuses the next request with 429', async () => {
      const key = freshKey();
      const { max } = DEMO_LIMITS.session_reset;

      for (let i = 0; i < max; i += 1) {
        await expect(m.rateLimit.consumeDemoQuota(key, 'session_reset')).resolves.toMatchObject({
          used: i + 1,
        });
      }

      await expect(m.rateLimit.consumeDemoQuota(key, 'session_reset')).rejects.toMatchObject({
        code: 'rate_limited',
        status: 429,
      });
    });

    it('cannot be beaten by firing every request at once', async () => {
      // The read-check-act version of this code passes this budget many times
      // over: twenty parallel requests all read the same count, all decide they
      // are under the limit, and all proceed.
      const key = freshKey();
      const { max } = DEMO_LIMITS.ask;
      const attempts = max + 25;

      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () => m.rateLimit.consumeDemoQuota(key, 'ask')),
      );

      const granted = results.filter((result) => result.status === 'fulfilled');
      const refused = results.filter((result) => result.status === 'rejected');

      expect(granted).toHaveLength(max);
      expect(refused).toHaveLength(attempts - max);

      // And the stored counter agrees -- no consumption was lost or doubled.
      const { used } = await m.rateLimit.peekDemoQuota(key, 'ask');
      expect(used).toBe(max);
    });

    it('charges by units, not by requests, for a byte budget', async () => {
      const key = freshKey();
      const half = Math.floor(DEMO_LIMITS.upload_bytes.max / 2);

      await m.rateLimit.consumeDemoQuota(key, 'upload_bytes', half);
      await m.rateLimit.consumeDemoQuota(key, 'upload_bytes', half);

      // Many small parts add up exactly like one large one.
      await expect(
        m.rateLimit.consumeDemoQuota(key, 'upload_bytes', half),
      ).rejects.toMatchObject({ code: 'rate_limited' });
    });

    it('refuses a single request larger than the whole budget without touching the table', async () => {
      const key = freshKey();

      await expect(
        m.rateLimit.consumeDemoQuota(key, 'ocr_page', DEMO_LIMITS.ocr_page.max + 1),
      ).rejects.toMatchObject({ code: 'rate_limited' });

      // Nothing was written, so a later legitimate request still has its budget.
      await expect(m.rateLimit.consumeDemoQuota(key, 'ocr_page', 1)).resolves.toMatchObject({
        used: 1,
      });
    });

    it('keeps buckets and clients independent', async () => {
      const keyA = freshKey();
      const keyB = freshKey();

      await m.rateLimit.consumeDemoQuota(keyA, 'ask', DEMO_LIMITS.ask.max);

      // Another bucket for the same client is untouched...
      await expect(m.rateLimit.consumeDemoQuota(keyA, 'feedback')).resolves.toBeTruthy();
      // ...and so is another client entirely. One visitor exhausting the demo
      // must not lock everybody else out.
      await expect(m.rateLimit.consumeDemoQuota(keyB, 'ask')).resolves.toMatchObject({ used: 1 });
    });

    it('tells the caller when to come back, and nothing else', async () => {
      const key = freshKey();
      await m.rateLimit.consumeDemoQuota(key, 'session_reset', DEMO_LIMITS.session_reset.max);

      const { AppError } = await import('@/lib/errors');

      let error: InstanceType<typeof AppError> | null = null;
      try {
        await m.rateLimit.consumeDemoQuota(key, 'session_reset');
      } catch (thrown) {
        error = thrown as InstanceType<typeof AppError>;
      }

      expect(error).toBeInstanceOf(AppError);
      expect(error?.retryAfterSeconds).toBeGreaterThan(0);
      expect(error?.retryAfterSeconds).toBeLessThanOrEqual(
        DEMO_LIMITS.session_reset.windowSeconds,
      );
      // The message shown to the visitor must not leak the fingerprint.
      expect(error?.userMessage).not.toContain(key);
    });
  });

  // ---------------------------------------------------------------------------
  // Privacy of what is stored
  // ---------------------------------------------------------------------------
  describe('stored fingerprints', () => {
    it('never persists a raw IP address', async () => {
      const ip = '203.0.113.77';
      const key = m.clientKey.deriveClientKey(ip);
      usedKeys.add(key);

      await m.rateLimit.consumeDemoQuota(key, 'ask');

      const rows = await raw.query('select * from demo_rate_limits where client_key = $1', [key]);
      expect(rows.rowCount).toBe(1);

      const serialised = JSON.stringify(rows.rows);
      expect(serialised).not.toContain(ip);
      // Not just this address: nothing in the row may even look like one.
      expect(serialised).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    });

    it('has no column that could hold one', async () => {
      const columns = await raw.query(
        `select column_name from information_schema.columns
          where table_name = 'demo_rate_limits'`,
      );

      const names = columns.rows.map((row) => row.column_name as string);
      expect(names).toEqual(
        expect.arrayContaining(['client_key', 'bucket', 'window_start', 'used', 'expires_at']),
      );
      for (const name of names) {
        expect(name).not.toMatch(/(^|_)ip($|_)|address|forwarded/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // The bypass this whole feature exists to close
  // ---------------------------------------------------------------------------
  describe('session reset', () => {
    it('clears the visitor’s data but not their budget', async () => {
      const key = freshKey();
      const sessionId = freshSession();

      await stageDocument(sessionId, buildTestPdf(['A page of text.']));
      await m.rateLimit.consumeDemoQuota(key, 'ask', 5);

      // Exactly what POST /api/session/reset does to the database.
      await raw.query('delete from documents where session_id = $1', [sessionId]);
      await raw.query('delete from questions where session_id = $1', [sessionId]);

      // The data is gone...
      expect(await m.documents.countDocuments(sessionId)).toBe(0);
      // ...and so is the old session id, but the budget is exactly where it was.
      const afterReset = await m.rateLimit.peekDemoQuota(key, 'ask');
      expect(afterReset.used).toBe(5);

      // A brand-new session id from the same client inherits the same counter.
      freshSession();
      await expect(m.rateLimit.consumeDemoQuota(key, 'ask')).resolves.toMatchObject({ used: 6 });
    });

    it('is not implemented in a way that could ever clear the counters', async () => {
      // A structural check, because this is a one-line regression away: the
      // reset handler must never delete from the rate-limit table.
      const { readFile } = await import('node:fs/promises');
      const source = await readFile(
        path.join(process.cwd(), 'src', 'app', 'api', 'session', 'reset', 'route.ts'),
        'utf8',
      );

      expect(source).not.toContain('demo_rate_limits');
      expect(source).not.toContain('pruneExpiredRateLimits');
    });
  });

  // ---------------------------------------------------------------------------
  // Cost guards: the point is that OpenAI is never reached
  // ---------------------------------------------------------------------------
  describe('OpenAI cost guards', () => {
    it('does not call the vision model once the OCR budget is spent', async () => {
      const key = freshKey();
      const sessionId = freshSession();

      // A page with no text layer is what sends a document down the OCR path.
      const documentId = await stageDocument(sessionId, buildTestPdf(['']));
      await m.rateLimit.consumeDemoQuota(key, 'ocr_page', DEMO_LIMITS.ocr_page.max);

      await expect(m.ingest.processDocument(sessionId, documentId, key)).rejects.toMatchObject({
        code: 'rate_limited',
        status: 429,
      });

      expect(ocrPageImage).not.toHaveBeenCalled();

      // The document is left failed with a message the visitor can act on --
      // not stuck in `processing` forever.
      const document = await m.documents.getDocument(sessionId, documentId);
      expect(document?.status).toBe('failed');
    }, 60_000);

    it('reaches the vision model for the same document when the budget is intact', async () => {
      // A positive control for the test above. Without it, "OCR was not called"
      // would also pass on a fixture that never had an OCR page to begin with,
      // and the guard would be untested.
      const key = freshKey();
      const sessionId = freshSession();

      ocrPageImage.mockResolvedValue('スキャンページから読み取ったテキストです。'.repeat(3));
      embedTexts.mockImplementation(async (texts: readonly string[]) =>
        texts.map(() =>
          new Array<number>(EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS)),
        ),
      );

      const documentId = await stageDocument(sessionId, buildTestPdf(['']));

      await m.ingest.processDocument(sessionId, documentId, key);

      expect(ocrPageImage).toHaveBeenCalledTimes(1);
      // And the page it transcribed was charged for.
      expect((await m.rateLimit.peekDemoQuota(key, 'ocr_page')).used).toBe(1);
    }, 60_000);

    it('does not call the embedding model once the chunk budget is spent', async () => {
      const key = freshKey();
      const sessionId = freshSession();

      const documentId = await stageDocument(
        sessionId,
        buildTestPdf(['Remote work policy. Employees may work remotely up to three days per week.']),
      );
      await m.rateLimit.consumeDemoQuota(key, 'embedding_chunk', DEMO_LIMITS.embedding_chunk.max);

      await expect(m.ingest.processDocument(sessionId, documentId, key)).rejects.toMatchObject({
        code: 'rate_limited',
      });

      expect(embedTexts).not.toHaveBeenCalled();
      expect(ocrPageImage).not.toHaveBeenCalled();
    }, 60_000);

    it('still ingests normally when the budget allows it', async () => {
      // The guards must bound the demo, not break it. Without this, every test
      // above would also pass on an application that refuses everything.
      const key = freshKey();
      const sessionId = freshSession();

      embedTexts.mockImplementation(async (texts: readonly string[]) =>
        texts.map(() => new Array<number>(EMBEDDING_DIMENSIONS).fill(1 / Math.sqrt(EMBEDDING_DIMENSIONS))),
      );

      const documentId = await stageDocument(
        sessionId,
        buildTestPdf(['Remote work policy. Employees may work remotely up to three days per week.']),
      );

      const result = await m.ingest.processDocument(sessionId, documentId, key);

      expect(result.chunkCount).toBeGreaterThan(0);
      expect(embedTexts).toHaveBeenCalledTimes(1);

      const document = await m.documents.getDocument(sessionId, documentId);
      expect(document?.status).toBe('ready');

      // Chunks were charged for, in one atomic step.
      const spent = await m.rateLimit.peekDemoQuota(key, 'embedding_chunk');
      expect(spent.used).toBe(result.chunkCount);

      // And the staged bytes are gone, as they always were on success.
      await expect(m.uploads.readStagedUpload(documentId)).rejects.toMatchObject({
        code: 'upload_incomplete',
      });
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Concurrency of the expensive endpoint
  // ---------------------------------------------------------------------------
  describe('processing concurrency', () => {
    it('refuses a claim beyond the per-session limit', async () => {
      const sessionId = freshSession();

      // Fill the session's in-flight slots.
      for (let i = 0; i < MAX_CONCURRENT_PROCESSING_PER_SESSION; i += 1) {
        const id = await stageDocument(sessionId, buildTestPdf(['text']));
        await raw.query("update documents set status = 'processing' where id = $1", [id]);
      }

      const extra = await stageDocument(sessionId, buildTestPdf(['text']));

      await expect(
        m.documents.claimDocumentForProcessing(sessionId, extra),
      ).rejects.toMatchObject({ code: 'already_processing', status: 409 });

      // Untouched: a refused claim must not have moved the document.
      const document = await m.documents.getDocument(sessionId, extra);
      expect(document?.status).toBe('uploaded');
    }, 60_000);

    it('serialises simultaneous claims instead of letting them all through', async () => {
      const sessionId = freshSession();

      const ids: string[] = [];
      for (let i = 0; i < MAX_CONCURRENT_PROCESSING_PER_SESSION + 3; i += 1) {
        ids.push(await stageDocument(sessionId, buildTestPdf(['text'])));
      }

      const results = await Promise.allSettled(
        ids.map((id) => m.documents.claimDocumentForProcessing(sessionId, id)),
      );

      const claimed = results.filter((result) => result.status === 'fulfilled');
      expect(claimed).toHaveLength(MAX_CONCURRENT_PROCESSING_PER_SESSION);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------
  // Retention
  // ---------------------------------------------------------------------------
  describe('retention', () => {
    it('deletes counters whose window has closed, and keeps live ones', async () => {
      const stale = freshKey();
      const live = freshKey();

      await m.rateLimit.consumeDemoQuota(stale, 'ask');
      await m.rateLimit.consumeDemoQuota(live, 'ask');
      await raw.query(
        `update demo_rate_limits set expires_at = timezone('utc', now()) - interval '1 hour'
          where client_key = $1`,
        [stale],
      );

      await m.rateLimit.pruneExpiredRateLimits();

      const remaining = await raw.query(
        'select client_key from demo_rate_limits where client_key = any($1)',
        [[stale, live]],
      );
      expect(remaining.rows.map((row) => row.client_key)).toEqual([live]);
    });

    it('drops staged bytes for a failed upload past its retry window', async () => {
      const sessionId = freshSession();

      const expired = await stageDocument(sessionId, buildTestPdf(['text']));
      const recent = await stageDocument(sessionId, buildTestPdf(['text']));

      await raw.query("update documents set status = 'failed' where id = any($1)", [
        [expired, recent],
      ]);
      await raw.query(
        `update document_upload_parts
            set created_at = timezone('utc', now()) - interval '3 days'
          where document_id = $1`,
        [expired],
      );

      await m.uploads.pruneExpiredStagedUploads();

      // The expensive `bytea` is gone...
      await expect(m.uploads.readStagedUpload(expired)).rejects.toMatchObject({
        code: 'upload_incomplete',
      });
      // ...but the document row, its status and its failure reason remain, and a
      // recent failure can still be retried without a re-upload.
      expect((await m.documents.getDocument(sessionId, expired))?.status).toBe('failed');
      await expect(m.uploads.readStagedUpload(recent)).resolves.toBeInstanceOf(Uint8Array);
    }, 60_000);

    it('drops only expired bytes for uploaded documents', async () => {
      const sessionId = freshSession();
      const expired = await stageDocument(sessionId, buildTestPdf(['expired']));
      const recent = await stageDocument(sessionId, buildTestPdf(['recent']));

      await raw.query(
        `update document_upload_parts
            set created_at = timezone('utc', now()) - interval '3 days'
          where document_id = $1`,
        [expired],
      );

      await m.uploads.pruneExpiredStagedUploads();

      await expect(m.uploads.readStagedUpload(expired)).rejects.toMatchObject({
        code: 'upload_incomplete',
      });
      await expect(m.uploads.readStagedUpload(recent)).resolves.toBeInstanceOf(Uint8Array);
      expect((await m.documents.getDocument(sessionId, expired))?.status).toBe('uploaded');
    }, 60_000);

    it('leaves an in-flight document’s bytes alone', async () => {
      const sessionId = freshSession();
      const documentId = await stageDocument(sessionId, buildTestPdf(['text']));

      await raw.query("update documents set status = 'processing' where id = $1", [documentId]);
      await raw.query(
        `update document_upload_parts
            set created_at = timezone('utc', now()) - interval '3 days'
          where document_id = $1`,
        [documentId],
      );

      await m.uploads.pruneExpiredStagedUploads();

      // A long-running ingestion is still reading them.
      await expect(m.uploads.readStagedUpload(documentId)).resolves.toBeInstanceOf(Uint8Array);
    }, 60_000);

    it('is idempotent and safe when cleanup calls overlap', async () => {
      const sessionId = freshSession();
      const documentId = await stageDocument(sessionId, buildTestPdf(['expired']));

      await raw.query(
        `update document_upload_parts
            set created_at = timezone('utc', now()) - interval '3 days'
          where document_id = $1`,
        [documentId],
      );

      const deleted = await Promise.all([
        m.uploads.pruneExpiredStagedUploads(),
        m.uploads.pruneExpiredStagedUploads(),
      ]);

      expect(deleted.reduce((total, count) => total + count, 0)).toBe(1);
      await expect(m.uploads.pruneExpiredStagedUploads()).resolves.toBe(0);
    }, 60_000);

    it('sweeps both kinds of row in one pass', async () => {
      await expect(m.retention.sweepDemoRetention()).resolves.toMatchObject({
        rateLimitRows: expect.any(Number),
        stagedUploadRows: expect.any(Number),
      });
    });
  });
});
