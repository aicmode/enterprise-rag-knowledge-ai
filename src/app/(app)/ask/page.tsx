import type { Metadata } from 'next';

import { AskPanel } from '@/components/ask/ask-panel';
import { PageHeader } from '@/components/layout/page-header';
import { countReadyDocuments } from '@/lib/db/documents';
import { getSessionId } from '@/lib/session-server';

export const metadata: Metadata = { title: 'AIに質問' };
export const dynamic = 'force-dynamic';

/**
 * Ask AI screen.
 *
 * The server checks up front whether this session has any `ready` document, so
 * the page can guide the visitor to upload one instead of letting them ask a
 * question that can only ever answer "not found".
 */
export default async function AskPage() {
  const sessionId = await getSessionId();
  const readyDocuments = sessionId ? await countReadyDocuments(sessionId) : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="社内ナレッジAI"
        description="登録済みの資料をベクトル検索し、該当箇所のみを根拠に回答します。資料名・ページ番号・引用文が必ず添えられます。"
      />
      <AskPanel hasReadyDocuments={readyDocuments > 0} />
    </div>
  );
}
