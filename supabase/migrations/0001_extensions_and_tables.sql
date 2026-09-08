-- =============================================================================
-- Enterprise RAG Knowledge AI - 0001: extensions, core tables, indexes
-- =============================================================================
-- Everything the application depends on lives in migrations so a fresh Supabase
-- project can be reproduced with `supabase db push` alone. Nothing here relies
-- on manual clicking in the Supabase Dashboard.
-- =============================================================================

-- pgvector powers the similarity search. It ships with Supabase but must be
-- explicitly enabled; Supabase convention is to install extensions outside the
-- public schema.
create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- updated_at trigger helper
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- profiles: 1:1 with auth.users
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default timezone('utc', now()),
  updated_at   timestamptz not null default timezone('utc', now())
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- A profile row is created automatically on signup so the app never has to
-- branch on "profile might not exist yet".
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- -----------------------------------------------------------------------------
-- documents: one row per uploaded PDF
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_status') then
    create type public.document_status as enum ('uploaded', 'processing', 'ready', 'failed');
  end if;
end
$$;

create table if not exists public.documents (
  id            uuid primary key default extensions.gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 300),
  file_name     text not null check (char_length(file_name) between 1 and 300),
  storage_path  text not null,
  file_size     bigint not null check (file_size > 0 and file_size <= 10485760),
  page_count    integer check (page_count is null or (page_count > 0 and page_count <= 100)),
  status        public.document_status not null default 'uploaded',
  error_message text,
  created_at    timestamptz not null default timezone('utc', now()),
  updated_at    timestamptz not null default timezone('utc', now()),
  -- The storage object is globally unique; this also stops a double-insert from
  -- registering the same uploaded file twice.
  constraint documents_storage_path_key unique (storage_path)
);

create index if not exists documents_user_id_created_at_idx
  on public.documents (user_id, created_at desc);
create index if not exists documents_user_id_status_idx
  on public.documents (user_id, status);

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- document_chunks: page-aware chunks + embeddings
-- -----------------------------------------------------------------------------
-- page_number is stored per chunk (never derived later) because it is the whole
-- basis of a trustworthy citation. Chunks never span a page boundary, so
-- "which page did this sentence come from" always has exactly one answer.
create table if not exists public.document_chunks (
  id             uuid primary key default extensions.gen_random_uuid(),
  document_id    uuid not null references public.documents (id) on delete cascade,
  page_number    integer not null check (page_number >= 1),
  chunk_index    integer not null check (chunk_index >= 0),
  content        text not null,
  content_length integer not null check (content_length > 0),
  -- 1536 == text-embedding-3-small default dimension. Keep in sync with
  -- EMBEDDING_DIMENSIONS in src/lib/config/rag.ts.
  embedding      extensions.vector(1536) not null,
  created_at     timestamptz not null default timezone('utc', now()),
  -- Makes re-processing idempotent: a retry that re-inserts the same chunk
  -- cannot silently duplicate retrieval candidates.
  constraint document_chunks_unique_position unique (document_id, page_number, chunk_index)
);

create index if not exists document_chunks_document_id_idx
  on public.document_chunks (document_id);
create index if not exists document_chunks_document_page_idx
  on public.document_chunks (document_id, page_number);

-- HNSW over cosine distance. Cosine matches how OpenAI embeddings are compared,
-- and HNSW gives good recall/latency without needing a trained IVF list count.
create index if not exists document_chunks_embedding_hnsw_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- -----------------------------------------------------------------------------
-- questions: one row per answered question (also the history feed)
-- -----------------------------------------------------------------------------
create table if not exists public.questions (
  id               uuid primary key default extensions.gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
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

create index if not exists questions_user_id_created_at_idx
  on public.questions (user_id, created_at desc);

-- -----------------------------------------------------------------------------
-- answer_feedback: helpful / not helpful per question
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'feedback_rating') then
    create type public.feedback_rating as enum ('helpful', 'not_helpful');
  end if;
end
$$;

create table if not exists public.answer_feedback (
  id          uuid primary key default extensions.gen_random_uuid(),
  question_id uuid not null references public.questions (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  rating      public.feedback_rating not null,
  comment     text check (comment is null or char_length(comment) <= 2000),
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now()),
  -- One rating per user per answer; re-rating is an UPSERT, not a new row.
  constraint answer_feedback_unique_vote unique (question_id, user_id)
);

create index if not exists answer_feedback_user_id_idx
  on public.answer_feedback (user_id);

create trigger answer_feedback_set_updated_at
  before update on public.answer_feedback
  for each row execute function public.set_updated_at();
