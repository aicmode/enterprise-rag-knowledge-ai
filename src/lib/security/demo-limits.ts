/**
 * Public-demo quota table.
 *
 * Pure data plus pure functions, deliberately free of `server-only`, database
 * and `process.env` so the numbers and the window arithmetic can be unit
 * tested without a connection.
 *
 * How the two layers fit together
 * -------------------------------
 * The app already had *session*-scoped quotas (`MAX_DOCUMENTS_PER_SESSION`,
 * `MAX_QUESTIONS_PER_SESSION_PER_HOUR`). Those stay: they are what keeps one
 * visitor's own experience sane and they are cheap to check.
 *
 * What they cannot do is bound cost, because the session is a cookie the
 * visitor controls. Clearing it, or pressing "reset", produces a fresh UUID
 * with a fresh, empty count. So every limit below is keyed on the *client*
 * fingerprint instead, which a new cookie does not change.
 *
 * Sizing
 * ------
 * The demo has to stay pleasant for a reviewer who spends fifteen minutes with
 * it, while bounding what an automated loop can spend in a day. Ranked by what
 * a unit actually costs the owner:
 *
 *  - `ocr_page` is by far the most expensive unit: one high-detail page image
 *    plus up to `OCR_MAX_OUTPUT_TOKENS` of transcription, per page. It gets the
 *    tightest budget.
 *  - `embedding_chunk` and `ask` are cheap per unit but unbounded in frequency,
 *    so they are capped on rate rather than on spend.
 *  - `upload_bytes` costs no OpenAI money at all; it protects the free-tier
 *    database from `bytea` accumulation, including from uploads that are never
 *    processed.
 */

/** Every counter the demo enforces. Values are the `bucket` column in SQL. */
export type DemoLimitName =
  | 'ask'
  | 'document_register'
  | 'document_process'
  | 'ocr_page'
  | 'embedding_chunk'
  | 'upload_bytes'
  | 'feedback'
  | 'session_reset';

export interface DemoLimit {
  /** Maximum units consumable inside one window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Japanese sentence shown when this limit is reached. No internals. */
  userMessage: string;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

export const DEMO_LIMITS: Record<DemoLimitName, DemoLimit> = {
  /**
   * One question = one embedding + one chat completion. 30/hour matches the
   * pre-existing per-session cap, so a legitimate visitor sees no change; what
   * changes is that a new cookie no longer resets it.
   */
  ask: {
    max: 30,
    windowSeconds: HOUR,
    userMessage:
      '公開デモのため、1時間あたりの質問数に上限があります。しばらく時間をおいてからお試しください。',
  },

  /**
   * Registrations per day. The per-session cap counts *live* documents, so
   * deleting one frees a slot and re-registering is unlimited; this counts the
   * act of registering and therefore closes that loop.
   */
  document_register: {
    max: 15,
    windowSeconds: DAY,
    userMessage:
      '公開デモのため、24時間あたりに登録できる資料数に上限があります。時間をおいてからお試しください。',
  },

  /**
   * Processing runs per day, retries included. Every run can re-OCR and
   * re-embed an entire document, so the "再試行" button had to stop being an
   * unmetered way to spend the owner's OpenAI budget.
   */
  document_process: {
    max: 25,
    windowSeconds: DAY,
    userMessage:
      '公開デモのため、24時間あたりの資料解析回数に上限があります。時間をおいてからお試しください。',
  },

  /**
   * Pages sent to the vision model per day -- the single most expensive unit in
   * the product. 150 pages is a scanned 100-page PDF plus a 50-page retry.
   */
  ocr_page: {
    max: 150,
    windowSeconds: DAY,
    userMessage:
      '公開デモのため、24時間あたりの画像文字解析（OCR）ページ数に上限があります。時間をおいてからお試しください。',
  },

  /** Chunks embedded per day. Generous: this is the cheap half of ingestion. */
  embedding_chunk: {
    max: 5000,
    windowSeconds: DAY,
    userMessage:
      '公開デモのため、24時間あたりの資料解析量に上限があります。時間をおいてからお試しください。',
  },

  /**
   * Staged upload bytes per day (40 MB = four maximum-size PDFs). Counted in
   * bytes rather than requests so that many small parts cannot add up to more
   * than a few full uploads, and so that documents which are never processed
   * still consume the budget they occupy in `document_upload_parts`.
   */
  upload_bytes: {
    max: 40 * 1024 * 1024,
    windowSeconds: DAY,
    userMessage:
      '公開デモのため、24時間あたりのアップロード容量に上限があります。時間をおいてからお試しください。',
  },

  /** Rating clicks. Costs no OpenAI money; this only stops write spam. */
  feedback: {
    max: 120,
    windowSeconds: HOUR,
    userMessage: '評価の送信が多すぎます。しばらく時間をおいてからお試しください。',
  },

  /**
   * Resets per hour. Reset is a legitimate feature and stays available; the cap
   * exists because each call issues a cascading DELETE, and because a loop of
   * resets is the shape an evasion attempt takes.
   */
  session_reset: {
    max: 20,
    windowSeconds: HOUR,
    userMessage: 'リセットの実行が多すぎます。しばらく時間をおいてからお試しください。',
  },
};

/**
 * Start of the fixed window containing `at`.
 *
 * Fixed windows rather than a sliding log: a sliding window needs one row per
 * request, which is exactly the unbounded-growth design the migration notes
 * warn against. A fixed window is one row per client per bucket per window and
 * can be consumed with a single atomic statement.
 *
 * The cost is the usual fixed-window edge: up to `2 * max` units can land
 * across a window boundary. That is a factor of two on a budget already chosen
 * with headroom, which is a fair trade for an O(1) row count.
 */
export function windowStartMs(windowSeconds: number, at: number = Date.now()): number {
  const windowMs = windowSeconds * 1000;
  return Math.floor(at / windowMs) * windowMs;
}

/** When a window's counter row stops being useful and may be deleted. */
export function windowExpiresAtMs(windowSeconds: number, at: number = Date.now()): number {
  return windowStartMs(windowSeconds, at) + windowSeconds * 1000;
}

/** Seconds until the current window rolls over -- the `Retry-After` value. */
export function secondsUntilWindowReset(windowSeconds: number, at: number = Date.now()): number {
  return Math.max(1, Math.ceil((windowExpiresAtMs(windowSeconds, at) - at) / 1000));
}
