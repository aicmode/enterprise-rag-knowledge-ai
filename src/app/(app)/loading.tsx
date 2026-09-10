import { Skeleton, SkeletonText } from '@/components/ui/skeleton';

/** Route-level loading skeleton, shown while a Server Component streams in. */
export default function AppLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <div className="rounded-xl border border-border-subtle bg-surface p-5">
        <SkeletonText lines={4} />
      </div>
    </div>
  );
}
