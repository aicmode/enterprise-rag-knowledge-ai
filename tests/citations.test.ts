import { describe, expect, it } from 'vitest';

import {
  buildCitations,
  buildExcerpt,
  formatPageLabel,
  formatSimilarity,
  MAX_EXCERPT_LENGTH,
} from '@/lib/rag/citations';
import type { MatchedChunk } from '@/lib/types';

function match(overrides: Partial<MatchedChunk> = {}): MatchedChunk {
  return {
    chunk_id: 'chunk-1',
    document_id: 'doc-1',
    document_title: '就業規則',
    file_name: '就業規則.pdf',
    page_number: 12,
    chunk_index: 0,
    content: '年次有給休暇の申請は、取得予定日の5営業日前までに所属長へ提出してください。',
    similarity: 0.87,
    ...overrides,
  };
}

describe('buildCitations', () => {
  it('returns an empty list when retrieval found nothing', () => {
    expect(buildCitations([])).toEqual([]);
  });

  it('carries the document title, page number and text through unchanged', () => {
    const [citation] = buildCitations([match()]);

    expect(citation.documentTitle).toBe('就業規則');
    expect(citation.fileName).toBe('就業規則.pdf');
    expect(citation.pageNumber).toBe(12);
    expect(citation.excerpt).toContain('年次有給休暇');
  });

  it('uses the page number from the retrieval row, not a computed one', () => {
    // The guarantee that makes citations trustworthy: whatever page pgvector
    // returned is the page displayed.
    const citations = buildCitations([
      match({ page_number: 1 }),
      match({ document_id: 'doc-2', page_number: 87, similarity: 0.5 }),
    ]);

    expect(citations.map((c) => c.pageNumber).sort((a, b) => a - b)).toEqual([1, 87]);
  });

  it('numbers citations from 1 in similarity order', () => {
    const citations = buildCitations([
      match({ page_number: 1, similarity: 0.4 }),
      match({ page_number: 2, similarity: 0.9 }),
      match({ page_number: 3, similarity: 0.6 }),
    ]);

    expect(citations.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(citations.map((c) => c.pageNumber)).toEqual([2, 3, 1]);
  });

  it('collapses several chunks from the same page, keeping the best match', () => {
    const citations = buildCitations([
      match({ chunk_id: 'a', chunk_index: 0, similarity: 0.6, content: '低い一致' }),
      match({ chunk_id: 'b', chunk_index: 1, similarity: 0.9, content: '高い一致' }),
    ]);

    expect(citations).toHaveLength(1);
    expect(citations[0].excerpt).toBe('高い一致');
    expect(citations[0].similarity).toBe(0.9);
  });

  it('keeps the same page number from two different documents as separate citations', () => {
    const citations = buildCitations([
      match({ document_id: 'doc-1', document_title: '就業規則', page_number: 3 }),
      match({ document_id: 'doc-2', document_title: '経費規程', page_number: 3, similarity: 0.7 }),
    ]);

    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.documentTitle)).toEqual(['就業規則', '経費規程']);
  });

  it('rounds similarity for stable display without touching ordering', () => {
    const [citation] = buildCitations([match({ similarity: 0.876543 })]);

    expect(citation.similarity).toBe(0.877);
  });

  it('produces one citation per retrieval row at most', () => {
    const matches = Array.from({ length: 5 }, (_, i) =>
      match({ chunk_id: `c${i}`, page_number: i + 1, similarity: 0.9 - i * 0.1 }),
    );

    expect(buildCitations(matches)).toHaveLength(5);
  });
});

describe('buildExcerpt', () => {
  it('returns short text unchanged and without an ellipsis', () => {
    expect(buildExcerpt('短い引用です。')).toBe('短い引用です。');
  });

  it('collapses internal whitespace from PDF extraction', () => {
    expect(buildExcerpt('複数   の\n\n空白')).toBe('複数 の 空白');
  });

  it('truncates long text and marks it with an ellipsis', () => {
    const excerpt = buildExcerpt('あ'.repeat(1000));

    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_LENGTH + 1);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('does not add an ellipsis at exactly the limit', () => {
    expect(buildExcerpt('あ'.repeat(MAX_EXCERPT_LENGTH)).endsWith('…')).toBe(false);
  });

  it('avoids splitting a Latin word in half', () => {
    const excerpt = buildExcerpt(`${'word '.repeat(100)}`, 40);

    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toMatch(/wo…$/);
  });
});

describe('display formatting', () => {
  it('renders the page label as P.<n>', () => {
    expect(formatPageLabel(12)).toBe('P.12');
    expect(formatPageLabel(1)).toBe('P.1');
  });

  it('renders similarity as a whole percentage', () => {
    expect(formatSimilarity(0.874)).toBe('87%');
    expect(formatSimilarity(1)).toBe('100%');
  });
});
