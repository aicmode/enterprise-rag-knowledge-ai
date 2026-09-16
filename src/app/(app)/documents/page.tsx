import type { Metadata } from 'next';

import { DocumentManager } from '@/components/documents/document-manager';
import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { isDemoAiRuntime } from '@/lib/config/ai-runtime';
import { listDocuments } from '@/lib/db/documents';
import { listDemoDocuments } from '@/lib/demo/corpus';
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
 *
 * In the public demo the list is the fixed sample corpus and the upload flow is
 * closed -- ingestion is the billable half of this product, so the demo shows
 * its output rather than running it. The screen, the cards and the statuses are
 * the same components either way.
 */
export default async function DocumentsPage() {
  const demoMode = isDemoAiRuntime();
  const sessionId = await getSessionId();

  let documents: DocumentRow[] = [];
  let failed = false;

  if (demoMode) {
    documents = listDemoDocuments();
  } else if (sessionId) {
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
        description={
          demoMode
            ? '公開デモではサンプル資料を登録済みの状態でご用意しています。登録された資料のみがAI回答の根拠になります。'
            : '社内マニュアルや規程のPDFを登録します。登録された資料のみがAI回答の根拠になります。'
        }
      />

      {failed ? (
        <Alert tone="error">資料の読み込みに失敗しました。時間をおいて再度お試しください。</Alert>
      ) : (
        <DocumentManager initialDocuments={documents} demoMode={demoMode} />
      )}
    </div>
  );
}
