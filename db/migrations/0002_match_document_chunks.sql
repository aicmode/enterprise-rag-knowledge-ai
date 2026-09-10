-- =============================================================================
-- Enterprise RAG Knowledge AI - 0002: vector similarity search function
-- =============================================================================
-- Retrieval runs through this single function so the "only this visitor's
-- ready documents" rule lives in exactly one place, expressed in SQL, next to
-- the index it relies on.
--
-- Security notes:
--
--  1. SECURITY INVOKER (the default), never SECURITY DEFINER. The application
--     connects with one role, so a definer function would add nothing but risk.
--
--  2. `p_session_id` is the *first* parameter and has no default, so it can
--     never be forgotten at a call site. The application passes the id it
--     resolved from the httpOnly session cookie -- it is never read from a
--     request body or query string, so a caller cannot ask for another
--     visitor's chunks by supplying a different value.
--
--  3. The `d.status = 'ready'` filter means a document that failed halfway
--     through ingestion can never be cited.
-- =============================================================================

drop function if exists match_document_chunks(uuid, vector, double precision, integer);

create or replace function match_document_chunks(
  p_session_id    uuid,
  query_embedding vector(1536),
  match_threshold double precision default 0.45,
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
  from document_chunks c
  join documents d
    on d.id = c.document_id
  where
    d.session_id = p_session_id
    and d.status = 'ready'
    and 1 - (c.embedding <=> query_embedding) >= match_threshold
  order by c.embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

comment on function match_document_chunks is
  'Cosine similarity search over one demo session''s ready documents. Returns at most match_count chunks scoring at or above match_threshold, with the page number needed for citations.';
