'use client';

import { CornerDownLeft, FileWarning, Loader2, Search, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { CitationList } from '@/components/ask/citation-card';
import { FeedbackButtons } from '@/components/ask/feedback-buttons';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { MAX_QUESTION_LENGTH } from '@/lib/config/rag';
import { cn } from '@/lib/cn';
import { formatDuration } from '@/lib/format';
import type { AskSuccessResponse } from '@/lib/types';
import { validateQuestion } from '@/lib/validation/question';

type AskState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; result: AskSuccessResponse & { noDocuments?: boolean } }
  | { status: 'error'; message: string };

const EXAMPLE_QUESTIONS = [
  '有給休暇は何日前までに申請が必要ですか？',
  '残業時間の上限と申請手順を教えてください。',
  '経費精算の締め日はいつですか？',
];

/**
 * The Ask AI screen.
 *
 * Explicit states -- idle / loading / success / no-result / error -- so the user
 * always knows whether the system is working, found nothing, or failed. "Found
 * nothing" is a legitimate success here, not an error, and is presented as
 * such.
 */
export function AskPanel({ hasReadyDocuments }: { hasReadyDocuments: boolean }) {
  const [question, setQuestion] = useState('');
  const [state, setState] = useState<AskState>({ status: 'idle' });
  const [validationError, setValidationError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isLoading = state.status === 'loading';

  async function handleSubmit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    // Guard against double submission from Enter + click, or an impatient
    // second click while the first request is still open.
    if (isLoading) return;

    const validation = validateQuestion(question);
    if (!validation.ok) {
      setValidationError(validation.message);
      return;
    }

    setValidationError(null);
    setState({ status: 'loading' });

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: validation.value }),
      });

      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setState({
          status: 'error',
          message: body?.error?.message ?? '回答の生成に失敗しました。もう一度お試しください。',
        });
        return;
      }

      setState({ status: 'success', result: body });
    } catch {
      setState({
        status: 'error',
        message: '通信に失敗しました。ネットワーク環境を確認してもう一度お試しください。',
      });
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl + Enter submits; plain Enter inserts a newline, since questions
    // about company policy are often multi-line.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleSubmit();
    }
  }

  function applyExample(example: string) {
    setQuestion(example);
    setValidationError(null);
    textareaRef.current?.focus();
  }

  const remaining = MAX_QUESTION_LENGTH - question.length;

  return (
    <div className="space-y-6">
      {!hasReadyDocuments ? (
        <Alert tone="info">
          回答可能な資料がまだありません。
          <Link href="/documents" className="ml-1 font-medium underline hover:no-underline">
            資料画面
          </Link>
          からPDFを登録すると、根拠付きの回答ができるようになります。
        </Alert>
      ) : null}

      {/* ---------------- Question input ---------------- */}
      <Card>
        <CardBody>
          <form onSubmit={handleSubmit}>
            <label htmlFor="question" className="mb-2 block text-sm font-medium text-ink">
              質問を入力
            </label>

            <textarea
              id="question"
              ref={textareaRef}
              value={question}
              onChange={(event) => {
                setQuestion(event.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={handleKeyDown}
              rows={3}
              maxLength={MAX_QUESTION_LENGTH}
              disabled={isLoading}
              placeholder="例：有給休暇は何日前までに申請が必要ですか？"
              aria-describedby="question-hint"
              aria-invalid={validationError ? true : undefined}
              className={cn(
                'w-full resize-y rounded-lg border bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink transition-colors placeholder:text-ink-faint disabled:bg-surface-muted',
                validationError
                  ? 'border-danger-200 focus:border-danger-600'
                  : 'border-border-strong hover:border-ink-faint focus:border-brand-500',
              )}
            />

            <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
              <p id="question-hint" className="text-xs text-ink-faint">
                Cmd / Ctrl + Enter で送信 ・ 残り {remaining} 文字
              </p>

              <Button type="submit" disabled={isLoading || question.trim().length === 0}>
                {isLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    検索中...
                  </>
                ) : (
                  <>
                    <CornerDownLeft className="size-4" aria-hidden="true" />
                    質問する
                  </>
                )}
              </Button>
            </div>

            {validationError ? (
              <Alert tone="error" className="mt-3">
                {validationError}
              </Alert>
            ) : null}
          </form>

          {state.status === 'idle' ? (
            <div className="mt-5 border-t border-border-subtle pt-4">
              <p className="text-xs font-medium text-ink-subtle">質問の例</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {EXAMPLE_QUESTIONS.map((example) => (
                  <button
                    key={example}
                    type="button"
                    onClick={() => applyExample(example)}
                    className="rounded-full border border-border-strong bg-surface px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </CardBody>
      </Card>

      {/* ---------------- Result ---------------- */}
      {state.status === 'loading' ? <AnswerSkeleton /> : null}

      {state.status === 'error' ? <Alert tone="error">{state.message}</Alert> : null}

      {state.status === 'success' ? <AnswerResult result={state.result} /> : null}

      {state.status === 'idle' && hasReadyDocuments ? (
        <Card>
          <EmptyState
            icon={Search}
            title="質問を入力してください"
            description="登録済みの資料をベクトル検索し、該当箇所のみを根拠にAIが回答します。回答には資料名・ページ番号・引用文が必ず添えられます。"
          />
        </Card>
      ) : null}
    </div>
  );
}

function AnswerSkeleton() {
  return (
    <Card>
      <CardBody className="space-y-3">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <div className="pt-3">
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </CardBody>
    </Card>
  );
}

function AnswerResult({ result }: { result: AskSuccessResponse & { noDocuments?: boolean } }) {
  // "No relevant context" is a successful, honest outcome -- not an error.
  if (result.noRelevantContext) {
    return (
      <Card>
        <EmptyState
          icon={FileWarning}
          title={result.answer}
          description={
            result.noDocuments
              ? '「資料」画面からPDFをアップロードすると、根拠付きの回答ができるようになります。'
              : '登録済みの資料には該当する記述が見つかりませんでした。表現を変えるか、該当資料が登録済みかご確認ください。'
          }
          action={
            result.noDocuments ? (
              <Link href="/documents">
                <Button type="button">資料をアップロード</Button>
              </Link>
            ) : null
          }
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <div className="flex items-center gap-2">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-50">
            <Sparkles className="size-4 text-brand-600" aria-hidden="true" />
          </div>
          <h2 className="text-sm font-semibold text-ink">AIの回答</h2>
        </div>

        {/* The answer text and the citations are visually and structurally
            separate, so it is always obvious which part is generated prose and
            which part is verifiable source material. */}
        <div className="break-anywhere mt-3 whitespace-pre-wrap text-sm leading-7 text-ink">
          {result.answer}
        </div>

        <CitationList citations={result.citations} />

        <div className="mt-6 flex flex-col gap-3 border-t border-border-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
          {result.questionId ? <FeedbackButtons questionId={result.questionId} /> : <span />}

          <p className="shrink-0 text-xs text-ink-faint">
            {result.model} ・ {formatDuration(result.responseTimeMs)}
          </p>
        </div>
      </CardBody>
    </Card>
  );
}
