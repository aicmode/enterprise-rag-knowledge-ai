import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

type Tone = 'error' | 'success' | 'info';

const TONES: Record<Tone, { className: string; icon: typeof Info }> = {
  error: { className: 'bg-danger-50 border-danger-200 text-danger-700', icon: AlertCircle },
  success: { className: 'bg-success-50 border-success-200 text-success-600', icon: CheckCircle2 },
  info: { className: 'bg-brand-50 border-brand-200 text-brand-700', icon: Info },
};

/**
 * Inline message block.
 *
 * `role="alert"` on errors so assistive technology announces a failed upload or
 * a rejected question without the user having to hunt for the message.
 */
export function Alert({
  tone = 'info',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  const config = TONES[tone];
  const Icon = config.icon;

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3.5 py-3 text-sm',
        config.className,
        className,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="break-anywhere min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}
