import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Enterprise RAG Knowledge AI',
    template: '%s | Enterprise RAG Knowledge AI',
  },
  description: '社内資料を、根拠付きで検索できるナレッジAI。PDFを登録すると、資料名・ページ番号・引用付きでAIが回答します。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
