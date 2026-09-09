/**
 * Error handling policy.
 *
 * Two audiences, two messages:
 *
 *  - The **user** gets a short, actionable Japanese sentence and a stable code.
 *  - The **server log** gets the real cause, including the original exception.
 *
 * Nothing derived from an internal exception (message, stack, driver detail,
 * SQL) is ever placed in an HTTP response body. `toErrorResponse` is the single
 * choke point that enforces this.
 *
 * There is no `unauthorized` / `forbidden` pair here: this deployment is a
 * public demo with no accounts, so nothing can be refused for lack of a login.
 * A resource belonging to another demo session is reported as `not_found`,
 * which is both true from the caller's perspective and does not confirm that
 * the id exists.
 */

export type AppErrorCode =
  | 'not_found'
  | 'validation_failed'
  | 'invalid_file_type'
  | 'file_too_large'
  | 'too_many_pages'
  | 'pdf_unreadable'
  | 'pdf_no_text'
  | 'ocr_failed'
  | 'ocr_timeout'
  | 'upload_incomplete'
  | 'database_failed'
  | 'embedding_failed'
  | 'retrieval_failed'
  | 'answer_failed'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'session_unavailable'
  | 'already_processing'
  | 'internal_error';

const USER_MESSAGES: Record<AppErrorCode, string> = {
  not_found: '対象のデータが見つかりませんでした。',
  validation_failed: '入力内容を確認してください。',
  invalid_file_type: 'PDFファイルのみアップロードできます。',
  file_too_large: 'ファイルサイズは10MB以下にしてください。',
  too_many_pages: 'ページ数は100ページ以下のPDFをご利用ください。',
  pdf_unreadable: 'このPDFを読み取れませんでした。破損または保護されている可能性があります。',
  pdf_no_text: 'このPDFから読み取り可能なテキストを取得できませんでした。画像が不鮮明な場合は、より高品質なPDFでお試しください。',
  ocr_failed: 'PDFの画像文字解析に失敗しました。時間をおいて再度お試しください。',
  ocr_timeout: 'PDFの画像文字解析がタイムアウトしました。ページ数を減らして再度お試しください。',
  upload_incomplete: 'アップロードが完了していません。もう一度アップロードしてください。',
  database_failed: 'データの保存に失敗しました。もう一度お試しください。',
  embedding_failed: '資料の解析に失敗しました。もう一度お試しください。',
  retrieval_failed: '資料の検索に失敗しました。もう一度お試しください。',
  answer_failed: '回答の生成に失敗しました。もう一度お試しください。',
  rate_limited: 'このデモでは1時間あたりの質問数に上限があります。しばらく待ってからお試しください。',
  quota_exceeded: 'このデモで登録できる資料数の上限に達しました。不要な資料を削除してからお試しください。',
  session_unavailable: 'デモセッションを開始できませんでした。ページを再読み込みしてください。',
  already_processing: 'この資料は現在処理中です。完了までお待ちください。',
  internal_error: '予期しないエラーが発生しました。もう一度お試しください。',
};

const STATUS_BY_CODE: Record<AppErrorCode, number> = {
  not_found: 404,
  validation_failed: 400,
  invalid_file_type: 400,
  file_too_large: 413,
  too_many_pages: 400,
  pdf_unreadable: 422,
  pdf_no_text: 422,
  ocr_failed: 502,
  ocr_timeout: 504,
  upload_incomplete: 400,
  database_failed: 500,
  embedding_failed: 502,
  retrieval_failed: 500,
  answer_failed: 502,
  rate_limited: 429,
  quota_exceeded: 429,
  session_unavailable: 400,
  already_processing: 409,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Safe to show to the end user. */
  readonly userMessage: string;
  readonly status: number;

  constructor(code: AppErrorCode, options?: { cause?: unknown; userMessage?: string; detail?: string }) {
    // `message` is the *internal* description and stays server-side.
    super(options?.detail ?? code, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = options?.userMessage ?? USER_MESSAGES[code];
    this.status = STATUS_BY_CODE[code];
  }
}

export function userMessageFor(code: AppErrorCode): string {
  return USER_MESSAGES[code];
}

/** Narrow an unknown throwable into an AppError without losing the original. */
export function toAppError(error: unknown, fallback: AppErrorCode = 'internal_error'): AppError {
  if (error instanceof AppError) return error;
  return new AppError(fallback, {
    cause: error,
    detail: error instanceof Error ? error.message : String(error),
  });
}

export interface ErrorResponseBody {
  error: { code: AppErrorCode; message: string };
}

/**
 * Log the real cause server-side and return a body that contains only the
 * user-facing message. No stack traces, no driver messages, no SQL.
 */
export function toErrorResponse(
  error: unknown,
  context: string,
  fallback: AppErrorCode = 'internal_error',
): { status: number; body: ErrorResponseBody } {
  const appError = toAppError(error, fallback);

  // Server log only.
  console.error(`[${context}] ${appError.code}: ${appError.message}`, appError.cause ?? '');

  return {
    status: appError.status,
    body: { error: { code: appError.code, message: appError.userMessage } },
  };
}
