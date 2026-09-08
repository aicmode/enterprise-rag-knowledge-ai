import { ArrowLeft, Sparkles } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CitationList } from '@/components/ask/citation-card';
import { FeedbackButtons } from '@/components/ask/feedback-buttons';
import { Card, CardBody } from '@/components/ui/card';
import { formatDateTime, formatDuration } from '@/lib/format';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { Citation, FeedbackRating } from '@/lib/types';

export const metadata: Metadata = { title: '質問の詳細' };
export const dynamic = 'force-dynamic';

interface DetailRow {
  id: string;
  question: string;
  answer: string;
  sources: Citation[];
  model: string;
  response_time_ms: number | null;
  created_at: string;
  answer_feedback: { rating: FeedbackRating }[];
}

/**
 * Detail view for one archived answer.
 *
 * Citations are read back from `questions.sources`, the snapshot taken at
 * answer time. That is deliberate: it shows what the model was actually given,
 * and the record stays intact even if the underlying document is later deleted
 * or re-processed with different chunk boundaries.
 */
export default async function HistoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabaseClient();

  // RLS scopes this to the owner: another user's question id yields no row and
  // therefore a 404, never someone else's data.
  const { data, error } = await supabase
    .from('questions')
    .select('id, question, answer, sources, model, response_time_ms, created_at, answer_feedback(rating)')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) notFound();

  const row = data as DetailRow;
  const citations = Array.isArray(row.sources) ? row.sources : [];
  const rating = row.answer_feedback?.[0]?.rating ?? null;

  return (
    <div className="space-y-6">
      <Link
        href="/history"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        質問履歴に戻る
      </Link>

      <Card>
        <CardBody>
          <p className="text-xs font-medium text-ink-subtle">質問</p>
          <h1 className="break-anywhere mt-1.5 text-lg font-semibold leading-relaxed tracking-tight text-ink">
            {row.question}
          </h1>
          <p className="mt-2 text-xs text-ink-faint">{formatDateTime(row.created_at)}</p>
        </CardBody>
      </Card>

      <Card>
        <CardBody>
          <div className="flex items-center gap-2">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-50">
              <Sparkles className="size-4 text-brand-600" aria-hidden="true" />
            </div>
            <h2 className="text-sm font-semibold text-ink">AIの回答</h2>
          </div>

          <div className="break-anywhere mt-3 whitespace-pre-wrap text-sm leading-7 text-ink">
            {row.answer}
          </div>

          <CitationList citations={citations} />

          <div className="mt-6 flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
            <FeedbackButtons questionId={row.id} initialRating={rating} />
            <p className="shrink-0 text-xs text-ink-faint">
              {row.model} ・ {formatDuration(row.response_time_ms)}
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
