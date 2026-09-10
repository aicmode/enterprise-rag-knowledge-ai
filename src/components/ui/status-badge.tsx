import { AlertTriangle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

import { cn } from '@/lib/cn';
import type { DocumentStatus } from '@/lib/types';

/**
 * Visual representation of `documents.status`.
 *
 * Colour alone never carries the meaning -- each state also has a distinct icon
 * and a Japanese label, so the status is legible to colour-blind users and in
 * greyscale.
 */
const STATUS_CONFIG: Record<
  DocumentStatus,
  { label: string; className: string; icon: typeof CheckCircle2; spin?: boolean }
> = {
  uploaded: {
    label: '待機中',
    className: 'bg-surface-muted text-ink-muted border-border-strong',
    icon: Clock,
  },
  processing: {
    label: '解析中',
    className: 'bg-brand-50 text-brand-700 border-brand-200',
    icon: Loader2,
    spin: true,
  },
  ready: {
    label: '利用可能',
    className: 'bg-success-50 text-success-600 border-success-200',
    icon: CheckCircle2,
  },
  failed: {
    label: '失敗',
    className: 'bg-danger-50 text-danger-700 border-danger-200',
    icon: AlertTriangle,
  },
};

export function StatusBadge({ status }: { status: DocumentStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
        config.className,
      )}
    >
      <Icon className={cn('size-3.5', config.spin && 'animate-spin')} aria-hidden="true" />
      {config.label}
    </span>
  );
}
