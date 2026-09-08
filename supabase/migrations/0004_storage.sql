-- =============================================================================
-- Enterprise RAG Knowledge AI - 0004: private Storage bucket + policies
-- =============================================================================
-- PDFs are uploaded straight from the browser to Supabase Storage, so the
-- bucket policies -- not application code -- are what actually keeps one
-- user's files away from another's.
--
-- Path convention (enforced below):
--
--     {user_id}/{document_id}/{safe_filename}
--
-- storage.foldername(name) splits the object key on '/', so element [1] is the
-- first folder. Requiring it to equal auth.uid() means a user can only ever
-- read, write or delete inside their own prefix.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,                        -- private: no public URLs, signed URLs only
  10485760,                     -- 10 MB, mirrored in the app's validation layer
  array['application/pdf']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- Object policies, scoped to the user's own top-level folder
-- -----------------------------------------------------------------------------
drop policy if exists "documents bucket: read own files" on storage.objects;
create policy "documents bucket: read own files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents bucket: upload to own folder" on storage.objects;
create policy "documents bucket: upload to own folder" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents bucket: update own files" on storage.objects;
create policy "documents bucket: update own files" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );

drop policy if exists "documents bucket: delete own files" on storage.objects;
create policy "documents bucket: delete own files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'documents'
    and (select auth.uid())::text = (storage.foldername(name))[1]
  );
