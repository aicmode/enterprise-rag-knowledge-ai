'use client';

import { Loader2, RotateCcw, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Demo session block, in the slot a signed-in app would use for the account
 * menu.
 *
 * This deployment is a public portfolio demo with no sign-up, so there is no
 * name or email to show. What matters to a visitor instead is that their
 * uploads are private to them and that they can start over -- so the block
 * states the first case and offers the second.
 *
 * "Reset" is destructive and irreversible, so it asks for confirmation first
 * rather than acting on a single click.
 */
export function DemoSessionMenu({ sessionLabel }: { sessionLabel: string | null }) {
  const router = useRouter();
  const [isConfirming, setIsConfirming] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleReset() {
    if (isResetting) return;
    setIsResetting(true);
    setError(null);

    try {
      const response = await fetch('/api/session/reset', { method: 'POST' });
      if (!response.ok) {
        // The endpoint is rate limited, so "too many resets" is a distinct and
        // actionable outcome; showing the generic failure would hide it.
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        setError(body?.error?.message ?? 'リセットに失敗しました。');
        return;
      }
      setIsConfirming(false);
      router.replace('/dashboard');
      router.refresh();
    } catch {
      setError('リセットに失敗しました。');
    } finally {
      setIsResetting(false);
    }
  }

  return (
    // `shrink-0` because, unlike the fixed-height account row this replaces,
    // the block grows when the confirmation opens -- and it sits in the
    // sidebar/drawer flex column under a `flex-1` scroll area that would
    // otherwise be free to squeeze it on a short viewport.
    <div className="shrink-0 border-t border-border-subtle p-3">
      <div className="flex items-center gap-2">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-muted">
          <UserRound className="size-4 text-ink-subtle" aria-hidden="true" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">デモセッション</p>
          <p className="truncate text-xs text-ink-subtle">
            {sessionLabel ? `ID ${sessionLabel} ・ 登録不要` : 'ログイン不要でお試しいただけます'}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setIsConfirming((open) => !open)}
          aria-expanded={isConfirming}
          aria-label="デモデータをリセット"
          title="デモデータをリセット"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink"
        >
          <RotateCcw className="size-4" aria-hidden="true" />
        </button>
      </div>

      {isConfirming ? (
        <div className="mt-3 rounded-lg border border-border-subtle bg-surface-muted/60 p-3">
          <p className="text-xs leading-relaxed text-ink-muted">
            このセッションで登録した資料と質問履歴をすべて削除し、新しいデモセッションを開始します。
          </p>
          {/* Reset clears the visitor's data, not the demo's budget. Saying so
              here keeps the button from reading as a way around the limits. */}
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            公開デモの利用回数の上限はリセットされません。
          </p>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => setIsConfirming(false)}
              disabled={isResetting}
              className="flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-surface-muted disabled:opacity-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={isResetting}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-danger-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-danger-700 disabled:opacity-50"
            >
              {isResetting ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              リセット
            </button>
          </div>

          {error ? <p className="mt-2 text-xs text-danger-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
