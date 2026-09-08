'use client';

import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';

/**
 * Route error boundary.
 *
 * Shows a generic message only. The `error` object reaching a Client Component
 * in production is already redacted by Next.js to a digest, and we do not
 * render even that -- users get an action, not a stack trace.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[app] unhandled route error', error);
  }, [error]);

  return (
    <Card>
      <CardBody className="flex flex-col items-center px-6 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-danger-50">
          <AlertTriangle className="size-6 text-danger-600" aria-hidden="true" />
        </div>
        <h2 className="mt-4 text-base font-semibold text-ink">
          画面の表示中にエラーが発生しました
        </h2>
        <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-subtle">
          一時的な問題の可能性があります。再読み込みしても解決しない場合は、時間をおいてお試しください。
        </p>
        <Button type="button" className="mt-5" onClick={reset}>
          再読み込み
        </Button>
      </CardBody>
    </Card>
  );
}
