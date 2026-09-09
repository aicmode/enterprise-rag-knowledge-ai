import { MIN_PAGE_TEXT_LENGTH, type RagConfig } from '@/lib/config/rag';
import type { PdfPageText } from './pdf';

/**
 * Page-aware chunking.
 *
 * The rule that everything else depends on: **a chunk never spans two pages.**
 *
 * It would be slightly better for retrieval recall to let a chunk bridge a page
 * break (a sentence split across pages stays whole), but it would make the
 * citation ambiguous -- the chunk would have two possible page numbers and the
 * UI would have to guess. Since the product promise here is "every answer is
 * traceable to a specific page", correctness of the citation wins over a small
 * gain in recall. Each page is chunked independently and carries its own
 * `pageNumber`.
 *
 * Within a page, chunks overlap by `chunkOverlap` characters so a passage that
 * happens to straddle a chunk boundary still appears intact in at least one
 * chunk.
 */

export interface DocumentChunk {
  pageNumber: number;
  /** Sequential index within the page, starting at 0. */
  chunkIndex: number;
  content: string;
  contentLength: number;
}

/** Prefer to break on paragraph > sentence > line > space, in that order. */
const BOUNDARY_PATTERNS: readonly RegExp[] = [
  /\n\n/g, // paragraph break
  /[。．.!?！？]\s*/g, // sentence end (Japanese and Latin)
  /\n/g, // line break
  /\s/g, // any whitespace
];

/**
 * Find a natural break at or before `hardEnd`, but not before `minEnd`.
 *
 * Returns `hardEnd` when no acceptable boundary exists (e.g. a single
 * unbroken run of characters), so the chunker always makes progress.
 */
export function findBreakPoint(text: string, minEnd: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;

  const window = text.slice(0, hardEnd);

  for (const pattern of BOUNDARY_PATTERNS) {
    let best = -1;
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(window)) !== null) {
      const candidate = match.index + match[0].length;
      if (candidate > minEnd && candidate <= hardEnd) best = candidate;
      if (match[0].length === 0) pattern.lastIndex += 1; // guard against zero-width loops
    }

    if (best > 0) return best;
  }

  return hardEnd;
}

/**
 * Split a single page's text into overlapping chunks.
 *
 * Exported separately from `chunkPages` so the boundary/overlap behaviour can
 * be unit-tested directly.
 */
export function chunkPageText(
  text: string,
  pageNumber: number,
  config: Pick<RagConfig, 'chunkSize' | 'chunkOverlap'>,
): DocumentChunk[] {
  const normalized = text.trim();
  if (normalized.length === 0) return [];

  const { chunkSize } = config;
  // Overlap must stay strictly below chunkSize or the cursor cannot advance.
  const overlap = Math.min(config.chunkOverlap, Math.floor(chunkSize / 2));

  const chunks: DocumentChunk[] = [];
  let cursor = 0;
  let chunkIndex = 0;

  while (cursor < normalized.length) {
    const hardEnd = Math.min(cursor + chunkSize, normalized.length);
    // Require at least 50% of a chunk before accepting a break, so we do not
    // emit a stream of tiny fragments on text with dense punctuation.
    const minEnd = cursor + Math.floor(chunkSize * 0.5);

    const end =
      hardEnd >= normalized.length ? normalized.length : findBreakPoint(normalized, minEnd, hardEnd);

    const content = normalized.slice(cursor, end).trim();

    if (content.length > 0) {
      chunks.push({
        pageNumber,
        chunkIndex,
        content,
        contentLength: content.length,
      });
      chunkIndex += 1;
    }

    if (end >= normalized.length) break;

    // Step forward, then walk back by the overlap. `Math.max(..., cursor + 1)`
    // is the loop's termination guarantee.
    cursor = Math.max(end - overlap, cursor + 1);
  }

  return chunks;
}

/**
 * Chunk every page of an extracted PDF.
 *
 * Pages whose text is too short to be meaningful (blank pages, cover pages with
 * only a logo) are skipped rather than embedded: they would cost an embedding
 * call and could only ever surface as a useless citation.
 */
export function chunkPages(
  pages: readonly PdfPageText[],
  config: Pick<RagConfig, 'chunkSize' | 'chunkOverlap'>,
): DocumentChunk[] {
  const result: DocumentChunk[] = [];

  for (const page of pages) {
    if (page.text.trim().length < MIN_PAGE_TEXT_LENGTH) continue;
    result.push(...chunkPageText(page.text, page.pageNumber, config));
  }

  return result;
}

/** Rough token estimate used only for logging/budgeting, never for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
