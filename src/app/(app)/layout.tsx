import { Brand } from '@/components/layout/brand';
import { MobileNav } from '@/components/layout/mobile-nav';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { DemoSessionMenu } from '@/components/layout/demo-session-menu';
import { getSessionId } from '@/lib/session-server';
import { formatSessionLabel } from '@/lib/session';

/**
 * Shell for every screen.
 *
 * There is no auth gate here because this deployment has no accounts: the proxy
 * guarantees a demo session cookie exists before anything renders, and every
 * query below is scoped to that session id.
 *
 * Desktop gets a fixed sidebar; below `lg` it collapses into a header plus
 * drawer (`MobileNav`).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sessionId = await getSessionId();
  const sessionLabel = sessionId ? formatSessionLabel(sessionId) : null;

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border-subtle bg-surface lg:flex">
        <div className="border-b border-border-subtle p-4">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <SidebarNav />
        </div>
        <DemoSessionMenu sessionLabel={sessionLabel} />
      </aside>

      {/* Mobile header + drawer */}
      <MobileNav sessionLabel={sessionLabel} />

      <div className="min-w-0 flex-1 lg:pl-64">
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
