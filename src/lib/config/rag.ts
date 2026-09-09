/**
 * Central RAG tuning parameters.
 *
 * Every knob that affects retrieval quality lives here rather than being
 * sprinkled through the pipeline as magic numbers. `resolveRagConfig` is a pure
 * function so the parsing/clamping rules are unit-testable without touching
 * `process.env`.
 */

/**
 * Dimension of `text-embedding-3-small`.
 *
 * This MUST stay in sync with `vector(1536)` in
 * `supabase/migrations/0001_extensions_and_tables.sql`. Changing the embedding
 * model to one with a different dimension is a migration, not a config change.
 */
export const EMBEDDING_DIMENSIONS = 1536;

export const EMBEDDING_MODEL = 'text-embedding-3-small';

/** Hard limits on ingestion, mirrored in the DB constraints and Storage bucket. */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_PAGE_COUNT = 100;

/** Question input bounds, mirrored by the `questions.question` CHECK constraint. */
export const MIN_QUESTION_LENGTH = 2;
export const MAX_QUESTION_LENGTH = 1000;

/**
 * A page whose extracted text is shorter than this is treated as having no
 * usable text layer. If *every* page falls below it the PDF is almost certainly
 * a scan, which is an OCR job and therefore out of scope -- we fail loudly
 * instead of storing a document that can never answer anything.
 */
export const MIN_PAGE_TEXT_LENGTH = 20;

/** Maximum tolerated share of suspicious glyphs before native text needs OCR. */
export const MAX_GARBLED_TEXT_RATIO = 0.2;

/** Rendered-page bounds keep OCR images readable without unbounded memory/token use. */
export const OCR_RENDER_SCALE = 2;
export const OCR_MAX_IMAGE_DIMENSION = 2048;
export const OCR_MAX_OUTPUT_TOKENS = 4000;
export const OCR_TIMEOUT_MS = 60_000;

/** How many embedding inputs to send to OpenAI per request. */
export const EMBEDDING_BATCH_SIZE = 64;

export interface RagConfig {
  /** Target chunk size in characters. */
  chunkSize: number;
  /** Characters of overlap carried from one chunk into the next. */
  chunkOverlap: number;
  /** Number of chunks retrieved per question. */
  topK: number;
  /** Minimum cosine similarity for a chunk to be considered relevant. */
  similarityThreshold: number;
  /** Chat model used for answer generation. */
  chatModel: string;
  /** Vision-capable model used only for page-level OCR fallback. */
  ocrModel: string;
}

export const RAG_DEFAULTS: RagConfig = {
  chunkSize: 1000,
  chunkOverlap: 150,
  topK: 5,
  similarityThreshold: 0.3,
  chatModel: 'gpt-4o-mini',
  ocrModel: 'gpt-5-mini',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function parseIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type RawRagEnv = {
  RAG_CHUNK_SIZE?: string;
  RAG_CHUNK_OVERLAP?: string;
  RAG_TOP_K?: string;
  RAG_SIMILARITY_THRESHOLD?: string;
  OPENAI_CHAT_MODEL?: string;
  OPENAI_OCR_MODEL?: string;
};

/**
 * Build a valid config from raw environment strings.
 *
 * Invalid or missing values fall back to defaults rather than crashing the
 * app: a typo in an optional tuning variable should not take production down.
 * Values are clamped into ranges the pipeline can actually honour -- in
 * particular the overlap is forced below the chunk size, since an overlap >=
 * chunk size would make the chunker fail to advance.
 */
export function resolveRagConfig(env: RawRagEnv = {}): RagConfig {
  const chunkSize = clamp(parseIntOr(env.RAG_CHUNK_SIZE, RAG_DEFAULTS.chunkSize), 200, 4000);
  const requestedOverlap = parseIntOr(env.RAG_CHUNK_OVERLAP, RAG_DEFAULTS.chunkOverlap);
  const chunkOverlap = clamp(requestedOverlap, 0, Math.floor(chunkSize / 2));

  return {
    chunkSize,
    chunkOverlap,
    topK: clamp(parseIntOr(env.RAG_TOP_K, RAG_DEFAULTS.topK), 1, 20),
    similarityThreshold: clamp(
      parseFloatOr(env.RAG_SIMILARITY_THRESHOLD, RAG_DEFAULTS.similarityThreshold),
      0,
      1,
    ),
    chatModel: env.OPENAI_CHAT_MODEL?.trim() || RAG_DEFAULTS.chatModel,
    ocrModel: env.OPENAI_OCR_MODEL?.trim() || RAG_DEFAULTS.ocrModel,
  };
}
