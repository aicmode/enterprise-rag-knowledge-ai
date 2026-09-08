import { Brand } from '@/components/layout/brand';

/** Centered shell for the sign-in / sign-up screens. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Brand />
        </div>
        {children}
        <p className="mt-6 text-center text-xs leading-relaxed text-ink-faint">
          社内資料を、根拠付きで検索できるナレッジAI
        </p>
      </div>
    </div>
  );
}
