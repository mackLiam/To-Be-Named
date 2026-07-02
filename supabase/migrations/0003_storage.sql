-- 0003_storage.sql
-- Storage buckets and storage.objects RLS for meshes and STLs.
--
-- Both buckets are private (public = false). Every read in the app goes
-- through a short-lived signed URL issued server-side, never a public
-- bucket URL (DESIGN.md sections 5, 9.1). The RLS policies below control
-- who is allowed to create/list rows in storage.objects directly (e.g. via
-- the Supabase client SDK); signed URL issuance is a separate, explicit
-- server-side step regardless of these policies.

-- ---------------------------------------------------------------------------
-- Buckets
-- ---------------------------------------------------------------------------

-- meshes: raw scan uploads (OBJ/USDZ, optionally Draco/zip-compressed).
-- allowed_mime_types is left NULL (no restriction) deliberately: 'model/obj'
-- and 'model/vnd.usdz+zip' are not consistently registered/sent by capture
-- tools and browsers, so an allow-list here would false-reject legitimate
-- uploads or need constant maintenance. Tradeoff: this removes an easy
-- first line of defense, so real validation (magic-byte sniffing, vertex
-- count caps, sandboxed parsing per DESIGN 9.6) happens in the worker, not
-- at the storage layer. Size is still capped here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('meshes', 'meshes', false, 104857600, null)
on conflict (id) do nothing;

-- stls: worker-generated print files. The worker controls content end to
-- end, so a permissive-but-documented mime list is acceptable here: no
-- registered STL mime type exists, and generators/clients disagree between
-- 'model/stl' and 'application/octet-stream'. Accept both rather than
-- reject the worker's own output.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stls', 'stls', false, 52428800, array['model/stl', 'application/octet-stream'])
on conflict (id) do nothing;

comment on table storage.buckets is
  'meshes: user-uploaded raw scans, path-scoped RLS below. stls: worker-generated print files, service-role only.';

-- ---------------------------------------------------------------------------
-- storage.objects policies
--
-- Supabase enables RLS on storage.objects by default; we only add policies.
-- Convention: object name (path) is always "<user_id>/<...>", so a simple
-- prefix match on auth.uid() enforces per-user isolation without a lookup.
-- ---------------------------------------------------------------------------

-- meshes: users may upload into their own prefix only.
create policy "meshes: insert own prefix"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'meshes'
  and name like auth.uid()::text || '/%'
);

-- meshes: users may read (and thus request a signed URL for) their own
-- objects only.
create policy "meshes: select own prefix"
on storage.objects for select
to authenticated
using (
  bucket_id = 'meshes'
  and name like auth.uid()::text || '/%'
);

-- No update/delete policy for meshes: users cannot rewrite or remove a
-- mesh once uploaded (it's evidence for re-running the pipeline without a
-- rescan). Note: this means the "delete my scans" feature promised in
-- DESIGN 9.3 needs its own server-side path (an Edge Function or admin API
-- using the service role) rather than a client-side storage delete - not
-- implemented yet, tracked in supabase/README.md TODOs.

-- stls: no policies at all. Only the worker (service role, which bypasses
-- RLS) ever writes or reads STL objects directly; end users only ever get a
-- signed URL issued by a server-side route, never direct table access.

-- No policies at all for anon on either bucket: both buckets are private
-- and unauthenticated access is never valid.
