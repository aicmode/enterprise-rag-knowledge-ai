// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { chunkPages } from '@/lib/rag/chunking';
import { extractPdfPages } from '@/lib/rag/pdf';
import { buildTestPdf } from './fixtures/make-pdf';

/**
 * End-to-end check of the ingestion front half against a real PDF.
 *
 * This is the test that actually backs the product's central claim: a citation
 * that says "P.3" points at page 3. Everything else in the pipeline is
 * bookkeeping on top of what this proves.
 *
 * Runs in the `node` environment because pdf.js needs Node APIs that jsdom does
 * not provide.
 */

const PAGES = [
  'Page one covers annual paid leave requests and approval timelines.',
  'Page two covers overtime limits and the manager approval process.',
  'Page three covers the remote work policy and eligible roles.',
];

describe('extractPdfPages', () => {
  it('reports the correct page count', async () => {
    const result = await extractPdfPages(buildTestPdf(PAGES));

    expect(result.pageCount).toBe(3);
    expect(result.pages).toHaveLength(3);
  });

  it('numbers pages from 1, in order', async () => {
    const result = await extractPdfPages(buildTestPdf(PAGES));

    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });

  it('keeps each page’s text on that page', async () => {
    const result = await extractPdfPages(buildTestPdf(PAGES));

    expect(result.pages[0].text).toContain('annual paid leave');
    expect(result.pages[1].text).toContain('overtime limits');
    expect(result.pages[2].text).toContain('remote work policy');

    // The decisive assertion: no page's text bleeds into another.
    expect(result.pages[0].text).not.toContain('remote work');
    expect(result.pages[2].text).not.toContain('annual paid leave');
  });

  it('rejects a PDF with no extractable text as a scanned document', async () => {
    // Pages that parse fine but carry no meaningful text layer.
    await expect(extractPdfPages(buildTestPdf(['', '']))).rejects.toMatchObject({
      code: 'pdf_no_text',
    });
  });

  it('rejects a corrupt file as unreadable rather than crashing', async () => {
    const notAPdf = new TextEncoder().encode('this is definitely not a pdf');

    await expect(extractPdfPages(notAPdf)).rejects.toMatchObject({ code: 'pdf_unreadable' });
  });

  it('rejects a PDF over the page limit', async () => {
    const tooManyPages = Array.from({ length: 101 }, (_, i) => `Page ${i + 1} content here.`);

    await expect(extractPdfPages(buildTestPdf(tooManyPages))).rejects.toMatchObject({
      code: 'too_many_pages',
    });
  });

  it('exposes a user-safe message on failure, with no parser internals', async () => {
    const notAPdf = new TextEncoder().encode('garbage');

    await expect(extractPdfPages(notAPdf)).rejects.toMatchObject({
      userMessage: expect.stringContaining('PDF'),
    });
  });
});

describe('extraction -> chunking', () => {
  it('carries the real PDF page number all the way onto every chunk', async () => {
    const extraction = await extractPdfPages(buildTestPdf(PAGES));
    const chunks = chunkPages(extraction.pages, { chunkSize: 1000, chunkOverlap: 150 });

    expect(chunks.length).toBeGreaterThan(0);

    for (const chunk of chunks) {
      // Each chunk's page number must match the page whose text it holds.
      const sourcePage = extraction.pages.find((page) => page.pageNumber === chunk.pageNumber);

      expect(sourcePage).toBeDefined();
      expect(sourcePage?.text).toContain(chunk.content.slice(0, 20));
    }
  });

  it('maps distinctive page content to the expected page number', async () => {
    const extraction = await extractPdfPages(buildTestPdf(PAGES));
    const chunks = chunkPages(extraction.pages, { chunkSize: 1000, chunkOverlap: 150 });

    const remoteWorkChunk = chunks.find((chunk) => chunk.content.includes('remote work policy'));

    expect(remoteWorkChunk).toBeDefined();
    expect(remoteWorkChunk?.pageNumber).toBe(3);
  });
});
