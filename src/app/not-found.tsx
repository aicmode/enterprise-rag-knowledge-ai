import Link from 'next/link';

/** 404 page. Kept minimal and outside the app shell so it works when signed out. */
export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 text-center">
      <p className="text-sm font-medium text-brand-600">404</p>
      <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink">
        ページが見つかりませんでした
      </h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-subtle">
        URLが変更されたか、アクセス権限のないページの可能性があります。
      </p>
      <Link
        href="/dashboard"
        className="mt-6 inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white transition-colors hover:bg-brand-700"
      >
        ダッシュボードへ戻る
      </Link>
    </div>
  );
}
