import { ArrowRight, MessageSquareText, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime, truncate } from '@/lib/format';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { Citation, FeedbackRating } from '@/lib/types';

export const metadata: Metadata = { title: '質問履歴' };
export const dynamic = 'force-dynamic';

interface HistoryRow {
  id: string;
  question: string;
  answer: string;
  sources: Citation[];
  created_at: string;
  answer_feedback: { rating: FeedbackRating }[];
}

/**
 * Question history.
 *
 * RLS restricts `questions` to the owner, so this query needs no explicit
 * user filter to be safe -- but the policy is what guarantees it, not the
 * absence of a WHERE clause.
 *
 * Only the fields the list actually renders are selected; the full answer text
 * and every citation body would be a large payload for a screen that shows one
 * line per row.
 */
export default async function HistoryPage() {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from('questions')
    .select('id, question, answer, sources, created_at, answer_feedback(rating)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="質問履歴" />
        <Alert tone="error">履歴の読み込みに失敗しました。時間をおいて再度お試しください。</Alert>
      </div>
    );
  }

  const rows = (data ?? []) as HistoryRow[];

  return (
    <div className="space-y-6">
      <PageHeader
        title="質問履歴"
        description="過去の質問・回答・出典・評価を確認できます。表示されるのはご自身の履歴のみです。"
      />

      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={MessageSquareText}
            title="質問履歴はまだありません"
            description="AIに質問すると、質問文・回答・参照した資料とページ番号・応答時間が自動的に記録されます。"
            action={
              <Link href="/ask">
                <Button type="button">AIに質問する</Button>
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {rows.map((row) => {
              const rating = row.answer_feedback?.[0]?.rating ?? null;
              const sourceCount = Array.isArray(row.sources) ? row.sources.length : 0;

              return (
                <li key={row.id}>
                  <Link
                    href={`/history/${row.id}`}
                    className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-surface-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-anywhere text-sm font-medium text-ink">
                        {truncate(row.question, 120)}
                      </p>
                      <p className="break-anywhere mt-1 text-sm leading-relaxed text-ink-subtle">
                        {truncate(row.answer, 140)}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                        <span>{formatDateTime(row.created_at)}</span>
                        <span>出典 {sourceCount}件</span>
                        {rating ? <RatingChip rating={rating} /> : null}
                      </div>
                    </div>

                    <ArrowRight className="mt-1 size-4 shrink-0 text-ink-faint" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RatingChip({ rating }: { rating: FeedbackRating }) {
  const isHelpful = rating === 'helpful';
  const Icon = isHelpful ? ThumbsUp : ThumbsDown;

  return (
    <span
      className={
        isHelpful
          ? 'inline-flex items-center gap-1 rounded-full bg-success-50 px-2 py-0.5 text-success-600'
          : 'inline-flex items-center gap-1 rounded-full bg-danger-50 px-2 py-0.5 text-danger-700'
      }
    >
      <Icon className="size-3" aria-hidden="true" />
      {isHelpful ? '役に立った' : '役に立たなかった'}
    </span>
  );
}
