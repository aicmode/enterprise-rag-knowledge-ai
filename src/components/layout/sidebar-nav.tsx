'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cn } from '@/lib/cn';
import { NAV_ITEMS } from './nav-items';

/**
 * Navigation links with active-route highlighting.
 *
 * A Client Component only because it needs `usePathname`; the surrounding
 * layout stays a Server Component so the user's session and data are fetched on
 * the server.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1" aria-label="メインナビゲーション">
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isActive
                ? 'bg-brand-50 text-brand-700'
                : 'text-ink-muted hover:bg-surface-muted hover:text-ink',
            )}
          >
            <Icon className="size-4.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
