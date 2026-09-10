import 'server-only';

import path from 'node:path';
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api';

import {
  MAX_GARBLED_TEXT_RATIO,
  MAX_PAGE_COUNT,
  MIN_PAGE_TEXT_LENGTH,
  OCR_MAX_IMAGE_DIMENSION,
  OCR_RENDER_SCALE,
} from '@/lib/config/rag';
import { AppError } from '@/lib/errors';
import type { OcrPage } from './ocr';

export type PdfPageSource = 'native' | 'ocr' | 'unavailable';

export interface PageTextQuality {
  characterCount: number;
  nonWhitespaceCharacterCount: number;
  garbledRatio: number;
  usable: boolean;
}

export interface PdfPageText {
  /** Original 1-based PDF page number. */
  pageNumber: number;
  text: string;
}

export interface PdfPage extends PdfPageText {
  /** Whether final text came from native extraction, OCR, or remained unavailable. */
  source: PdfPageSource;
  /** Metrics from stage 1, retained even when OCR supplies the final text. */
  nativeQuality: PageTextQuality;
  /** Metrics for the final selected text. */
  quality: PageTextQuality;
}

export interface PdfExtractionWarning {
  pageNumber: number;
  code: 'ocr_failed' | 'ocr_timeout' | 'ocr_no_text';
}

export interface PdfExtractionResult {
  pageCount: number;
  pages: PdfPage[];
  totalCharacters: number;
  nativePageCount: number;
  ocrPageCount: number;
  skippedPageNumbers: number[];
  warnings: PdfExtractionWarning[];
}

export interface ExtractPdfOptions {
  /**
   * Per-page OCR implementation.
   *
   * Production always passes one: `processDocument` supplies a wrapper that
   * charges the demo's OCR budget before each call, which is what keeps a
   * scanned PDF from being an unmetered route to the vision model. Omitting it
   * falls back to calling OpenAI directly, which is for tests and scripts only.
   */
  ocrPage?: OcrPage;
}

const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/** Join positioned PDF.js text runs without injecting spaces between CJK glyphs. */
export function joinTextItems(items: readonly TextItemLike[]): string {
  let out = '';

  for (const item of items) {
    const str = typeof item.str === 'string' ? item.str : '';

    if (str.length > 0) {
      const prevChar = out.at(-1);
      const nextChar = str[0];
      const needsSpace =
        prevChar !== undefined &&
        !/\s/u.test(prevChar) &&
        nextChar !== undefined &&
        !/\s/u.test(nextChar) &&
        !CJK_RE.test(prevChar) &&
        !CJK_RE.test(nextChar);

      if (needsSpace) out += ' ';
      out += str;
    }

    if (item.hasEOL) out += '\n';
  }

  return out;
}

/** Normalize extraction noise without changing full-width or Japanese semantics. */
export function normalizePageText(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t　]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isSuspiciousCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return true;

  return (
    char === '\ufffd' ||
    char === '\u25a1' ||
    (codePoint >= 0 && codePoint <= 8) ||
    (codePoint >= 11 && codePoint <= 31) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xe000 && codePoint <= 0xf8ff) ||
    (codePoint >= 0xf0000 && codePoint <= 0xffffd) ||
    (codePoint >= 0x100000 && codePoint <= 0x10fffd)
  );
}

/** Evaluate one page independently; a document-wide length check is insufficient. */
export function evaluatePageText(rawText: string): { text: string; quality: PageTextQuality } {
  const text = normalizePageText(rawText);
  const characters = Array.from(text);
  const nonWhitespace = characters.filter((char) => !/\s/u.test(char));
  const suspiciousCount = nonWhitespace.filter(isSuspiciousCharacter).length;
  const garbledRatio = nonWhitespace.length === 0 ? 0 : suspiciousCount / nonWhitespace.length;

  return {
    text,
    quality: {
      characterCount: characters.length,
      nonWhitespaceCharacterCount: nonWhitespace.length,
      garbledRatio,
      usable:
        nonWhitespace.length >= MIN_PAGE_TEXT_LENGTH && garbledRatio <= MAX_GARBLED_TEXT_RATIO,
    },
  };
}

/**
 * Run the pdf.js worker module in this process instead of resolving it by path.
 *
 * pdf.js does all parsing in a worker. Node has no Web Worker, so the library
 * falls back to loading the worker module in-process, and to find it it
 * dynamic-imports `GlobalWorkerOptions.workerSrc` -- a *computed* specifier it
 * defaults to the relative `"./pdf.worker.mjs"`. A computed specifier is
 * invisible to bundlers and to the Vercel file tracer, so `pdf.worker.mjs` was
 * never copied into the serverless function: locally the whole of node_modules
 * is on disk and the relative import resolves, on Vercel it failed with
 * `Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'`.
 *
 * `globalThis.pdfjsWorker` is the hook pdf.js checks *before* it touches
 * `workerSrc`, so publishing the module here means no worker path is ever
 * resolved at runtime -- and the static specifier below is one the tracer can
 * follow. It must be installed before the first `getDocument()` call, because
 * pdf.js memoizes the lookup on first use.
 */
let workerInstallation: Promise<void> | null = null;

function installPdfJsWorker(): Promise<void> {
  workerInstallation ??= import('pdfjs-dist/legacy/build/pdf.worker.mjs').then(
    (worker) => {
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= worker;
    },
    (error: unknown) => {
      // Don't cache the failure: the retry button must get a real second try.
      workerInstallation = null;
      throw error;
    },
  );
  return workerInstallation;
}

function pdfJsAssetPath(directory: 'cmaps' | 'standard_fonts' | 'wasm'): string {
  // pdf.js appends a file name to this prefix and, on Node, hands the result
  // straight to `fs.readFile`, which does not accept a `file://` URL string --
  // it must be a plain filesystem path ending in a separator.
  //
  // `require.resolve()` is rewritten to a numeric module id by webpack when
  // used in route code. `process.cwd()` remains the deployment root on Vercel,
  // and next.config explicitly traces these package assets into the function.
  return `${path.join(process.cwd(), 'node_modules', 'pdfjs-dist', directory)}/`;
}

/** Render only an OCR-target page and cap dimensions before paying image-token cost. */
async function renderPageDataUrl(page: PDFPageProxy): Promise<`data:image/png;base64,${string}`> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = Math.min(
    OCR_RENDER_SCALE,
    OCR_MAX_IMAGE_DIMENSION / Math.max(baseViewport.width, baseViewport.height),
  );
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));

  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
    background: '#ffffff',
  }).promise;

  return `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`;
}

/**
 * Fallback used only when the caller supplies no `ocrPage`.
 *
 * This path is **unmetered**: it calls the vision model directly. The
 * application never reaches it -- `processDocument` always passes a wrapper
 * that charges the demo's OCR budget first -- and any new production caller
 * must do the same. It exists so `extractPdfPages` stays usable on its own in
 * tests and one-off scripts.
 */
async function defaultOcrPage(input: Parameters<OcrPage>[0]): Promise<string> {
  // Keep OpenAI and its key completely off the native-only path.
  const { ocrPageImage } = await import('./ocr');
  return ocrPageImage(input);
}

/**
 * Two-stage, page-preserving extraction: native first, OCR only when required.
 * Pages are processed sequentially to bound both serverless memory and API load.
 */
export async function extractPdfPages(
  data: Uint8Array,
  options: ExtractPdfOptions = {},
): Promise<PdfExtractionResult> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;

  try {
    // Inside the try so that a failure to load the worker is reported as a PDF
    // parse failure with its technical cause intact, rather than escaping raw.
    await installPdfJsWorker();

    loadingTask = pdfjs.getDocument({
      data,
      cMapUrl: pdfJsAssetPath('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: pdfJsAssetPath('standard_fonts'),
      // Scanned pages are routinely JBIG2- or JPEG2000-compressed, which pdf.js
      // decodes with the WebAssembly modules shipped in the package.
      wasmUrl: pdfJsAssetPath('wasm'),
      useSystemFonts: false,
      useWorkerFetch: false,
      disableFontFace: true,
    });

    const doc = await loadingTask.promise;
    const pageCount = doc.numPages;

    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new AppError('pdf_unreadable', { detail: `unexpected page count: ${pageCount}` });
    }
    if (pageCount > MAX_PAGE_COUNT) {
      throw new AppError('too_many_pages', { detail: `page count ${pageCount} > ${MAX_PAGE_COUNT}` });
    }

    const pages: PdfPage[] = [];
    const warnings: PdfExtractionWarning[] = [];
    const terminalOcrErrors: AppError[] = [];
    let totalCharacters = 0;
    let nativePageCount = 0;
    let ocrPageCount = 0;
    const ocrPage = options.ocrPage ?? defaultOcrPage;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        let native = evaluatePageText('');
        try {
          const content = await page.getTextContent();
          native = evaluatePageText(joinTextItems(content.items as TextItemLike[]));
        } catch {
          // A damaged text layer can still have a renderable image for OCR.
        }

        if (native.quality.usable) {
          pages.push({ pageNumber, ...native, nativeQuality: native.quality, source: 'native' });
          totalCharacters += native.quality.characterCount;
          nativePageCount += 1;
          continue;
        }

        try {
          const imageDataUrl = await renderPageDataUrl(page);
          const ocr = evaluatePageText(await ocrPage({ pageNumber, imageDataUrl }));

          if (ocr.quality.usable) {
            pages.push({
              pageNumber,
              ...ocr,
              nativeQuality: native.quality,
              source: 'ocr',
            });
            totalCharacters += ocr.quality.characterCount;
            ocrPageCount += 1;
          } else {
            pages.push({
              pageNumber,
              ...ocr,
              text: '',
              nativeQuality: native.quality,
              source: 'unavailable',
            });
            warnings.push({ pageNumber, code: 'ocr_no_text' });
          }
        } catch (error) {
          // A refused OCR budget is not a page-level failure to recover from:
          // continuing would call the model again for every remaining page and
          // be refused every time, and the visitor would be told the PDF was
          // unreadable when in fact the demo limit was reached. Abort the run
          // and let the 429 reach them intact.
          if (error instanceof AppError && error.code === 'rate_limited') throw error;

          const appError =
            error instanceof AppError && (error.code === 'ocr_timeout' || error.code === 'ocr_failed')
              ? error
              : new AppError('ocr_failed', {
                  cause: error,
                  detail: error instanceof Error ? error.message : 'page rendering or OCR failed',
                });

          terminalOcrErrors.push(appError);
          pages.push({
            pageNumber,
            ...native,
            text: '',
            nativeQuality: native.quality,
            source: 'unavailable',
          });
          warnings.push({ pageNumber, code: appError.code as 'ocr_failed' | 'ocr_timeout' });
        }
      } finally {
        page.cleanup();
      }
    }

    if (nativePageCount + ocrPageCount === 0) {
      const timeout = terminalOcrErrors.find((error) => error.code === 'ocr_timeout');
      if (timeout) throw timeout;
      if (terminalOcrErrors.length > 0) throw terminalOcrErrors[0];
      throw new AppError('pdf_no_text', { detail: 'native extraction and OCR produced no usable pages' });
    }

    return {
      pageCount,
      pages,
      totalCharacters,
      nativePageCount,
      ocrPageCount,
      skippedPageNumbers: pages
        .filter((page) => page.source === 'unavailable')
        .map((page) => page.pageNumber),
      warnings,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('pdf_unreadable', {
      cause: error,
      detail: error instanceof Error ? error.message : 'unknown pdf parse failure',
    });
  } finally {
    await loadingTask?.destroy().catch(() => undefined);
  }
}
