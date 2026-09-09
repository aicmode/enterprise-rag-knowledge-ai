-- =============================================================================
-- Enterprise RAG Knowledge AI - 0005: tighten match_document_chunks grants
-- =============================================================================
-- 0003 ends with:
--
--     revoke all on function public.match_document_chunks(...) from public;
--     grant execute on function public.match_document_chunks(...) to authenticated;
--
-- which reads as "only authenticated may execute this", but does not actually
-- achieve that on Supabase. Supabase ships an ALTER DEFAULT PRIVILEGES rule
-- that grants EXECUTE on every new function in `public` to anon, authenticated
-- and service_role. Those are grants to the *anon role*, not to PUBLIC, so
-- `revoke ... from public` leaves them untouched -- verified against a real
-- instance, where pg_proc.proacl still showed `anon=X/postgres` after a clean
-- migration run.
--
-- The function was never exploitable: it is SECURITY INVOKER and filters on
-- `d.user_id = auth.uid()`, which is NULL for anon, and RLS on
-- document_chunks has no policy for the anon role either. An anonymous call
-- therefore returns zero rows rather than leaking anything.
--
-- This migration simply makes the privilege match the stated intent, so the
-- retrieval entry point is not reachable at all without a session.
-- =============================================================================

revoke all on function public.match_document_chunks(extensions.vector, double precision, integer)
  from anon;

-- authenticated keeps EXECUTE (granted in 0003); service_role is left as-is so
-- that operational tooling can still introspect the function.
