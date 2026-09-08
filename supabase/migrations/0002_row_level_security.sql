-- =============================================================================
-- Enterprise RAG Knowledge AI - 0002: Row Level Security
-- =============================================================================
-- RLS is the last line of defence. The application also filters by user_id in
-- every query, but RLS means a bug in application code cannot turn into a data
-- leak across tenants.
--
-- Note on `(select auth.uid())`: wrapping the call in a scalar subquery lets
-- Postgres evaluate it once per statement instead of once per row, which
-- matters a lot on document_chunks.
-- =============================================================================

alter table public.profiles         enable row level security;
alter table public.documents        enable row level security;
alter table public.document_chunks  enable row level security;
alter table public.questions        enable row level security;
alter table public.answer_feedback  enable row level security;

-- -----------------------------------------------------------------------------
-- profiles: readable and writable only by the owner
-- -----------------------------------------------------------------------------
drop policy if exists "profiles: select own" on public.profiles;
create policy "profiles: select own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- -----------------------------------------------------------------------------
-- documents: owner-only, all verbs
-- -----------------------------------------------------------------------------
drop policy if exists "documents: select own" on public.documents;
create policy "documents: select own" on public.documents
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "documents: insert own" on public.documents;
create policy "documents: insert own" on public.documents
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "documents: update own" on public.documents;
create policy "documents: update own" on public.documents
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "documents: delete own" on public.documents;
create policy "documents: delete own" on public.documents
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- document_chunks: ownership is inherited from the parent document
-- -----------------------------------------------------------------------------
-- Chunks have no user_id of their own; access is derived from documents so the
-- ownership rule can never drift out of sync between the two tables.
drop policy if exists "document_chunks: select via owned document" on public.document_chunks;
create policy "document_chunks: select via owned document" on public.document_chunks
  for select to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_chunks.document_id
        and d.user_id = (select auth.uid())
    )
  );

drop policy if exists "document_chunks: insert via owned document" on public.document_chunks;
create policy "document_chunks: insert via owned document" on public.document_chunks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.documents d
      where d.id = document_chunks.document_id
        and d.user_id = (select auth.uid())
    )
  );

drop policy if exists "document_chunks: delete via owned document" on public.document_chunks;
create policy "document_chunks: delete via owned document" on public.document_chunks
  for delete to authenticated
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_chunks.document_id
        and d.user_id = (select auth.uid())
    )
  );

-- -----------------------------------------------------------------------------
-- questions: owner-only history
-- -----------------------------------------------------------------------------
drop policy if exists "questions: select own" on public.questions;
create policy "questions: select own" on public.questions
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "questions: insert own" on public.questions;
create policy "questions: insert own" on public.questions
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "questions: delete own" on public.questions;
create policy "questions: delete own" on public.questions
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- -----------------------------------------------------------------------------
-- answer_feedback: owner-only, and only on the user's own question
-- -----------------------------------------------------------------------------
drop policy if exists "answer_feedback: select own" on public.answer_feedback;
create policy "answer_feedback: select own" on public.answer_feedback
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "answer_feedback: insert own" on public.answer_feedback;
create policy "answer_feedback: insert own" on public.answer_feedback
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.questions q
      where q.id = answer_feedback.question_id
        and q.user_id = (select auth.uid())
    )
  );

drop policy if exists "answer_feedback: update own" on public.answer_feedback;
create policy "answer_feedback: update own" on public.answer_feedback
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "answer_feedback: delete own" on public.answer_feedback;
create policy "answer_feedback: delete own" on public.answer_feedback
  for delete to authenticated
  using ((select auth.uid()) = user_id);
