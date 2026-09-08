import { FileText, Quote } from 'lucide-react';

import { formatPageLabel, formatSimilarity } from '@/lib/rag/citations';
import type { Citation } from '@/lib/types';

/**
 * A single source card.
 *
 * Everything shown here comes from a `document_chunks` row that pgvector
 * actually returned:
 *
 *   - 資料名     -> documents.title
 *   - ページ番号 -> document_chunks.page_number (the real PDF page)
 *   - 引用       -> document_chunks.content
 *   - 一致度     -> cosine similarity from the search
 *
 * None of it is produced by the language model, so a page number displayed here
 * is a page number that exists.
 */
export function CitationCard({ citation }: { citation: Citation }) {
  return (
    <li className="rounded-xl border border-border-subtle bg-surface p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-xs font-semibold text-brand-700"
        >
          {citation.index}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <FileText className="size-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            <span className="break-anywhere text-sm font-medium text-ink">
              {citation.documentTitle}
            </span>
            <span className="shrink-0 rounded-md bg-surface-muted px-1.5 py-0.5 text-xs font-medium text-ink-muted">
              {formatPageLabel(citation.pageNumber)}
            </span>
            <span className="shrink-0 text-xs text-ink-faint">
              一致度 {formatSimilarity(citation.similarity)}
            </span>
          </div>

          <blockquote className="mt-2.5 flex gap-2 border-l-2 border-border-strong pl-3">
            <Quote className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden="true" />
            <p className="break-anywhere text-sm leading-relaxed text-ink-muted">
              {citation.excerpt}
            </p>
          </blockquote>
        </div>
      </div>
    </li>
  );
}

/** Source list rendered under an answer. Stacks vertically on every breakpoint. */
export function CitationList({ citations }: { citations: Citation[] }) {
  if (citations.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="text-sm font-semibold text-ink">
        出典 <span className="font-normal text-ink-subtle">({citations.length}件)</span>
      </h3>
      <p className="mt-1 text-xs text-ink-faint">
        回答は以下の箇所のみを根拠に生成されています。
      </p>
      <ul className="mt-3 space-y-3">
        {citations.map((citation) => (
          <CitationCard key={`${citation.documentId}-${citation.pageNumber}`} citation={citation} />
        ))}
      </ul>
    </section>
  );
}
