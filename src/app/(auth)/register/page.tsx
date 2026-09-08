import type { Metadata } from 'next';
import { Suspense } from 'react';

import { AuthForm } from '@/components/auth/auth-form';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata: Metadata = { title: '新規登録' };

export default function RegisterPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[28rem] w-full rounded-xl" />}>
      <AuthForm mode="register" />
    </Suspense>
  );
}
