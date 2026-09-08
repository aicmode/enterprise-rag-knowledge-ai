'use client';

import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/cn';
import type { FeedbackRating } from '@/lib/types';

/**
 * Helpful / Not Helpful control.
 *
 * Why capture this at all: retrieval quality is the hardest part of a RAG
 * system to measure, and there is no automatic signal for "this answer was
 * actually useful". Storing an explicit rating next to the question, the
 * retrieved sources and the model name gives a dataset for finding which
 * queries retrieve badly -- which is what you would tune chunk size and
 * similarity threshold against.
 *
 * The vote is an UPSERT server-side, so changing your mind updates the existing
 * row rather than adding a second one.
 */
export function FeedbackButtons({
  questionId,
  initialRating = null,
}: {
  questionId: string;
  initialRating?: FeedbackRating | null;
}) {
  const [rating, setRating] = useState<FeedbackRating | null>(initialRating);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(next: FeedbackRating) {
    if (isSaving) return;

    setIsSaving(true);
    setError(null);

    // Optimistic: the control responds immediately and rolls back on failure.
    const previous = rating;
    setRating(next);

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, rating: next }),
      });

      if (!response.ok) {
        setRating(previous);
        setError('評価の保存に失敗しました。');
      }
    } catch {
      setRating(previous);
      setError('評価の保存に失敗しました。');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs text-ink-subtle">この回答は役に立ちましたか？</span>

      <div className="flex items-center gap-2">
        <FeedbackButton
          label="役に立った"
          icon={ThumbsUp}
          isActive={rating === 'helpful'}
          activeClassName="border-success-200 bg-success-50 text-success-600"
          disabled={isSaving}
          onClick={() => void submit('helpful')}
        />
        <FeedbackButton
          label="役に立たなかった"
          icon={ThumbsDown}
          isActive={rating === 'not_helpful'}
          activeClassName="border-danger-200 bg-danger-50 text-danger-700"
          disabled={isSaving}
          onClick={() => void submit('not_helpful')}
        />
      </div>

      {error ? <span className="text-xs text-danger-600">{error}</span> : null}
    </div>
  );
}

function FeedbackButton({
  label,
  icon: Icon,
  isActive,
  activeClassName,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof ThumbsUp;
  isActive: boolean;
  activeClassName: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isActive}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:opacity-50',
        isActive
          ? activeClassName
          : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-muted',
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}
