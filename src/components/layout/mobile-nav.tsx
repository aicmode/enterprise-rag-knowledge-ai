'use client';

import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Brand } from './brand';
import { DemoSessionMenu } from './demo-session-menu';
import { SidebarNav } from './sidebar-nav';

/**
 * Mobile header + slide-in drawer.
 *
 * Behaviour that matters on a phone:
 *  - body scroll is locked while the drawer is open, so the page behind does
 *    not scroll under the user's finger;
 *  - Escape closes it;
 *  - tapping a link closes it, so navigation does not leave the drawer covering
 *    the destination.
 */
export function MobileNav({ sessionLabel }: { sessionLabel: string | null }) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsOpen(false);
    }

    window.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border-subtle bg-surface px-4 lg:hidden">
        <Brand compact />
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="メニューを開く"
          aria-expanded={isOpen}
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-muted"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
      </header>

      {isOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="メニューを閉じる"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-ink/40"
          />

          <div
            role="dialog"
            aria-modal="true"
            aria-label="メインメニュー"
            className="absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col bg-surface shadow-xl"
          >
            <div className="flex items-center justify-between gap-3 border-b border-border-subtle p-4">
              <Brand compact />
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="メニューを閉じる"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-muted"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3">
              <SidebarNav onNavigate={() => setIsOpen(false)} />
            </div>

            <DemoSessionMenu sessionLabel={sessionLabel} />
          </div>
        </div>
      ) : null}
    </>
  );
}
