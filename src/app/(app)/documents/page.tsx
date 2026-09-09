import type { Metadata } from 'next';

import { DocumentManager } from '@/components/documents/document-manager';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { listDocuments } from '@/lib/db/documents';
import { getSessionId } from '@/lib/session-server';
import type { DocumentRow } from '@/lib/types';

export const metadata: Metadata = { title: '資料' };

// Document status changes as a result of user actions, so this page must never
// be served from a static cache.
export const dynamic = 'force-dynamic';

/**
 * Documents screen.
 *
 * A Server Component fetches the list (scoped to the visitor's demo session)
 * and hands it to a Client Component that owns the interactive upload flow.
 * Only the interactive part ships JavaScript.
 */
export default async function DocumentsPage() {
  const sessionId = await getSessionId();

  let documents: DocumentRow[] = [];
  let failed = false;

  if (sessionId) {
    try {
      documents = await listDocuments(sessionId);
    } catch (error) {
      console.error('[documents] failed to load documents', error);
      failed = true;
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="資料"
        description="社内マニュアルや規程のPDFを登録します。登録された資料のみがAI回答の根拠になります。"
      />

      {failed ? (
        <Alert tone="error">資料の読み込みに失敗しました。時間をおいて再度お試しください。</Alert>
      ) : (
        <DocumentManager initialDocuments={documents} />
      )}
    </div>
  );
}
