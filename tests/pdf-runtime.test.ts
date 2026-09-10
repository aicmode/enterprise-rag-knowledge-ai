// @vitest-environment node
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import nextConfig from '../next.config';
import { extractPdfPages } from '@/lib/rag/pdf';
import { buildPredefinedCMapJapanesePdf, buildTestPdf } from './fixtures/make-pdf';

/**
 * Regression guards for the way pdf.js finds its own files on a serverless
 * runtime.
 *
 * Vercel Preview returned 422 `pdf_unreadable` for every PDF with
 * `Setting up fake worker failed: Cannot find module
 * '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'`, while the
 * same PDFs parsed locally. The difference is not pdf.js: it is that a local
 * run has the whole of node_modules on disk, and a deployed function has only
 * what the file tracer copied. pdf.js reaches for its worker, CMaps, fonts and
 * wasm modules through runtime-computed paths that no static analysis can
 * follow, so none of it is traced unless something says so explicitly.
 *
 * These tests therefore assert both halves of the fix: that the runtime never
 * needs to resolve a worker path at all, and that everything it *does* still
 * read from disk is declared for the tracer.
 */

const PDFJS_ROOT = path.join(process.cwd(), 'node_modules', 'pdfjs-dist');

function tracedAssets(): readonly string[] {
  const includes = nextConfig.outputFileTracingIncludes?.['/api/documents/process'];
  expect(includes, 'the processing route must declare its pdf.js assets').toBeDefined();
  return includes as readonly string[];
}

describe('pdf.js worker resolution', () => {
  it('runs the worker in-process instead of resolving a worker path', async () => {
    await extractPdfPages(buildTestPdf(['Worker resolution regression guard page text.']));

    // Set by `extractPdfPages` before the first `getDocument()`. Its presence is
    // what makes pdf.js short-circuit `_setupFakeWorkerGlobal` and skip the
    // `import(GlobalWorkerOptions.workerSrc)` that failed on Vercel.
    const installed = (globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } })
      .pdfjsWorker;

    expect(installed).toBeDefined();
    expect(typeof installed?.WorkerMessageHandler).toBe('function');
  });

  it('parses without a worker file next to the current working directory', async () => {
    // The default `workerSrc` is the relative "./pdf.worker.mjs". Nothing in the
    // project root can satisfy it, so a parse that succeeds here is a parse that
    // never consulted `workerSrc` -- the exact condition that was missing in the
    // function bundle.
    expect(existsSync(path.join(process.cwd(), 'pdf.worker.mjs'))).toBe(false);

    const result = await extractPdfPages(buildTestPdf(['Second document, same process, no worker path.']));
    expect(result.pageCount).toBe(1);
  });

  it('traces the worker module into the serverless function', () => {
    expect(tracedAssets()).toContain('./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs');
    expect(existsSync(path.join(PDFJS_ROOT, 'legacy', 'build', 'pdf.worker.mjs'))).toBe(true);
  });
});

describe('pdf.js runtime assets', () => {
  it('reads a predefined CMap from the packaged cmaps directory', async () => {
    // pdf.js hands the `cMapUrl` prefix straight to `fs.readFile` on Node, which
    // rejects a `file://` URL string. When the prefix is unusable this page
    // still "succeeds" -- it just comes back empty and silently falls through to
    // paid OCR -- so the assertion has to be on the extracted text.
    const expected = '従業員は上司の承認を得たうえで、週に最大三日までリモート勤務を利用できます。';
    const result = await extractPdfPages(buildPredefinedCMapJapanesePdf(expected), {
      ocrPage: async () => {
        throw new Error('OCR must not run: the CMap should make this page natively readable');
      },
    });

    expect(result.pages[0]).toMatchObject({ pageNumber: 1, source: 'native', text: expected });
    expect(result.ocrPageCount).toBe(0);
  });

  it('traces every directory pdf.js reads at runtime', () => {
    const includes = tracedAssets();

    for (const directory of ['cmaps', 'standard_fonts', 'wasm'] as const) {
      expect(includes).toContain(`./node_modules/pdfjs-dist/${directory}/**/*`);
      expect(existsSync(path.join(PDFJS_ROOT, directory))).toBe(true);
    }
  });
});
