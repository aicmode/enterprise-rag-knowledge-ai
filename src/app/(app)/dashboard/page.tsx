import {
  ArrowRight,
  CheckCircle2,
  FileText,
  MessageSquareText,
  ThumbsUp,
  UploadCloud,
} from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  countDocuments,
  countReadyDocuments,
  listRecentDocuments,
} from '@/lib/db/documents';
import {
  countQuestions,
  getFeedbackTotals,
  listRecentQuestions,
} from '@/lib/db/questions';
import { formatDateTime, formatPercent, truncate } from '@/lib/format';
import { getSessionId } from '@/lib/session-server';

export const metadata: Metadata = { title: 'ダッシュボード' };
export const dynamic = 'force-dynamic';

/**
 * Dashboard.
 *
 * A Server Component throughout -- it is read-only, so none of it needs to ship
 * JavaScript. The counts are `count(*)` aggregates, so Postgres never transfers
 * the rows themselves.
 */
export default async function DashboardPage() {
  const sessionId = await getSessionId();

  if (!sessionId) {
    // The proxy mints the session cookie before anything renders, so this only
    // happens if the request bypassed it entirely. Rendering zeroes would be a
    // lie; say what is actually wrong instead.
    return (
      <div className="space-y-6">
        <PageHeader title="ダッシュボード" />
        <Alert tone="error">
          デモセッションを開始できませんでした。ページを再読み込みしてください。
        </Alert>
      </div>
    );
  }

  // Independent reads, issued concurrently. Every one of them is scoped to this
  // visitor's demo session.
  const [
    totalDocuments,
    readyDocuments,
    totalQuestions,
    feedbackTotals,
    documents,
    questions,
  ] = await Promise.all([
    countDocuments(sessionId),
    countReadyDocuments(sessionId),
    countQuestions(sessionId),
    getFeedbackTotals(sessionId),
    listRecentDocuments(sessionId, 5),
    listRecentQuestions(sessionId, 5),
  ]);

  const feedbackCount = feedbackTotals.total;
  const helpfulRate = feedbackCount > 0 ? feedbackTotals.helpful / feedbackCount : null;

  const hasNoDocuments = totalDocuments === 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="ダッシュボード"
        description="登録済み資料の解析状況と、ナレッジAIの利用状況を確認できます。"
      />

      {/* ---------------- Stats ---------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={FileText}
          label="登録資料数"
          value={String(totalDocuments)}
          unit="件"
        />
        <StatCard
          icon={CheckCircle2}
          label="解析完了"
          value={String(readyDocuments)}
          unit="件"
          hint="質問の根拠として利用可能"
        />
        <StatCard
          icon={MessageSquareText}
          label="累計質問数"
          value={String(totalQuestions)}
          unit="件"
        />
        <StatCard
          icon={ThumbsUp}
          label="Helpful率"
          value={helpfulRate === null ? '—' : formatPercent(helpfulRate)}
          hint={feedbackCount === 0 ? '評価がまだありません' : `${feedbackCount}件の評価に基づく`}
        />
      </div>

      {/* ---------------- Primary actions ---------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ActionCard
          href="/ask"
          icon={MessageSquareText}
          title="AIに質問する"
          description="登録済みの資料から、根拠付きで回答を得ます。"
          cta="質問をはじめる"
          primary
        />
        <ActionCard
          href="/documents"
          icon={UploadCloud}
          title="PDFをアップロード"
          description="社内マニュアルや規程を登録して、検索対象を増やします。"
          cta="資料を登録する"
        />
      </div>

      {/* ---------------- Recent ---------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between gap-3">
            <CardTitle>最近登録した資料</CardTitle>
            <Link
              href="/documents"
              className="shrink-0 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
            >
              すべて見る
            </Link>
          </CardHeader>

          {documents.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="資料がまだありません"
              description="PDFを登録すると、テキスト解析と必要ページのOCR・ベクトル化が行われ、検索対象になります。"
              action={
                <Link href="/documents">
                  <Button type="button" size="sm">
                    <UploadCloud className="size-4" aria-hidden="true" />
                    PDFをアップロード
                  </Button>
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {documents.map((document) => (
                <li key={document.id} className="flex items-center gap-3 px-5 py-3">
                  <FileText className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="break-anywhere text-sm font-medium text-ink">{document.title}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">
                      {formatDateTime(document.created_at)}
                    </p>
                  </div>
                  <StatusBadge status={document.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader className="flex items-center justify-between gap-3">
            <CardTitle>最近の質問</CardTitle>
            <Link
              href="/history"
              className="shrink-0 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
            >
              すべて見る
            </Link>
          </CardHeader>

          {questions.length === 0 ? (
            <EmptyState
              icon={MessageSquareText}
              title="質問履歴はまだありません"
              description={
                hasNoDocuments
                  ? 'まずは資料を登録すると、AIへの質問ができるようになります。'
                  : '「AIに質問」から、社内資料に対する質問を試してみましょう。'
              }
              action={
                <Link href={hasNoDocuments ? '/documents' : '/ask'}>
                  <Button type="button" size="sm">
                    {hasNoDocuments ? '資料を登録する' : '質問してみる'}
                  </Button>
                </Link>
              }
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {questions.map((question) => (
                <li key={question.id}>
                  <Link
                    href={`/history/${question.id}`}
                    className="flex items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-muted"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-anywhere text-sm text-ink">
                        {truncate(question.question, 60)}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {formatDateTime(question.created_at)}
                      </p>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  unit,
  hint,
}: {
  icon: typeof FileText;
  label: string;
  value: string;
  unit?: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-ink-faint" aria-hidden="true" />
          <p className="truncate text-sm text-ink-muted">{label}</p>
        </div>
        <p className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-semibold tracking-tight text-ink">{value}</span>
          {unit ? <span className="text-sm text-ink-subtle">{unit}</span> : null}
        </p>
        {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
      </CardBody>
    </Card>
  );
}

function ActionCard({
  href,
  icon: Icon,
  title,
  description,
  cta,
  primary,
}: {
  href: string;
  icon: typeof FileText;
  title: string;
  description: string;
  cta: string;
  primary?: boolean;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-50">
            <Icon className="size-5 text-brand-600" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{title}</p>
            <p className="mt-0.5 text-sm leading-relaxed text-ink-subtle">{description}</p>
          </div>
        </div>

        <Link href={href} className="shrink-0">
          <Button type="button" variant={primary ? 'primary' : 'secondary'}>
            {cta}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </Link>
      </CardBody>
    </Card>
  );
}
