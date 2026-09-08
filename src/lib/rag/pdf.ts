import 'server-only';

import { MAX_PAGE_COUNT, MIN_PAGE_TEXT_LENGTH } from '@/lib/config/rag';
import { AppError } from '@/lib/errors';

/**
 * PDF text extraction, page by page.
 *
 * The single most important property of this module: text never leaves the
 * page it came from. We deliberately do NOT concatenate the whole document into
 * one string before chunking, because doing so destroys the page boundary and
 * makes it impossible to say *which page* a citation came from. Page numbers
 * are the difference between "the AI says so" and "the AI says so, see 就業規則
 * P.12".
 *
 * Page numbers here are 1-based and are exactly what pdf.js reports, so
 * `pageNumber === 12` means the twelfth page of the PDF.
 */

export interface PdfPage {
  /** 1-based page number as reported by the PDF itself. */
  pageNumber: number;
  /** Normalised text content of that page. */
  text: string;
}

export interface PdfExtractionResult {
  pageCount: number;
  pages: PdfPage[];
  /** Total characters of usable text across all pages. */
  totalCharacters: number;
}

/**
 * pdf.js emits text as a stream of positioned items. Naively joining them
 * produces run-together words ("annualpaidleave"), so we rebuild spacing from
 * the layout hints pdf.js provides:
 *
 *  - `hasEOL` marks the end of a visual line -> newline
 *  - a `str` that does not already end in whitespace gets a space appended,
 *    unless the next item starts with whitespace
 *
 * Japanese text has no inter-word spaces, so we only insert a space when the
 * adjacent characters are not CJK -- otherwise every glyph run would be split.
 */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

export function joinTextItems(items: readonly TextItemLike[]): string {
  let out = '';

  for (const item of items) {
    const str = typeof item.str === 'string' ? item.str : '';

    if (str.length > 0) {
      const prevChar = out.at(-1);
      const nextChar = str[0];
      const needsSpace =
        prevChar !== undefined &&
        !/\s/.test(prevChar) &&
        nextChar !== undefined &&
        !/\s/.test(nextChar) &&
        // Do not inject spaces between CJK glyph runs.
        !CJK_RE.test(prevChar) &&
        !CJK_RE.test(nextChar);

      if (needsSpace) out += ' ';
      out += str;
    }

    if (item.hasEOL) out += '\n';
  }

  return out;
}

/** Collapse the whitespace noise typical of PDF extraction. */
export function normalizePageText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    // Soft hyphen and zero-width characters carry no meaning for retrieval.
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/[ \t　]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract every page of a PDF.
 *
 * Throws `AppError` with a user-safe code for the three failure modes that
 * matter operationally:
 *  - `pdf_unreadable` : corrupt, encrypted, or not actually a PDF
 *  - `too_many_pages` : beyond the ingestion budget
 *  - `pdf_no_text`    : parsed fine but has no text layer (i.e. a scan)
 */
export async function extractPdfPages(data: Uint8Array): Promise<PdfExtractionResult> {
  // The legacy build is the one that runs under Node without a DOM. Imported
  // lazily so the (large) parser is only loaded on the processing path.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  let loadingTask: ReturnType<typeof pdfjs.getDocument> | null = null;

  try {
    loadingTask = pdfjs.getDocument({
      data,
      // Hardening for untrusted uploads: no remote fetches while parsing, and
      // no font installation. We only ever read the text layer, so none of the
      // rendering machinery needs to be active.
      //
      // (pdf.js <= v5 also took `isEvalSupported`; v6 removed it because the
      // font compiler no longer uses eval at all, so there is nothing left to
      // switch off.)
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
    let totalCharacters = 0;

    // Sequential on purpose: pdf.js keeps per-page resources alive, and 100
    // concurrent pages is a reliable way to blow the memory limit of a
    // serverless function.
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = normalizePageText(joinTextItems(content.items as TextItemLike[]));

        pages.push({ pageNumber, text });
        if (text.length >= MIN_PAGE_TEXT_LENGTH) totalCharacters += text.length;
      } finally {
        page.cleanup();
      }
    }

    // A PDF where no page carries a meaningful text layer is a scanned image.
    // OCR is out of scope, so fail explicitly instead of storing a document
    // that could never answer a question.
    if (totalCharacters === 0) {
      throw new AppError('pdf_no_text', { detail: 'no page reached the minimum text length' });
    }

    return { pageCount, pages, totalCharacters };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('pdf_unreadable', {
      cause: error,
      detail: error instanceof Error ? error.message : 'unknown pdf parse failure',
    });
  } finally {
    // Release the worker/port regardless of outcome.
    await loadingTask?.destroy().catch(() => undefined);
  }
}
