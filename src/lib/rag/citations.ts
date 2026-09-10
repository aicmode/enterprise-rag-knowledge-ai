import type { Citation, MatchedChunk } from '@/lib/types';

/**
 * Citation construction.
 *
 * **Citations are built here, from retrieval results. The model never produces
 * them.**
 *
 * This is the central design decision of the whole application. If the LLM were
 * asked to output "資料名 / ページ番号", it would occasionally invent a
 * plausible-looking page that does not exist -- and a fabricated citation is
 * worse than no citation, because it looks verifiable. By deriving every
 * citation from the rows that came back from pgvector, a displayed page number
 * is a fact about the database, not a token the model chose.
 *
 * The model's only job is to write prose grounded in the supplied context; the
 * provenance is bookkeeping the application owns.
 */

/** Longest excerpt shown on a citation card before truncation. */
export const MAX_EXCERPT_LENGTH = 320;

/**
 * Trim a chunk to a readable excerpt on a word/character boundary.
 * Adds an ellipsis only when text was actually removed.
 */
export function buildExcerpt(content: string, maxLength: number = MAX_EXCERPT_LENGTH): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;

  const sliced = normalized.slice(0, maxLength);
  // Prefer to cut at the last space so a Latin word is not split in half.
  // Japanese has no spaces, so fall back to a hard cut.
  const lastSpace = sliced.lastIndexOf(' ');
  const cut = lastSpace > maxLength * 0.6 ? sliced.slice(0, lastSpace) : sliced;

  return `${cut.trimEnd()}…`;
}

/**
 * Turn raw retrieval rows into display-ready citations.
 *
 * Retrieval can return several chunks from the same page of the same document
 * (adjacent, overlapping chunks often both match). Showing that page twice adds
 * no information, so we keep only the highest-scoring chunk per
 * (document, page) pair while preserving similarity ordering.
 */
export function buildCitations(matches: readonly MatchedChunk[]): Citation[] {
  const bestByPage = new Map<string, MatchedChunk>();

  for (const match of matches) {
    const key = `${match.document_id}:${match.page_number}`;
    const existing = bestByPage.get(key);
    if (!existing || match.similarity > existing.similarity) {
      bestByPage.set(key, match);
    }
  }

  return [...bestByPage.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .map((match, i) => ({
      index: i + 1,
      documentId: match.document_id,
      documentTitle: match.document_title,
      fileName: match.file_name,
      pageNumber: match.page_number,
      excerpt: buildExcerpt(match.content),
      // Round for display stability; the raw score stays in the DB row.
      similarity: Math.round(match.similarity * 1000) / 1000,
    }));
}

/** "P.12" - the page label used on citation cards. */
export function formatPageLabel(pageNumber: number): string {
  return `P.${pageNumber}`;
}

/** "84%" - similarity rendered as a percentage. */
export function formatSimilarity(similarity: number): string {
  return `${Math.round(similarity * 100)}%`;
}
