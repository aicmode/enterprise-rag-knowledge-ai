'use client';

import {
  AlertTriangle,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState, type DragEvent } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { MAX_FILE_SIZE_BYTES, MAX_PAGE_COUNT } from '@/lib/config/rag';
import { cn } from '@/lib/cn';
import { formatBytes, formatDateTime } from '@/lib/format';
import type { DocumentRow } from '@/lib/types';
import { UploadError, uploadPdfWithProgress } from '@/lib/upload';
import { deriveTitle, validatePdfFile } from '@/lib/validation/document';

type UploadPhase = 'idle' | 'registering' | 'uploading' | 'processing';

/**
 * The documents screen.
 *
 * Owns the whole upload lifecycle:
 *
 *   validate -> register row -> upload the PDF in parts -> process
 *
 * Registration comes before the bytes so the per-session quota is checked
 * before a 10 MB transfer starts, and so the upload parts have a row to attach
 * to.
 *
 * Each stage is reported separately, because "uploading" and "analysing" have
 * very different durations and a single spinner for both makes a 100-page PDF
 * look hung.
 */
export function DocumentManager({ initialDocuments }: { initialDocuments: DocumentRow[] }) {
  const router = useRouter();

  // The list is rendered straight from the server prop rather than copied into
  // state. Mirroring it would mean two sources of truth for the same data and a
  // sync effect to keep them together; instead every mutation ends with
  // `router.refresh()`, and the Server Component re-renders with fresh rows.
  const documents = initialDocuments;

  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<DocumentRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const isBusy = phase !== 'idle';

  const refresh = useCallback(() => {
    router.refresh();
  }, [router]);

  async function handleFile(file: File) {
    if (isBusy) return;

    setError(null);
    setNotice(null);
    setProgress(0);

    // Client-side validation for instant feedback. The server re-validates
    // everything; this is purely a UX shortcut.
    const validation = validatePdfFile({ name: file.name, size: file.size, type: file.type });
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    // The document id is generated here so the upload parts can be addressed
    // before the server has replied with anything.
    const documentId = crypto.randomUUID();

    try {
      setPhase('registering');
      const registerResponse = await fetch('/api/documents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentId,
          title: deriveTitle(file.name),
          fileName: file.name,
          fileSize: file.size,
        }),
      });

      if (!registerResponse.ok) {
        const body = await registerResponse.json().catch(() => null);
        setError(body?.error?.message ?? '資料の登録に失敗しました。もう一度お試しください。');
        return;
      }

      setPhase('uploading');
      await uploadPdfWithProgress({
        documentId,
        file,
        onProgress: (p) => setProgress(p.percent),
      });

      setPhase('processing');
      refresh();

      const processResponse = await fetch('/api/documents/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });

      if (!processResponse.ok) {
        const body = await processResponse.json().catch(() => null);
        // The document row exists and is marked `failed` server-side, so the
        // list will show the failure with a retry button.
        setError(body?.error?.message ?? '資料の解析に失敗しました。もう一度お試しください。');
        return;
      }

      setNotice(`「${deriveTitle(file.name)}」を登録しました。質問できる状態です。`);
    } catch (uploadError) {
      setError(
        uploadError instanceof UploadError && uploadError.status
          ? uploadError.message
          : 'アップロードに失敗しました。ネットワーク環境を確認してもう一度お試しください。',
      );
    } finally {
      setPhase('idle');
      setProgress(0);
      refresh();
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleRetry(document: DocumentRow) {
    if (busyId) return;
    setBusyId(document.id);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/documents/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: document.id }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? '再解析に失敗しました。');
      } else {
        setNotice(`「${document.title}」の再解析が完了しました。`);
      }
    } catch {
      setError('再解析に失敗しました。ネットワーク環境を確認してください。');
    } finally {
      setBusyId(null);
      refresh();
    }
  }

  async function handleDelete(document: DocumentRow) {
    setBusyId(document.id);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`/api/documents/${document.id}`, { method: 'DELETE' });

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? '資料の削除に失敗しました。');
      } else {
        setNotice(`「${document.title}」を削除しました。`);
      }
    } catch {
      setError('資料の削除に失敗しました。ネットワーク環境を確認してください。');
    } finally {
      setBusyId(null);
      setPendingDelete(null);
      refresh();
    }
  }

  // --- drag & drop -----------------------------------------------------------
  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current -= 1;
    // Counting enter/leave avoids the flicker caused by dragging over child
    // elements, each of which fires its own leave event.
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);

    const file = event.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  const phaseLabel: Record<Exclude<UploadPhase, 'idle'>, string> = {
    registering: '登録中...',
    uploading: `アップロード中... ${progress}%`,
    processing: 'テキスト解析・必要ページのOCR・ベクトル化中...',
  };

  return (
    <div className="space-y-6">
      {/* ---------------- Upload ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle>PDFをアップロード</CardTitle>
        </CardHeader>
        <CardBody>
          <div
            onDragEnter={onDragEnter}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              'rounded-xl border-2 border-dashed px-5 py-9 text-center transition-colors',
              isDragging ? 'border-brand-500 bg-brand-50' : 'border-border-strong bg-surface-muted/50',
              isBusy && 'opacity-70',
            )}
          >
            {isBusy ? (
              <div className="mx-auto max-w-sm">
                <Loader2 className="mx-auto size-8 animate-spin text-brand-600" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-ink" aria-live="polite">
                  {phaseLabel[phase]}
                </p>

                <div
                  className="mt-3 h-2 w-full overflow-hidden rounded-full bg-border-subtle"
                  role="progressbar"
                  aria-valuenow={phase === 'uploading' ? progress : undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="アップロード進捗"
                >
                  <div
                    className={cn(
                      'h-full rounded-full bg-brand-600 transition-[width] duration-200',
                      phase !== 'uploading' && 'animate-pulse',
                    )}
                    style={{ width: phase === 'uploading' ? `${progress}%` : '100%' }}
                  />
                </div>

                <p className="mt-2 text-xs text-ink-subtle">
                  解析には資料の分量に応じて時間がかかります。画面を閉じずにお待ちください。
                </p>
              </div>
            ) : (
              <>
                <UploadCloud className="mx-auto size-8 text-ink-faint" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-ink">
                  PDFをここにドラッグ＆ドロップ
                </p>
                <p className="mt-1 text-sm text-ink-subtle">または</p>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => fileInputRef.current?.click()}
                >
                  ファイルを選択
                </Button>
                <p className="mt-4 text-xs text-ink-subtle">
                  PDF形式 / 最大 {formatBytes(MAX_FILE_SIZE_BYTES)} / 最大 {MAX_PAGE_COUNT} ページ
                </p>
                <p className="mt-1 text-xs text-ink-faint">
                  スキャンPDFや日本語・英語混在PDFも自動解析します
                </p>
              </>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
          </div>

          {error ? (
            <Alert tone="error" className="mt-4">
              {error}
            </Alert>
          ) : null}
          {notice ? (
            <Alert tone="success" className="mt-4">
              {notice}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      {/* ---------------- List ---------------- */}
      <Card>
        <CardHeader className="flex items-center justify-between gap-3">
          <CardTitle>登録済みの資料</CardTitle>
          <span className="shrink-0 text-sm text-ink-subtle">{documents.length}件</span>
        </CardHeader>

        {documents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="まだ資料が登録されていません"
            description="社内マニュアルや規程のPDFをアップロードすると、テキスト解析と必要ページのOCRが行われ、根拠付きで検索できるようになります。"
            action={
              <Button type="button" onClick={() => fileInputRef.current?.click()}>
                <UploadCloud className="size-4" aria-hidden="true" />
                最初のPDFをアップロード
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {documents.map((document) => (
              <li key={document.id} className="px-5 py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted">
                      <FileText className="size-4 text-ink-subtle" aria-hidden="true" />
                    </div>

                    <div className="min-w-0">
                      <p className="break-anywhere text-sm font-medium text-ink">
                        {document.title}
                      </p>
                      <p className="break-anywhere mt-0.5 text-xs text-ink-subtle">
                        {document.file_name}
                      </p>
                      <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                        <span>{formatBytes(document.file_size)}</span>
                        {document.page_count ? <span>{document.page_count}ページ</span> : null}
                        <span>{formatDateTime(document.created_at)}</span>
                      </p>

                      {document.status === 'failed' && document.error_message ? (
                        <p className="break-anywhere mt-2 flex items-start gap-1.5 text-xs text-danger-700">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                          {document.error_message}
                        </p>
                      ) : null}

                      {document.status === 'ready' && document.error_message ? (
                        <p className="break-anywhere mt-2 flex items-start gap-1.5 text-xs text-warning-700">
                          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                          {document.error_message}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 sm:pl-3">
                    <StatusBadge status={document.status} />

                    {document.status === 'failed' ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busyId === document.id}
                        onClick={() => void handleRetry(document)}
                      >
                        <RefreshCw
                          className={cn('size-3.5', busyId === document.id && 'animate-spin')}
                          aria-hidden="true"
                        />
                        再試行
                      </Button>
                    ) : null}

                    <button
                      type="button"
                      aria-label={`${document.title} を削除`}
                      disabled={busyId === document.id || document.status === 'processing'}
                      onClick={() => setPendingDelete(document)}
                      className="flex size-8 items-center justify-center rounded-lg text-ink-faint transition-colors hover:bg-danger-50 hover:text-danger-600 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ---------------- Delete confirmation ---------------- */}
      {pendingDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="キャンセル"
            onClick={() => setPendingDelete(null)}
            className="absolute inset-0 bg-ink/40"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            className="relative w-full max-w-md rounded-xl border border-border-subtle bg-surface p-6 shadow-xl"
          >
            <h2 id="delete-title" className="text-base font-semibold text-ink">
              資料を削除しますか？
            </h2>
            <p className="break-anywhere mt-2 text-sm leading-relaxed text-ink-subtle">
              「{pendingDelete.title}」と、その解析済みデータ（チャンク・Embedding）およびPDFファイルを完全に削除します。この操作は取り消せません。
            </p>

            <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="secondary"
                onClick={() => setPendingDelete(null)}
                disabled={busyId === pendingDelete.id}
              >
                キャンセル
              </Button>
              <Button
                type="button"
                variant="danger"
                disabled={busyId === pendingDelete.id}
                onClick={() => void handleDelete(pendingDelete)}
              >
                {busyId === pendingDelete.id ? (
                  <>
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    削除中...
                  </>
                ) : (
                  <>
                    <Trash2 className="size-4" aria-hidden="true" />
                    削除する
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
