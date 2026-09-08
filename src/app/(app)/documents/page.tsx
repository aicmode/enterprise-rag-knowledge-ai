import type { Metadata } from 'next';

import { DocumentManager } from '@/components/documents/document-manager';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { DocumentRow } from '@/lib/types';

export const metadata: Metadata = { title: '資料' };

// Document status changes as a result of user actions, so this page must never
// be served from a static cache.
export const dynamic = 'force-dynamic';

/**
 * Documents screen.
 *
 * A Server Component fetches the list (RLS restricts it to the caller) and
 * hands it to a Client Component that owns the interactive upload flow. Only
 * the interactive part ships JavaScript.
 */
export default async function DocumentsPage() {
  const supabase = await createServerSupabaseClient();

  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .order('created_at', { ascending: false });

  return (
    <div className="space-y-6">
      <PageHeader
        title="資料"
        description="社内マニュアルや規程のPDFを登録します。登録された資料のみがAI回答の根拠になります。"
      />

      {error ? (
        <Alert tone="error">資料の読み込みに失敗しました。時間をおいて再度お試しください。</Alert>
      ) : (
        <DocumentManager initialDocuments={(data ?? []) as DocumentRow[]} />
      )}
    </div>
  );
}
