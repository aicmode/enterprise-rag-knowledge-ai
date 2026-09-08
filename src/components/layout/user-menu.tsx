'use client';

import { LogOut, User } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { createClient } from '@/lib/supabase/client';

/**
 * Account block with sign-out.
 *
 * Sign-out clears the Supabase session cookie and then calls `router.refresh()`
 * so every cached Server Component re-renders as anonymous -- without the
 * refresh, stale personalised markup could remain visible until a hard reload.
 */
export function UserMenu({ email, displayName }: { email: string; displayName: string | null }) {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);

    try {
      await createClient().auth.signOut();
      router.replace('/login');
      router.refresh();
    } catch {
      // Even if the network call fails the local session is dropped; send the
      // user to /login rather than leaving them in a broken half-signed-in UI.
      router.replace('/login');
    } finally {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="flex items-center gap-2 border-t border-border-subtle p-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-muted">
        <User className="size-4 text-ink-subtle" aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{displayName ?? 'ユーザー'}</p>
        <p className="truncate text-xs text-ink-subtle" title={email}>
          {email}
        </p>
      </div>

      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        aria-label="ログアウト"
        title="ログアウト"
        className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-50"
      >
        <LogOut className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
