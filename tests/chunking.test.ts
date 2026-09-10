import { describe, expect, it } from 'vitest';

import { chunkPageText, chunkPages, findBreakPoint } from '@/lib/rag/chunking';
import type { PdfPageText } from '@/lib/rag/pdf';

const CONFIG = { chunkSize: 200, chunkOverlap: 40 };

function makePage(pageNumber: number, text: string): PdfPageText {
  return { pageNumber, text };
}

describe('chunkPageText', () => {
  it('returns no chunks for empty or whitespace-only text', () => {
    expect(chunkPageText('', 1, CONFIG)).toEqual([]);
    expect(chunkPageText('   \n\n  ', 1, CONFIG)).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkPageText('短いテキストです。', 3, CONFIG);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('短いテキストです。');
    expect(chunks[0].pageNumber).toBe(3);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('records contentLength matching the stored content', () => {
    const chunks = chunkPageText('a'.repeat(500), 1, CONFIG);

    for (const chunk of chunks) {
      expect(chunk.contentLength).toBe(chunk.content.length);
    }
  });

  it('numbers chunks sequentially from zero within a page', () => {
    const chunks = chunkPageText('あ'.repeat(1000), 7, CONFIG);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
  });

  it('stamps every chunk with the page it came from', () => {
    const chunks = chunkPageText('あ'.repeat(1000), 12, CONFIG);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.pageNumber === 12)).toBe(true);
  });

  it('does not exceed the configured chunk size', () => {
    const chunks = chunkPageText('あ'.repeat(2000), 1, CONFIG);

    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(CONFIG.chunkSize);
    }
  });

  it('overlaps consecutive chunks so a boundary-straddling passage survives', () => {
    const text = 'あ'.repeat(1000);
    const chunks = chunkPageText(text, 1, CONFIG);

    expect(chunks.length).toBeGreaterThan(1);

    // With overlap, the combined length of the chunks must exceed the source.
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.content.length, 0);
    expect(totalLength).toBeGreaterThan(text.length);
  });

  it('covers the whole page: the last chunk reaches the end of the text', () => {
    const text = `${'あ'.repeat(900)}END`;
    const chunks = chunkPageText(text, 1, CONFIG);

    expect(chunks.at(-1)?.content.endsWith('END')).toBe(true);
  });

  it('terminates even when the text has no natural break points', () => {
    // A single unbroken run: findBreakPoint can offer nothing, so the chunker
    // must still make progress rather than spinning.
    const chunks = chunkPageText('x'.repeat(1000), 1, { chunkSize: 100, chunkOverlap: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(100);
  });

  it('terminates when the requested overlap is larger than the chunk size', () => {
    // Overlap is clamped internally; without that the cursor would move
    // backwards and loop forever.
    const chunks = chunkPageText('あ'.repeat(600), 1, { chunkSize: 100, chunkOverlap: 500 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(100);
  });

  it('prefers to break on sentence punctuation', () => {
    const sentence = `${'あ'.repeat(60)}。`;
    const chunks = chunkPageText(sentence.repeat(6), 1, { chunkSize: 200, chunkOverlap: 0 });

    // The first chunk should end at a sentence boundary, not mid-sentence.
    expect(chunks[0].content.endsWith('。')).toBe(true);
  });
});

describe('chunkPages', () => {
  it('never produces a chunk spanning two pages', () => {
    const pages = [
      makePage(1, `ページ1の内容です。${'あ'.repeat(300)}`),
      makePage(2, `ページ2の内容です。${'い'.repeat(300)}`),
    ];

    const chunks = chunkPages(pages, CONFIG);

    // This is the property the whole citation feature rests on: any chunk
    // containing page-1 text must be labelled page 1, and vice versa.
    for (const chunk of chunks) {
      if (chunk.content.includes('あ')) expect(chunk.pageNumber).toBe(1);
      if (chunk.content.includes('い')) expect(chunk.pageNumber).toBe(2);
      expect(chunk.content.includes('あ') && chunk.content.includes('い')).toBe(false);
    }
  });

  it('restarts chunkIndex at zero on each page', () => {
    const pages = [makePage(1, 'あ'.repeat(600)), makePage(2, 'い'.repeat(600))];
    const chunks = chunkPages(pages, CONFIG);

    const page1 = chunks.filter((c) => c.pageNumber === 1);
    const page2 = chunks.filter((c) => c.pageNumber === 2);

    expect(page1[0].chunkIndex).toBe(0);
    expect(page2[0].chunkIndex).toBe(0);
  });

  it('preserves non-contiguous page numbers exactly', () => {
    // Page 2 is blank (a divider page), so numbering must skip it rather than
    // renumbering and shifting every later citation by one.
    const pages = [
      makePage(1, 'あ'.repeat(300)),
      makePage(2, ''),
      makePage(12, 'い'.repeat(300)),
    ];

    const pageNumbers = new Set(chunkPages(pages, CONFIG).map((c) => c.pageNumber));

    expect(pageNumbers).toEqual(new Set([1, 12]));
  });

  it('skips pages with too little text to be meaningful', () => {
    const pages = [makePage(1, '1'), makePage(2, 'あ'.repeat(300))];
    const chunks = chunkPages(pages, CONFIG);

    expect(chunks.every((chunk) => chunk.pageNumber === 2)).toBe(true);
  });

  it('produces no chunks for a document with no text layer', () => {
    const pages = [makePage(1, ''), makePage(2, '  ')];

    expect(chunkPages(pages, CONFIG)).toEqual([]);
  });
});

describe('findBreakPoint', () => {
  it('returns the text length when the hard end is past the string', () => {
    expect(findBreakPoint('short', 2, 100)).toBe(5);
  });

  it('falls back to the hard end when no boundary is available', () => {
    expect(findBreakPoint('x'.repeat(100), 40, 80)).toBe(80);
  });

  it('never returns a break before the minimum end', () => {
    const text = `ab. ${'x'.repeat(100)}`;
    expect(findBreakPoint(text, 50, 80)).toBeGreaterThan(50);
  });
});
