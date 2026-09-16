import type { Metadata } from 'next';

import { AskPanel } from '@/components/ask/ask-panel';
import { PageHeader } from '@/components/layout/page-header';
import { isDemoAiRuntime } from '@/lib/config/ai-runtime';
import { countReadyDocuments } from '@/lib/db/documents';
import { DEMO_DOCUMENTS } from '@/lib/demo/corpus';
import { getSessionId } from '@/lib/session-server';

export const metadata: Metadata = { title: 'AIに質問' };
export const dynamic = 'force-dynamic';

/**
 * Ask AI screen.
 *
 * The server checks up front whether this session has any `ready` document, so
 * the page can guide the visitor to upload one instead of letting them ask a
 * question that can only ever answer "not found".
 *
 * In the public demo that check is answered by the sample corpus, which is
 * always present -- there is nothing to upload and nothing to wait for, so the
 * visitor can ask immediately. `demoMode` is resolved here, on the server, and
 * passed down as a plain boolean: the runtime mode is a server-side concern and
 * nothing about it is exposed as a `NEXT_PUBLIC_*` value.
 */
export default async function AskPage() {
  const demoMode = isDemoAiRuntime();
  const sessionId = await getSessionId();
  const readyDocuments = demoMode
    ? DEMO_DOCUMENTS.length
    : sessionId
      ? await countReadyDocuments(sessionId)
      : 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="社内ナレッジAI"
        description="登録済みの資料をベクトル検索し、該当箇所のみを根拠に回答します。資料名・ページ番号・引用文が必ず添えられます。"
      />
      <AskPanel hasReadyDocuments={readyDocuments > 0} demoMode={demoMode} />
    </div>
  );
}
