// @vitest-environment node
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { getRagConfig } from '@/lib/config/env';
import { generateAnswer } from '@/lib/rag/answer';
import { buildCitations } from '@/lib/rag/citations';
import { chunkPages } from '@/lib/rag/chunking';
import { embedTexts } from '@/lib/rag/embedding';
import { extractPdfPages } from '@/lib/rag/pdf';
import type { MatchedChunk } from '@/lib/types';
import { buildMixedPdf } from '../fixtures/make-pdf';

/**
 * Opt-in tests that intentionally spend real OpenAI API usage.
 *
 * RUN_OPENAI_INTEGRATION=1 npx vitest run tests/integration/openai.integration.test.ts
 */
const enabled = process.env.RUN_OPENAI_INTEGRATION === '1' && Boolean(process.env.OPENAI_API_KEY);

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return dot / (leftNorm * rightNorm);
}

function japaneseScanPdf(): Uint8Array {
  const canvas = createCanvas(612, 792);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, 612, 792);
  context.fillStyle = '#111111';
  context.font = '24px "Yu Gothic", sans-serif';
  context.fillText('従業員は上司の承認を得たうえで、', 48, 120);
  context.fillText('週に最大3日までリモート勤務を利用できます。', 48, 160);
  return buildMixedPdf([{ kind: 'scan', jpeg: canvas.toBuffer('image/jpeg', 90) }]);
}

describe.runIf(enabled)('OpenAI PDF ingestion integration', () => {
  it('OCRs a Japanese scan and generates a grounded Japanese answer with P.1 citation', async () => {
    const extraction = await extractPdfPages(japaneseScanPdf());
    const chunks = chunkPages(extraction.pages, getRagConfig());

    expect(extraction.pages[0]).toMatchObject({ pageNumber: 1, source: 'ocr' });
    expect(extraction.pages[0].text).toMatch(/最大\s*3\s*日/);
    expect(chunks[0]?.pageNumber).toBe(1);

    const match: MatchedChunk = {
      chunk_id: 'openai-integration-chunk',
      document_id: 'openai-integration-document',
      document_title: '日本語スキャン就業規則',
      file_name: 'japanese-scan.pdf',
      page_number: chunks[0].pageNumber,
      chunk_index: chunks[0].chunkIndex,
      content: chunks[0].content,
      similarity: 1,
    };
    const generated = await generateAnswer({
      question: 'リモート勤務は週に何日までできますか？',
      matches: [match],
      model: getRagConfig().chatModel,
    });
    const citations = buildCitations([match]);

    expect(generated.answer).toMatch(/3\s*日/);
    expect(citations[0]).toMatchObject({ pageNumber: 1 });
    expect(citations[0].excerpt).toMatch(/最大\s*3\s*日/);
  }, 120_000);

  it('retrieves an English policy semantically from a Japanese question', async () => {
    const policy = 'Employees may work remotely for up to three days per week with manager approval.';
    const unrelated = 'The cafeteria serves lunch from eleven to two on weekdays.';
    const question = 'リモート勤務は週に何日までできますか？';
    const [policyVector, unrelatedVector, questionVector] = await embedTexts([
      policy,
      unrelated,
      question,
    ]);

    const policySimilarity = cosine(policyVector, questionVector);
    const unrelatedSimilarity = cosine(unrelatedVector, questionVector);

    expect(policySimilarity).toBeGreaterThan(unrelatedSimilarity);
    expect(policySimilarity).toBeGreaterThan(0.3);

    const match: MatchedChunk = {
      chunk_id: 'cross-language-chunk',
      document_id: 'english-policy-document',
      document_title: 'English Company Policy',
      file_name: 'rag_test_company_policy_english.pdf',
      page_number: 3,
      chunk_index: 0,
      content: policy,
      similarity: policySimilarity,
    };
    const generated = await generateAnswer({
      question,
      matches: [match],
      model: getRagConfig().chatModel,
    });
    const citations = buildCitations([match]);

    expect(generated.answer).toMatch(/3\s*日/);
    expect(citations[0]).toMatchObject({ pageNumber: 3 });
  }, 60_000);
});
