import { redirect } from 'next/navigation';

import { Brand } from '@/components/layout/brand';
import { MobileNav } from '@/components/layout/mobile-nav';
import { SidebarNav } from '@/components/layout/sidebar-nav';
import { UserMenu } from '@/components/layout/user-menu';
import { createServerSupabaseClient } from '@/lib/supabase/server';

/**
 * Shell for every authenticated screen.
 *
 * The auth check is duplicated here even though middleware already guards these
 * paths: middleware can be bypassed by configuration mistakes, and a layout
 * check is what actually guarantees no Server Component below renders with a
 * null user.
 *
 * Desktop gets a fixed sidebar; below `lg` it collapses into a header plus
 * drawer (`MobileNav`).
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name')
    .eq('id', user.id)
    .maybeSingle();

  const displayName = profile?.display_name ?? null;
  const email = user.email ?? '';

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
        <UserMenu email={email} displayName={displayName} />
      </aside>

      {/* Mobile header + drawer */}
      <MobileNav email={email} displayName={displayName} />

      <div className="min-w-0 flex-1 lg:pl-64">
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
          {children}
        </main>
      </div>
    </div>
  );
}
