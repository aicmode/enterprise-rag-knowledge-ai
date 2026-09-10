-- =============================================================================
-- Enterprise RAG Knowledge AI - 0001: extensions, core tables, indexes
-- =============================================================================
-- Target: any PostgreSQL 15+ with the `vector` extension available.
-- Verified against Neon (free tier) and the pgvector/pgvector Docker image.
--
-- There is no authentication in this deployment: it is a public portfolio demo.
-- Isolation between visitors is provided by an anonymous *demo session* id,
-- carried in an httpOnly cookie and written into every row. Every query in
-- `src/lib/db/` takes that id as a bound parameter, so one visitor's uploads
-- and history are never visible to another even though nobody signs in.
-- =============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- updated_at trigger helper
-- -----------------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- documents: one row per uploaded PDF
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_status') then
    create type document_status as enum ('uploaded', 'processing', 'ready', 'failed');
  end if;
end
$$;

create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  -- Anonymous demo session that owns this row. Server-resolved from a cookie;
  -- never taken from a request body.
  session_id    uuid not null,
  title         text not null check (char_length(title) between 1 and 300),
  file_name     text not null check (char_length(file_name) between 1 and 300),
  file_size     bigint not null check (file_size > 0 and file_size <= 10485760),
  content_type  text not null default 'application/pdf',
  page_count    integer check (page_count is null or (page_count > 0 and page_count <= 100)),
  status        document_status not null default 'uploaded',
  error_message text,
  created_at    timestamptz not null default timezone('utc', now()),
  updated_at    timestamptz not null default timezone('utc', now())
);

create index if not exists documents_session_created_at_idx
  on documents (session_id, created_at desc);
create index if not exists documents_session_status_idx
  on documents (session_id, status);

drop trigger if exists documents_set_updated_at on documents;
create trigger documents_set_updated_at
  before update on documents
  for each row execute function set_updated_at();

-- -----------------------------------------------------------------------------
-- document_upload_parts: staging area for the uploaded PDF bytes
-- -----------------------------------------------------------------------------
-- Vercel caps a serverless function request body at 4.5 MB, but the product
-- supports 10 MB PDFs. The browser therefore slices the file and POSTs each
-- part; the parts land here and are concatenated once, at processing time.
--
-- These rows are *staging*, not storage. They are deleted as soon as the
-- document reaches `ready`, so a healthy database holds no PDF bytes at all --
-- which is why this project needs no object-storage service. Bytes are kept
-- only while a document is `uploaded`/`processing`/`failed`, so the "retry"
-- button can re-run ingestion without a re-upload.
create table if not exists document_upload_parts (
  document_id uuid not null references documents (id) on delete cascade,
  part_index  integer not null check (part_index >= 0),
  bytes       bytea not null,
  byte_length integer not null check (byte_length > 0),
  created_at  timestamptz not null default timezone('utc', now()),
  primary key (document_id, part_index)
);

-- -----------------------------------------------------------------------------
-- document_chunks: page-aware chunks + embeddings
-- -----------------------------------------------------------------------------
-- page_number is stored per chunk (never derived later) because it is the whole
-- basis of a trustworthy citation. Chunks never span a page boundary, so
-- "which page did this sentence come from" always has exactly one answer.
create table if not exists document_chunks (
  id             uuid primary key default gen_random_uuid(),
  document_id    uuid not null references documents (id) on delete cascade,
  page_number    integer not null check (page_number >= 1),
  chunk_index    integer not null check (chunk_index >= 0),
  content        text not null,
  content_length integer not null check (content_length > 0),
  -- 1536 == text-embedding-3-small default dimension. Keep in sync with
  -- EMBEDDING_DIMENSIONS in src/lib/config/rag.ts.
  embedding      vector(1536) not null,
  created_at     timestamptz not null default timezone('utc', now()),
  -- Makes re-processing idempotent: a retry that re-inserts the same chunk
  -- cannot silently duplicate retrieval candidates.
  constraint document_chunks_unique_position unique (document_id, page_number, chunk_index)
);

create index if not exists document_chunks_document_id_idx
  on document_chunks (document_id);
create index if not exists document_chunks_document_page_idx
  on document_chunks (document_id, page_number);

-- HNSW over cosine distance. Cosine matches how OpenAI embeddings are compared,
-- and HNSW gives good recall/latency without needing a trained IVF list count.
create index if not exists document_chunks_embedding_hnsw_idx
  on document_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- -----------------------------------------------------------------------------
-- questions: one row per answered question (also the history feed)
-- -----------------------------------------------------------------------------
create table if not exists questions (
  id               uuid primary key default gen_random_uuid(),
  session_id       uuid not null,
  question         text not null check (char_length(question) between 1 and 1000),
  answer           text not null,
  -- Retrieval result snapshot (title / page / excerpt / similarity). Denormalised
  -- on purpose: a citation must stay readable even after the source document is
  -- deleted, and it records what the model actually saw at answer time.
  sources          jsonb not null default '[]'::jsonb,
  response_time_ms integer check (response_time_ms is null or response_time_ms >= 0),
  model            text not null,
  created_at       timestamptz not null default timezone('utc', now())
);

create index if not exists questions_session_created_at_idx
  on questions (session_id, created_at desc);

-- -----------------------------------------------------------------------------
-- answer_feedback: helpful / not helpful per question
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'feedback_rating') then
    create type feedback_rating as enum ('helpful', 'not_helpful');
  end if;
end
$$;

create table if not exists answer_feedback (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions (id) on delete cascade,
  session_id  uuid not null,
  rating      feedback_rating not null,
  comment     text check (comment is null or char_length(comment) <= 2000),
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now()),
  -- One rating per session per answer; re-rating is an UPSERT, not a new row.
  constraint answer_feedback_unique_vote unique (question_id, session_id)
);

create index if not exists answer_feedback_session_idx
  on answer_feedback (session_id);

drop trigger if exists answer_feedback_set_updated_at on answer_feedback;
create trigger answer_feedback_set_updated_at
  before update on answer_feedback
  for each row execute function set_updated_at();
