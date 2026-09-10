import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Empty state.
 *
 * An empty screen is the first thing a new user sees, so it explains what the
 * screen is for and offers the action that fills it, rather than just saying
 * "no data".
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-surface-muted">
        <Icon className="size-6 text-ink-subtle" aria-hidden="true" />
      </div>
      <h3 className="text-base font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-subtle">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
