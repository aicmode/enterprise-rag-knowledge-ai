import { Sparkles } from 'lucide-react';

import { cn } from '@/lib/cn';

/** Product wordmark. Kept in one place so header and sidebar cannot drift. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-600">
        <Sparkles className="size-4 text-white" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold tracking-tight text-ink">
          Enterprise RAG Knowledge AI
        </p>
        <p className={cn('truncate text-xs text-ink-subtle', compact && 'hidden')}>
          社内資料を、根拠付きで検索
        </p>
      </div>
    </div>
  );
}
