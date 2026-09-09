// @vitest-environment node
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NO_CONTEXT_ANSWER } from '@/lib/rag/prompt';
import { buildCitations } from '@/lib/rag/citations';
import { generateAnswer } from '@/lib/rag/answer';
import { chunkPages } from '@/lib/rag/chunking';
import { DOCUMENTS_BUCKET } from '@/lib/rag/bucket';
import { RAG_DEFAULTS } from '@/lib/config/rag';
import { extractPdfPages } from '@/lib/rag/pdf';
import { retrieveRelevantChunks } from '@/lib/rag/retrieval';
import type { MatchedChunk } from '@/lib/types';
import { buildMixedPdf, buildTestPdf } from '../fixtures/make-pdf';

/**
 * Integration tests against a real Supabase instance.
 *
 * These verify the things a unit test structurally cannot: that the migrations
 * actually apply, that pgvector accepts the embedding column, that
 * `match_document_chunks` is reachable *through PostgREST* with a vector
 * argument, and -- most importantly -- that RLS and the Storage policies really
 * keep two users apart.
 *
 * They are opt-in. Credentials are never hardcoded (not even the well-known
 * local ones), so the suite is skipped unless all three variables are exported:
 *
 *     supabase start
 *     export SUPABASE_INTEGRATION_URL=...            # API URL from `supabase status`
 *     export SUPABASE_INTEGRATION_ANON_KEY=...
 *     export SUPABASE_INTEGRATION_SERVICE_ROLE_KEY=...
 *     npm run test
 *
 * No OpenAI key is required: embeddings here come from a deterministic local
 * embedder, so the vector path is exercised end to end without a network call.
 * Only the LLM answer text itself is out of scope for this file.
 */

const URL_ = process.env.SUPABASE_INTEGRATION_URL;
const ANON_KEY = process.env.SUPABASE_INTEGRATION_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_INTEGRATION_SERVICE_ROLE_KEY;

const enabled = Boolean(URL_ && ANON_KEY && SERVICE_KEY);

const EMBEDDING_DIMENSIONS = 1536;

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

interface TestUser {
  id: string;
  email: string;
  client: SupabaseClient;
}

describe.runIf(enabled)('supabase integration', () => {
  const stamp = Date.now();
  const password = `integration-${stamp}-pw`;

  let admin: SupabaseClient;
  let userA: TestUser;
  let userB: TestUser;
  let documentA: string;
  let documentB: string;
  let questionA: string;
  let storagePathA: string;

  async function createUser(label: string): Promise<TestUser> {
    const email = `integration-${label}-${stamp}@example.test`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Integration ${label}` },
    });
    if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`);

    const client = createClient(URL_!, ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    if (signInError) throw new Error(`signIn ${label}: ${signInError.message}`);

    return { id: data.user.id, email, client };
  }

  beforeAll(async () => {
    admin = createClient(URL_!, SERVICE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    userA = await createUser('a');
    userB = await createUser('b');
  }, 60_000);

  afterAll(async () => {
    // Deleting the auth users cascades documents, chunks, questions and feedback.
    for (const user of [userA, userB]) {
      if (!user) continue;
      await admin.storage.from(DOCUMENTS_BUCKET).remove([storagePathA]).catch(() => undefined);
      await admin.auth.admin.deleteUser(user.id).catch(() => undefined);
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Schema: what the migrations actually produced
  // ---------------------------------------------------------------------------
  describe('schema', () => {
    it('created a profile row for each new user via the signup trigger', async () => {
      const { data, error } = await admin
        .from('profiles')
        .select('id, display_name')
        .in('id', [userA.id, userB.id]);

      expect(error).toBeNull();
      expect(data).toHaveLength(2);
    });

    it('exposes a private documents bucket restricted to PDFs', async () => {
      const { data, error } = await admin.storage.getBucket(DOCUMENTS_BUCKET);

      expect(error).toBeNull();
      expect(data?.public).toBe(false);
      expect(data?.allowed_mime_types).toContain('application/pdf');
    });

    it('accepts a 1536-dimension embedding and rejects a wrong-width one', async () => {
      const { data: doc } = await admin
        .from('documents')
        .insert({
          user_id: userA.id,
          title: 'Dimension probe',
          file_name: 'probe.pdf',
          storage_path: `${userA.id}/probe-${stamp}/probe.pdf`,
          file_size: 1024,
          status: 'uploaded',
        })
        .select('id')
        .single();

      const base = {
        document_id: doc!.id,
        page_number: 1,
        chunk_index: 0,
        content: 'probe',
        content_length: 5,
      };

      const { error: okError } = await admin
        .from('document_chunks')
        .insert({ ...base, embedding: JSON.stringify(localEmbed('probe')) });
      expect(okError).toBeNull();

      const { error: badError } = await admin
        .from('document_chunks')
        .insert({ ...base, chunk_index: 1, embedding: JSON.stringify([0.1, 0.2, 0.3]) });
      expect(badError).not.toBeNull();

      await admin.from('documents').delete().eq('id', doc!.id);
    });
  });

  // ---------------------------------------------------------------------------
  // Real PDF -> Storage -> extraction -> chunks -> pgvector
  // ---------------------------------------------------------------------------
  describe('ingestion pipeline', () => {
    it('uploads a real PDF into the owner-scoped Storage path', async () => {
      documentA = crypto.randomUUID();
      storagePathA = `${userA.id}/${documentA}/handbook.pdf`;

      const pdf = buildTestPdf(PAGES);
      const { error } = await userA.client.storage
        .from(DOCUMENTS_BUCKET)
        .upload(storagePathA, new Blob([pdf as BlobPart], { type: 'application/pdf' }), {
          contentType: 'application/pdf',
        });

      expect(error).toBeNull();
    });

    it('registers the document row through the user-scoped client', async () => {
      const { error } = await userA.client.from('documents').insert({
        id: documentA,
        user_id: userA.id,
        title: 'Employee Handbook',
        file_name: 'handbook.pdf',
        storage_path: storagePathA,
        file_size: 4096,
        status: 'uploaded',
      });

      expect(error).toBeNull();
    });

    it('extracts page-numbered text from the PDF downloaded back out of Storage', async () => {
      const { data: blob, error } = await admin.storage
        .from(DOCUMENTS_BUCKET)
        .download(storagePathA);

      expect(error).toBeNull();

      const extraction = await extractPdfPages(new Uint8Array(await blob!.arrayBuffer()));

      expect(extraction.pageCount).toBe(3);
      expect(extraction.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
      expect(extraction.pages[2].text).toContain('three days per week');
    });

    it('persists chunks with their page numbers and marks the document ready', async () => {
      const { data: blob } = await admin.storage.from(DOCUMENTS_BUCKET).download(storagePathA);
      const extraction = await extractPdfPages(new Uint8Array(await blob!.arrayBuffer()));
      const chunks = chunkPages(extraction.pages, RAG_DEFAULTS);

      expect(chunks.length).toBeGreaterThanOrEqual(3);

      const { error: insertError } = await admin.from('document_chunks').insert(
        chunks.map((chunk) => ({
          document_id: documentA,
          page_number: chunk.pageNumber,
          chunk_index: chunk.chunkIndex,
          content: chunk.content,
          content_length: chunk.contentLength,
          embedding: JSON.stringify(localEmbed(chunk.content)),
        })),
      );
      expect(insertError).toBeNull();

      const { error: readyError } = await admin
        .from('documents')
        .update({ status: 'ready', page_count: extraction.pageCount })
        .eq('id', documentA);
      expect(readyError).toBeNull();

      const { data: stored } = await userA.client
        .from('document_chunks')
        .select('page_number')
        .eq('document_id', documentA);

      expect(new Set(stored!.map((row) => row.page_number))).toEqual(new Set([1, 2, 3]));
    });

    it('persists native/OCR/native mixed pages with OCR content on page 2', async () => {
      const mixedDocumentId = crypto.randomUUID();
      const mixedStoragePath = `${userA.id}/${mixedDocumentId}/mixed.pdf`;
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
        const { error: uploadError } = await userA.client.storage
          .from(DOCUMENTS_BUCKET)
          .upload(mixedStoragePath, new Blob([pdf as BlobPart], { type: 'application/pdf' }), {
            contentType: 'application/pdf',
          });
        expect(uploadError).toBeNull();

        const { error: documentError } = await userA.client.from('documents').insert({
          id: mixedDocumentId,
          user_id: userA.id,
          title: 'Mixed Handbook',
          file_name: 'mixed.pdf',
          storage_path: mixedStoragePath,
          file_size: pdf.byteLength,
          status: 'processing',
        });
        expect(documentError).toBeNull();

        const { data: blob, error: downloadError } = await admin.storage
          .from(DOCUMENTS_BUCKET)
          .download(mixedStoragePath);
        expect(downloadError).toBeNull();

        const extraction = await extractPdfPages(new Uint8Array(await blob!.arrayBuffer()), {
          ocrPage: async ({ pageNumber }) => {
            expect(pageNumber).toBe(2);
            return '従業員は上司の承認を得たうえで、週に最大3日までリモート勤務を利用できます。';
          },
        });
        const chunks = chunkPages(extraction.pages, RAG_DEFAULTS);

        const { error: insertError } = await admin.from('document_chunks').insert(
          chunks.map((chunk) => ({
            document_id: mixedDocumentId,
            page_number: chunk.pageNumber,
            chunk_index: chunk.chunkIndex,
            content: chunk.content,
            content_length: chunk.contentLength,
            embedding: JSON.stringify(localEmbed(chunk.content)),
          })),
        );
        expect(insertError).toBeNull();

        const { data: stored } = await userA.client
          .from('document_chunks')
          .select('page_number, content')
          .eq('document_id', mixedDocumentId)
          .order('page_number');

        expect(stored?.map((row) => row.page_number)).toEqual([1, 2, 3]);
        expect(stored?.find((row) => row.page_number === 2)?.content).toContain('週に最大3日');
      } finally {
        await admin.from('documents').delete().eq('id', mixedDocumentId);
        await admin.storage.from(DOCUMENTS_BUCKET).remove([mixedStoragePath]);
      }
    });

    it('re-processing does not duplicate chunks (delete-then-insert is idempotent)', async () => {
      const before = await admin
        .from('document_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentA);

      // A naive re-insert must be rejected by the positional unique constraint.
      const { data: sample } = await admin
        .from('document_chunks')
        .select('page_number, chunk_index, content, content_length')
        .eq('document_id', documentA)
        .limit(1)
        .single();

      const { error: duplicateError } = await admin.from('document_chunks').insert({
        document_id: documentA,
        page_number: sample!.page_number,
        chunk_index: sample!.chunk_index,
        content: sample!.content,
        content_length: sample!.content_length,
        embedding: JSON.stringify(localEmbed(sample!.content)),
      });
      expect(duplicateError?.code).toBe('23505');

      const after = await admin
        .from('document_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentA);

      expect(after.count).toBe(before.count);
    });

    it('lets only one of two concurrent processing claims win', async () => {
      // Mirrors claimForProcessing() in src/lib/rag/ingest.ts: a conditional
      // UPDATE guarded on the current status is the optimistic lock that stops
      // two requests from embedding the same document twice.
      await admin.from('documents').update({ status: 'uploaded' }).eq('id', documentA);

      const claim = () =>
        userA.client
          .from('documents')
          .update({ status: 'processing', error_message: null })
          .eq('id', documentA)
          .eq('user_id', userA.id)
          .in('status', ['uploaded', 'failed'])
          .select('id');

      const [first, second] = await Promise.all([claim(), claim()]);
      const winners = [first, second].filter((result) => (result.data ?? []).length === 1);

      expect(winners).toHaveLength(1);

      await admin.from('documents').update({ status: 'ready' }).eq('id', documentA);
    });

    it('allows a failed document to be claimed again for retry', async () => {
      await admin.from('documents').update({ status: 'failed', error_message: 'boom' }).eq('id', documentA);

      const { data } = await userA.client
        .from('documents')
        .update({ status: 'processing', error_message: null })
        .eq('id', documentA)
        .eq('user_id', userA.id)
        .in('status', ['uploaded', 'failed'])
        .select('id, error_message');

      expect(data).toHaveLength(1);
      expect(data![0].error_message).toBeNull();

      await admin.from('documents').update({ status: 'ready' }).eq('id', documentA);
    });

    it('refuses to claim a document that is already processing', async () => {
      await admin.from('documents').update({ status: 'processing' }).eq('id', documentA);

      const { data } = await userA.client
        .from('documents')
        .update({ status: 'processing' })
        .eq('id', documentA)
        .eq('user_id', userA.id)
        .in('status', ['uploaded', 'failed'])
        .select('id');

      expect(data ?? []).toHaveLength(0);

      await admin.from('documents').update({ status: 'ready' }).eq('id', documentA);
    });

    it('refuses to claim a document belonging to another user', async () => {
      const { data } = await userB.client
        .from('documents')
        .update({ status: 'processing' })
        .eq('id', documentA)
        .eq('user_id', userB.id)
        .in('status', ['uploaded', 'failed'])
        .select('id');

      expect(data ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Second tenant, used by every isolation test below
  // ---------------------------------------------------------------------------
  describe("user B's own corpus", () => {
    it('stores a document whose chunk is near-identical to user A page 3', async () => {
      const { data: doc, error } = await admin
        .from('documents')
        .insert({
          user_id: userB.id,
          title: 'Rival Handbook',
          file_name: 'rival.pdf',
          storage_path: `${userB.id}/rival-${stamp}/rival.pdf`,
          file_size: 2048,
          status: 'ready',
          page_count: 1,
        })
        .select('id')
        .single();

      expect(error).toBeNull();
      documentB = doc!.id;

      // Deliberately the same wording as A's page 3, so a broken isolation rule
      // would surface this row at ~1.0 similarity.
      const { error: chunkError } = await admin.from('document_chunks').insert({
        document_id: documentB,
        page_number: 1,
        chunk_index: 0,
        content: `CONFIDENTIAL-B ${PAGES[2]}`,
        content_length: 128,
        embedding: JSON.stringify(localEmbed(PAGES[2])),
      });

      expect(chunkError).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // match_document_chunks over PostgREST
  // ---------------------------------------------------------------------------
  describe('match_document_chunks RPC', () => {
    const query = 'How many days per week may I work remotely?';

    it('is callable through supabase-js with a vector argument', async () => {
      const { data, error } = await userA.client.rpc('match_document_chunks', {
        query_embedding: JSON.stringify(localEmbed(query)),
        match_threshold: 0,
        match_count: 5,
      });

      expect(error).toBeNull();
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it('ranks the remote-work page first and cites page 3', async () => {
      const matches = await retrieveRelevantChunks(userA.client, localEmbed(query), {
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

    it('never returns another tenant\'s chunk, even at near-identical similarity', async () => {
      const matches = await retrieveRelevantChunks(userA.client, localEmbed(PAGES[2]), {
        topK: 20,
        similarityThreshold: 0,
      });

      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((match) => match.document_id !== documentB)).toBe(true);
      expect(matches.some((match) => match.content.includes('CONFIDENTIAL-B'))).toBe(false);
    });

    it('honours match_threshold and match_count', async () => {
      const embedding = localEmbed(query);

      const capped = await retrieveRelevantChunks(userA.client, embedding, {
        topK: 1,
        similarityThreshold: 0,
      });
      expect(capped).toHaveLength(1);

      const strict = await retrieveRelevantChunks(userA.client, embedding, {
        topK: 20,
        similarityThreshold: 0.99,
      });
      expect(strict).toHaveLength(0);
    });

    it('excludes documents that are not ready', async () => {
      await admin.from('documents').update({ status: 'processing' }).eq('id', documentA);

      const matches = await retrieveRelevantChunks(userA.client, localEmbed(query), {
        topK: 20,
        similarityThreshold: 0,
      });
      expect(matches).toHaveLength(0);

      await admin.from('documents').update({ status: 'ready' }).eq('id', documentA);
    });

    it('refuses the call entirely for an anonymous caller', async () => {
      const anonClient = createClient(URL_!, ANON_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data, error } = await anonClient.rpc('match_document_chunks', {
        query_embedding: JSON.stringify(localEmbed(query)),
        match_threshold: 0,
        match_count: 20,
      });

      // 0005 revokes EXECUTE from anon, so this is a privilege error rather
      // than an empty result set.
      expect(error).not.toBeNull();
      expect(data ?? []).toHaveLength(0);
    });

    it('returns nothing for a service-role client, since identity comes from the JWT', async () => {
      const { data } = await admin.rpc('match_document_chunks', {
        query_embedding: JSON.stringify(localEmbed(query)),
        match_threshold: 0,
        match_count: 20,
      });

      expect(data ?? []).toHaveLength(0);
    });

    it('returns the fixed "not in your documents" answer without calling the model', async () => {
      // A question the handbook says nothing about. Retrieval must come back
      // empty, and generateAnswer must short-circuit to the fixed sentence
      // rather than letting the model answer from general knowledge -- which is
      // why this passes with no OPENAI_API_KEY configured: reaching OpenAI at
      // all would throw here.
      const matches: MatchedChunk[] = await retrieveRelevantChunks(
        userA.client,
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
  // Row Level Security
  // ---------------------------------------------------------------------------
  describe('row level security', () => {
    it('hides user A documents from user B and vice versa', async () => {
      const { data: bSeesA } = await userB.client
        .from('documents')
        .select('id')
        .eq('id', documentA);
      expect(bSeesA ?? []).toHaveLength(0);

      const { data: aSeesB } = await userA.client
        .from('documents')
        .select('id')
        .eq('id', documentB);
      expect(aSeesB ?? []).toHaveLength(0);
    });

    it('blocks user B from mutating user A documents', async () => {
      const { data: updated } = await userB.client
        .from('documents')
        .update({ title: 'hijacked' })
        .eq('id', documentA)
        .select();
      expect(updated ?? []).toHaveLength(0);

      const { data: deleted } = await userB.client
        .from('documents')
        .delete()
        .eq('id', documentA)
        .select();
      expect(deleted ?? []).toHaveLength(0);
    });

    it('rejects inserting a document owned by somebody else', async () => {
      const { error } = await userA.client.from('documents').insert({
        user_id: userB.id,
        title: 'spoofed',
        file_name: 'spoof.pdf',
        storage_path: `${userB.id}/spoof-${stamp}/spoof.pdf`,
        file_size: 128,
        status: 'uploaded',
      });

      expect(error?.code).toBe('42501');
    });

    it('derives chunk visibility from the parent document', async () => {
      const { data } = await userB.client
        .from('document_chunks')
        .select('id')
        .eq('document_id', documentA);
      expect(data ?? []).toHaveLength(0);

      const { error } = await userB.client.from('document_chunks').insert({
        document_id: documentA,
        page_number: 99,
        chunk_index: 0,
        content: 'injected',
        content_length: 8,
        embedding: JSON.stringify(localEmbed('injected')),
      });
      expect(error?.code).toBe('42501');
    });

    it('keeps question history private to its owner', async () => {
      const { data, error } = await userA.client
        .from('questions')
        .insert({
          user_id: userA.id,
          question: 'How many days per week may I work remotely?',
          answer: 'Up to three days per week with manager approval.',
          sources: [{ documentTitle: 'Employee Handbook', pageNumber: 3, similarity: 0.82 }],
          response_time_ms: 1500,
          model: RAG_DEFAULTS.chatModel,
        })
        .select('id')
        .single();

      expect(error).toBeNull();
      questionA = data!.id;

      const { data: bSees } = await userB.client.from('questions').select('id').eq('id', questionA);
      expect(bSees ?? []).toHaveLength(0);
    });

    it('lets only the owner rate an answer', async () => {
      const { error } = await userB.client.from('answer_feedback').insert({
        question_id: questionA,
        user_id: userB.id,
        rating: 'helpful',
      });

      expect(error?.code).toBe('42501');
    });

    it('stops a user from updating somebody else\'s profile', async () => {
      const { data } = await userB.client
        .from('profiles')
        .update({ display_name: 'hijacked' })
        .eq('id', userA.id)
        .select();

      expect(data ?? []).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Feedback UPSERT
  // ---------------------------------------------------------------------------
  describe('answer feedback', () => {
    it('replaces an existing vote instead of adding a second row', async () => {
      const upsert = (rating: 'helpful' | 'not_helpful') =>
        userA.client
          .from('answer_feedback')
          .upsert(
            { question_id: questionA, user_id: userA.id, rating },
            { onConflict: 'question_id,user_id' },
          )
          .select('id, rating')
          .single();

      const first = await upsert('helpful');
      expect(first.error).toBeNull();
      expect(first.data!.rating).toBe('helpful');

      const second = await upsert('not_helpful');
      expect(second.error).toBeNull();
      expect(second.data!.rating).toBe('not_helpful');
      expect(second.data!.id).toBe(first.data!.id);

      const { count } = await userA.client
        .from('answer_feedback')
        .select('id', { count: 'exact', head: true })
        .eq('question_id', questionA);

      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Storage policies
  // ---------------------------------------------------------------------------
  describe('storage policies', () => {
    const pdf = () =>
      new Blob([buildTestPdf(['single page of text for the policy check']) as BlobPart], {
        type: 'application/pdf',
      });

    it('lets a user write inside their own prefix', async () => {
      const { error } = await userA.client.storage
        .from(DOCUMENTS_BUCKET)
        .upload(`${userA.id}/policy-${stamp}/own.pdf`, pdf(), { contentType: 'application/pdf' });

      expect(error).toBeNull();

      await admin.storage.from(DOCUMENTS_BUCKET).remove([`${userA.id}/policy-${stamp}/own.pdf`]);
    });

    it('blocks a direct upload into another user\'s prefix', async () => {
      const { error } = await userB.client.storage
        .from(DOCUMENTS_BUCKET)
        .upload(`${userA.id}/${documentA}/evil.pdf`, pdf(), { contentType: 'application/pdf' });

      expect(error).not.toBeNull();
    });

    it('blocks a signed upload URL for another user\'s prefix', async () => {
      const { error } = await userB.client.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUploadUrl(`${userA.id}/${documentA}/evil-signed.pdf`);

      expect(error).not.toBeNull();
    });

    it('lets the owner read their own PDF but hides it from everyone else', async () => {
      const { data: own } = await userA.client.storage
        .from(DOCUMENTS_BUCKET)
        .download(storagePathA);
      expect(own).not.toBeNull();

      const { data: other } = await userB.client.storage
        .from(DOCUMENTS_BUCKET)
        .download(storagePathA);
      expect(other).toBeNull();

      const anonClient = createClient(URL_!, ANON_KEY!, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: anonymous } = await anonClient.storage
        .from(DOCUMENTS_BUCKET)
        .download(storagePathA);
      expect(anonymous).toBeNull();
    });

    it('refuses to sign a download URL for another user\'s object', async () => {
      const { error } = await userB.client.storage
        .from(DOCUMENTS_BUCKET)
        .createSignedUrl(storagePathA, 60);

      expect(error).not.toBeNull();
    });

    it('does not delete another user\'s object', async () => {
      const { data: removed } = await userB.client.storage
        .from(DOCUMENTS_BUCKET)
        .remove([storagePathA]);
      expect(removed ?? []).toHaveLength(0);

      const { data: survived } = await admin.storage
        .from(DOCUMENTS_BUCKET)
        .download(storagePathA);
      expect(survived).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Delete, in the order the API route performs it
  // ---------------------------------------------------------------------------
  describe('document deletion', () => {
    it('removes the PDF, the row and the chunks, leaving nothing orphaned', async () => {
      const { data: document } = await userA.client
        .from('documents')
        .select('id, storage_path')
        .eq('id', documentA)
        .eq('user_id', userA.id)
        .maybeSingle();
      expect(document).not.toBeNull();

      const { error: storageError } = await admin.storage
        .from(DOCUMENTS_BUCKET)
        .remove([document!.storage_path]);
      expect(storageError).toBeNull();

      const { error: deleteError } = await userA.client
        .from('documents')
        .delete()
        .eq('id', documentA)
        .eq('user_id', userA.id);
      expect(deleteError).toBeNull();

      const { count } = await admin
        .from('document_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentA);
      expect(count).toBe(0);

      const { data: file } = await admin.storage
        .from(DOCUMENTS_BUCKET)
        .download(document!.storage_path);
      expect(file).toBeNull();
    });

    it('treats removing an already-missing object as a no-op so a retry can finish', async () => {
      const { error } = await admin.storage
        .from(DOCUMENTS_BUCKET)
        .remove([`${userA.id}/missing-${stamp}/gone.pdf`]);

      expect(error).toBeNull();
    });
  });
});
