import { describe, expect, it } from 'vitest';

import { DEMO_ANSWERS, matchDemoAnswer } from '@/lib/demo/answers';
import { DEMO_CHUNKS, DEMO_DOCUMENTS } from '@/lib/demo/corpus';
import { DEMO_QUESTIONS } from '@/lib/demo/questions';
import {
  answerDemoQuestion,
  DEMO_ANSWER_MODEL,
  DEMO_GUIDANCE_ANSWER,
  DEMO_PARTIAL_ANSWER,
} from '@/lib/demo/rag';
import { retrieveDemoChunks, scoreDemoChunk } from '@/lib/demo/retrieval';

/**
 * The public demo's answering path.
 *
 * Three properties are worth protecting here, and none of them is "the answer
 * reads well":
 *
 *  1. **Determinism.** The same question must produce the same answer, the same
 *     citations and the same 一致度, forever.
 *  2. **Grounding.** Every citation must point at a passage that exists, on a
 *     page that exists, in a document that exists -- the same promise the live
 *     pipeline makes, and the reason citations are built from retrieval rows.
 *  3. **No improvisation.** An unrecognised question must land on the guidance
 *     response. There is no fourth outcome, and in particular no provider.
 */

const OPTIONS = { topK: 5, similarityThreshold: 0.45 };

describe('demo corpus integrity', () => {
  it('attaches every passage to a real document and a real page', () => {
    for (const chunk of DEMO_CHUNKS) {
      const document = DEMO_DOCUMENTS.find((row) => row.id === chunk.document_id);
      expect(document, `chunk ${chunk.chunk_id} has no document`).toBeDefined();
      expect(chunk.document_title).toBe(document?.title);
      expect(chunk.file_name).toBe(document?.file_name);
      expect(chunk.page_number).toBeGreaterThanOrEqual(1);
      expect(chunk.page_number).toBeLessThanOrEqual(document?.page_count ?? 0);
    }
  });

  it('uses unique chunk ids', () => {
    const ids = DEMO_CHUNKS.map((chunk) => chunk.chunk_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('grounds every prepared answer in passages that exist', () => {
    for (const answer of DEMO_ANSWERS) {
      expect(answer.chunkIds.length).toBeGreaterThan(0);
      for (const chunkId of answer.chunkIds) {
        expect(
          DEMO_CHUNKS.some((chunk) => chunk.chunk_id === chunkId),
          `${answer.id} cites missing chunk ${chunkId}`,
        ).toBe(true);
      }
    }
  });

  it('keeps document names and page numbers out of the prepared prose', () => {
    // The same rule the system prompt imposes on the live model: provenance is
    // rendered from citation rows, never written into the answer text.
    for (const answer of DEMO_ANSWERS) {
      expect(answer.answer).not.toMatch(/P\.\d+/);
      for (const document of DEMO_DOCUMENTS) {
        expect(answer.answer).not.toContain(document.title);
        expect(answer.answer).not.toContain(document.file_name);
      }
    }
  });

  it('prepares an answer for every question the UI offers', () => {
    for (const question of DEMO_QUESTIONS) {
      expect(
        DEMO_ANSWERS.some((answer) => answer.id === question.id),
        `no prepared answer for ${question.id}`,
      ).toBe(true);
    }
  });
});

describe('matchDemoAnswer', () => {
  it('recognises each sample question as itself, and not as another', () => {
    // Cross-talk is the failure that would make the demo look broken: the
    // 経費 question answered with the 残業 answer.
    for (const question of DEMO_QUESTIONS) {
      const matched = matchDemoAnswer(question.question);
      expect(matched?.answer.id, `"${question.question}" matched the wrong entry`).toBe(question.id);
    }
  });

  it('recognises every declared alias as its own entry', () => {
    for (const answer of DEMO_ANSWERS) {
      for (const alias of answer.aliases) {
        expect(matchDemoAnswer(alias)?.answer.id, `alias "${alias}"`).toBe(answer.id);
      }
    }
  });

  it('returns null rather than a nearest guess for unrelated input', () => {
    expect(matchDemoAnswer('今日の東京の天気を教えてください')).toBeNull();
    expect(matchDemoAnswer('あなたの好きな映画は何ですか')).toBeNull();
    expect(matchDemoAnswer('')).toBeNull();
  });
});

describe('retrieveDemoChunks', () => {
  it('scores a relevant passage above the threshold and an unrelated one below', () => {
    const relevant = DEMO_CHUNKS.find((chunk) => chunk.chunk_id === 'demo-chunk-work-1201');
    const unrelated = DEMO_CHUNKS.find((chunk) => chunk.chunk_id === 'demo-chunk-security-1001');
    const question = '有給休暇は何日前までに申請が必要ですか？';

    expect(scoreDemoChunk(question, relevant!)).toBeGreaterThanOrEqual(OPTIONS.similarityThreshold);
    expect(scoreDemoChunk(question, unrelated!)).toBeLessThan(OPTIONS.similarityThreshold);
  });

  it('never reports a perfect match', () => {
    for (const chunk of DEMO_CHUNKS) {
      expect(scoreDemoChunk(chunk.content, chunk)).toBeLessThan(1);
    }
  });

  it('returns results in a stable, total order', () => {
    const first = retrieveDemoChunks('経費精算の締め日はいつですか？', OPTIONS);
    const second = retrieveDemoChunks('経費精算の締め日はいつですか？', OPTIONS);

    expect(first).toEqual(second);
    for (let i = 1; i < first.length; i += 1) {
      expect(first[i - 1].similarity).toBeGreaterThanOrEqual(first[i].similarity);
    }
  });

  it('honours topK', () => {
    const results = retrieveDemoChunks('申請', { topK: 2, similarityThreshold: 0 });
    expect(results).toHaveLength(2);
  });
});

describe('answerDemoQuestion', () => {
  it('answers every sample question with its prepared answer and real citations', () => {
    for (const question of DEMO_QUESTIONS) {
      const result = answerDemoQuestion(question.question, OPTIONS);
      const prepared = DEMO_ANSWERS.find((answer) => answer.id === question.id)!;

      expect(result.matchedQuestionId).toBe(question.id);
      expect(result.answer).toBe(prepared.answer);
      expect(result.noRelevantContext).toBe(false);
      expect(result.model).toBe(DEMO_ANSWER_MODEL);
      expect(result.citations.length).toBeGreaterThan(0);

      for (const citation of result.citations) {
        const document = DEMO_DOCUMENTS.find((row) => row.id === citation.documentId);
        expect(document, 'citation points at a document that exists').toBeDefined();
        expect(citation.documentTitle).toBe(document?.title);
        expect(citation.pageNumber).toBeLessThanOrEqual(document?.page_count ?? 0);
        expect(citation.excerpt.length).toBeGreaterThan(0);
        expect(citation.similarity).toBeGreaterThan(0);

        // The excerpt is a real passage of the corpus, not composed text.
        const source = DEMO_CHUNKS.find(
          (chunk) =>
            chunk.document_id === citation.documentId &&
            chunk.page_number === citation.pageNumber,
        );
        expect(source, 'citation points at a passage that exists').toBeDefined();
      }
    }
  });

  it('is deterministic', () => {
    for (const question of ['有給休暇は何日前までに申請が必要ですか？', '在宅勤務の端末について']) {
      expect(answerDemoQuestion(question, OPTIONS)).toEqual(answerDemoQuestion(question, OPTIONS));
    }
  });

  it('guides the visitor instead of improvising when nothing is relevant', () => {
    const result = answerDemoQuestion('今日の東京の天気を教えてください', OPTIONS);

    expect(result.answer).toBe(DEMO_GUIDANCE_ANSWER);
    expect(result.noRelevantContext).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.matchedQuestionId).toBeNull();
  });

  it('shows retrieved passages for an off-script but related question', () => {
    // Retrieval is real, so an unprepared question still demonstrates search --
    // what it must not do is produce prose that no prepared answer stands behind.
    const result = answerDemoQuestion('インシデントが起きたときの連絡先は', OPTIONS);

    expect(result.answer).toBe(DEMO_PARTIAL_ANSWER);
    expect(result.matchedQuestionId).toBeNull();
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.noRelevantContext).toBe(false);
  });

  it('records a demo model label rather than an OpenAI model id', () => {
    const result = answerDemoQuestion('経費精算の締め日はいつですか？', OPTIONS);

    expect(result.model).toBe(DEMO_ANSWER_MODEL);
    expect(result.model).not.toMatch(/gpt|o[1-9]|text-embedding/i);
  });
});
