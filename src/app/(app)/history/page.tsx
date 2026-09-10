import { ArrowRight, MessageSquareText, ThumbsDown, ThumbsUp } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { listQuestions } from '@/lib/db/questions';
import { formatDateTime, truncate } from '@/lib/format';
import { getSessionId } from '@/lib/session-server';
import type { FeedbackRating, QuestionSummary } from '@/lib/types';

export const metadata: Metadata = { title: '質問履歴' };
export const dynamic = 'force-dynamic';

/**
 * Question history.
 *
 * Scoped to the visitor's demo session, so one person's history is never
 * visible to another even though nobody signs in.
 *
 * Only the fields the list actually renders are selected; the full citation
 * payload would be large for a screen that shows one line per row, so it is
 * reduced to a count in SQL.
 */
export default async function HistoryPage() {
  const sessionId = await getSessionId();

  let rows: QuestionSummary[] = [];
  let failed = false;

  if (sessionId) {
    try {
      rows = await listQuestions(sessionId);
    } catch (error) {
      console.error('[history] failed to load question history', error);
      failed = true;
    }
  }

  if (failed) {
    return (
      <div className="space-y-6">
        <PageHeader title="質問履歴" />
        <Alert tone="error">履歴の読み込みに失敗しました。時間をおいて再度お試しください。</Alert>
      </div>
    );
  }

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
              const rating = row.rating;
              const sourceCount = row.source_count;

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
