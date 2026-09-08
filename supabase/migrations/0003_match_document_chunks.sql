-- =============================================================================
-- Enterprise RAG Knowledge AI - 0003: vector similarity search RPC
-- =============================================================================
-- Retrieval runs through this single function so the ownership rule lives in
-- exactly one place.
--
-- Two deliberate security decisions:
--
--  1. SECURITY INVOKER (the default), never SECURITY DEFINER. A definer
--     function would run as its owner and quietly bypass RLS on
--     document_chunks -- the classic way a "harmless search helper" turns into
--     a cross-tenant leak.
--
--  2. The owner filter is written out explicitly as `d.user_id = auth.uid()`
--     rather than left to RLS alone. RLS still applies underneath, but the
--     function does not *depend* on it: if a policy were ever dropped by
--     mistake, this query still cannot return another user's chunks.
--
-- There is intentionally no p_user_id parameter. Identity comes from the JWT,
-- so a caller cannot ask for someone else's documents by passing a different
-- id.
-- =============================================================================

drop function if exists public.match_document_chunks(extensions.vector, double precision, integer);

create or replace function public.match_document_chunks(
  query_embedding extensions.vector(1536),
  match_threshold double precision default 0.3,
  match_count     integer default 5
)
returns table (
  chunk_id       uuid,
  document_id    uuid,
  document_title text,
  file_name      text,
  page_number    integer,
  chunk_index    integer,
  content        text,
  similarity     double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id           as chunk_id,
    c.document_id  as document_id,
    d.title        as document_title,
    d.file_name    as file_name,
    c.page_number  as page_number,
    c.chunk_index  as chunk_index,
    c.content      as content,
    -- pgvector's <=> is cosine *distance* in [0, 2]; similarity is 1 - distance.
    1 - (c.embedding <=> query_embedding) as similarity
  from public.document_chunks c
  join public.documents d
    on d.id = c.document_id
  where
    -- Ownership, stated explicitly and not delegated to RLS.
    d.user_id = auth.uid()
    -- Only documents that finished processing can be cited.
    and d.status = 'ready'
    and 1 - (c.embedding <=> query_embedding) >= match_threshold
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

comment on function public.match_document_chunks is
  'Cosine similarity search over the calling user''s ready documents. Returns at most match_count chunks above match_threshold, with the page number needed for citations.';

revoke all on function public.match_document_chunks(extensions.vector, double precision, integer) from public;
grant execute on function public.match_document_chunks(extensions.vector, double precision, integer) to authenticated;
