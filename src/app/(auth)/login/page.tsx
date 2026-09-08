import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthForm } from '@/components/auth/auth-form';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = { title: 'ログイン' };

export default function LoginPage() {
  return (
    // AuthForm reads ?redirectedFrom via useSearchParams, which requires a
    // Suspense boundary so the rest of the page can still be prerendered.
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
