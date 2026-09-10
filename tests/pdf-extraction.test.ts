// @vitest-environment node
import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { AppError } from '@/lib/errors';
import { chunkPages } from '@/lib/rag/chunking';
import { extractPdfPages } from '@/lib/rag/pdf';
import {
  buildJapaneseTextPdf,
  buildMixedPdf,
  buildPasswordProtectedPdf,
  buildTestPdf,
} from './fixtures/make-pdf';

const PAGES = [
  'Page one covers annual paid leave requests and approval timelines.',
  'Page two covers overtime limits and the manager approval process.',
  'Page three covers the remote work policy and eligible roles.',
];

function japaneseScanJpeg(): Buffer {
  const canvas = createCanvas(612, 792);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111111';
  context.font = '24px "Yu Gothic", sans-serif';
  context.fillText('従業員は週に最大3日までリモート勤務を利用できます。', 48, 120);
  return canvas.toBuffer('image/jpeg', 90);
}

describe('extractPdfPages', () => {
  it('reports page count and native extraction metrics', async () => {
    const result = await extractPdfPages(buildTestPdf(PAGES));

    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
    expect(result.nativePageCount).toBe(3);
    expect(result.ocrPageCount).toBe(0);
  });

  it('numbers pages from 1, in order', async () => {
    const result = await extractPdfPages(buildTestPdf(PAGES));
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });

  it('keeps each page text isolated', async () => {
    const result = await extractPdfPages(buildTestPdf(PAGES));

    expect(result.pages[0].text).toContain('annual paid leave');
    expect(result.pages[1].text).toContain('overtime limits');
    expect(result.pages[2].text).toContain('remote work policy');
    expect(result.pages[0].text).not.toContain('remote work');
    expect(result.pages[2].text).not.toContain('annual paid leave');
  });

  it('rejects pages when native extraction and OCR both return no usable text', async () => {
    await expect(
      extractPdfPages(buildTestPdf(['', '']), { ocrPage: async () => '' }),
    ).rejects.toMatchObject({ code: 'pdf_no_text' });
  });

  it('extracts Japanese Unicode text through an embedded ToUnicode CMap', async () => {
    const expected = '従業員は上司の承認を得たうえで、週に最大3日までリモート勤務を利用できます。';
    const result = await extractPdfPages(buildJapaneseTextPdf(expected), {
      ocrPage: async () => {
        throw new Error('OCR must not run for usable Japanese native text');
      },
    });

    expect(result.pages[0]).toMatchObject({ pageNumber: 1, source: 'native', text: expected });
    expect(result.pages[0].quality).toMatchObject({ usable: true, garbledRatio: 0 });
    expect(result.ocrPageCount).toBe(0);
  });

  it('OCRs a Japanese scanned page and preserves its page number', async () => {
    const expected = '従業員は上司の承認を得たうえで、週に最大3日までリモート勤務を利用できます。';
    const pdf = buildMixedPdf([{ kind: 'scan', jpeg: japaneseScanJpeg() }]);
    const seenPages: number[] = [];
    const result = await extractPdfPages(pdf, {
      ocrPage: async ({ pageNumber, imageDataUrl }) => {
        seenPages.push(pageNumber);
        expect(imageDataUrl).toMatch(/^data:image\/png;base64,/);
        return expected;
      },
    });

    expect(seenPages).toEqual([1]);
    expect(result.pages[0]).toMatchObject({ pageNumber: 1, source: 'ocr', text: expected });
    expect(result.ocrPageCount).toBe(1);
  });

  it('handles native/scan/native mixed PDFs and OCRs only page 2', async () => {
    const pdf = buildMixedPdf([
      { kind: 'native', text: PAGES[0] },
      { kind: 'scan', jpeg: japaneseScanJpeg() },
      { kind: 'native', text: PAGES[2] },
    ]);
    const calls: number[] = [];
    const ocrText = '従業員は上司の承認を得たうえで、週に最大3日までリモート勤務を利用できます。';
    const result = await extractPdfPages(pdf, {
      ocrPage: async ({ pageNumber }) => {
        calls.push(pageNumber);
        return ocrText;
      },
    });

    expect(calls).toEqual([2]);
    expect(result.pages.map((page) => [page.pageNumber, page.source])).toEqual([
      [1, 'native'],
      [2, 'ocr'],
      [3, 'native'],
    ]);

    const chunks = chunkPages(result.pages, { chunkSize: 1000, chunkOverlap: 150 });
    expect(chunks.find((chunk) => chunk.content.includes('従業員'))?.pageNumber).toBe(2);
  });

  it('keeps usable native pages when OCR fails on another page', async () => {
    const pdf = buildMixedPdf([
      { kind: 'native', text: PAGES[0] },
      { kind: 'scan', jpeg: japaneseScanJpeg() },
    ]);
    const result = await extractPdfPages(pdf, {
      ocrPage: async () => {
        throw new AppError('ocr_failed');
      },
    });

    expect(result.nativePageCount).toBe(1);
    expect(result.skippedPageNumbers).toEqual([2]);
    expect(result.warnings).toEqual([{ pageNumber: 2, code: 'ocr_failed' }]);
  });

  it('surfaces OCR failure and timeout when no page can be recovered', async () => {
    await expect(
      extractPdfPages(buildMixedPdf([{ kind: 'scan', jpeg: japaneseScanJpeg() }]), {
        ocrPage: async () => Promise.reject(new AppError('ocr_failed')),
      }),
    ).rejects.toMatchObject({ code: 'ocr_failed' });
    await expect(
      extractPdfPages(buildMixedPdf([{ kind: 'scan', jpeg: japaneseScanJpeg() }]), {
        ocrPage: async () => Promise.reject(new AppError('ocr_timeout')),
      }),
    ).rejects.toMatchObject({ code: 'ocr_timeout' });
  });

  it('rejects a corrupt file as unreadable rather than crashing', async () => {
    const notAPdf = new TextEncoder().encode('this is definitely not a pdf');
    await expect(extractPdfPages(notAPdf)).rejects.toMatchObject({ code: 'pdf_unreadable' });
  });

  it('rejects a password-protected PDF as unreadable without exposing parser details', async () => {
    await expect(extractPdfPages(buildPasswordProtectedPdf())).rejects.toMatchObject({
      code: 'pdf_unreadable',
      userMessage: expect.stringContaining('保護'),
    });
  });

  it('rejects a PDF over the page limit before OCR', async () => {
    const tooManyPages = Array.from({ length: 101 }, (_, i) => `Page ${i + 1} content here.`);
    await expect(extractPdfPages(buildTestPdf(tooManyPages))).rejects.toMatchObject({
      code: 'too_many_pages',
    });
  });

  it('processes a 100-page long PDF page by page without OCR', async () => {
    const longPages = Array.from(
      { length: 100 },
      (_, index) => `Long document page ${index + 1} contains independently chunked policy text.`,
    );
    let ocrCalls = 0;
    const result = await extractPdfPages(buildTestPdf(longPages), {
      ocrPage: async () => {
        ocrCalls += 1;
        return '';
      },
    });
    const chunks = chunkPages(result.pages, { chunkSize: 1000, chunkOverlap: 150 });

    expect(result.pageCount).toBe(100);
    expect(result.nativePageCount).toBe(100);
    expect(ocrCalls).toBe(0);
    expect(chunks.at(-1)?.pageNumber).toBe(100);
  });

  it('exposes a user-safe message on parser failure', async () => {
    await expect(extractPdfPages(new TextEncoder().encode('garbage'))).rejects.toMatchObject({
      userMessage: expect.stringContaining('PDF'),
    });
  });
});

describe('extraction -> chunking', () => {
  it('carries the real PDF page number onto every chunk', async () => {
    const extraction = await extractPdfPages(buildTestPdf(PAGES));
    const chunks = chunkPages(extraction.pages, { chunkSize: 1000, chunkOverlap: 150 });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const sourcePage = extraction.pages.find((page) => page.pageNumber === chunk.pageNumber);
      expect(sourcePage).toBeDefined();
      expect(sourcePage?.text).toContain(chunk.content.slice(0, 20));
    }
  });

  it('maps distinctive page content to page 3', async () => {
    const extraction = await extractPdfPages(buildTestPdf(PAGES));
    const chunks = chunkPages(extraction.pages, { chunkSize: 1000, chunkOverlap: 150 });
    expect(chunks.find((chunk) => chunk.content.includes('remote work policy'))?.pageNumber).toBe(3);
  });
});
