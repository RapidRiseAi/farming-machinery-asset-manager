-- 0291_checklist_storage.sql
-- Adds a private Storage bucket for checklist photos (feature F11, provider-spec §7)
-- and extends the farm-scoped storage.objects RLS to cover it. Checklist photos are
-- written by the RLS-bound server action that saves a checklist instance (the
-- owner/manager/crew member already has farm access), under `{farm_id}/{instance_id}/…`
-- so the same farm-scoped policy governs reads; they are served via server-generated
-- signed URLs.
--
-- Guarded so this is a no-op on a local test Postgres that has no `storage` schema —
-- there is no new business table/column/policy here (checklist photo rows live in
-- `attachments`, already covered), so the RLS isolation suite has nothing new to assert.

do $do$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;
  end if;

  insert into storage.buckets (id, name, public) values ('checklist-photos', 'checklist-photos', false)
  on conflict (id) do nothing;

  -- Re-create the farm-scoped policies with checklist-photos added to the bucket set.
  execute 'drop policy if exists "farmgear objects read"   on storage.objects';
  execute 'drop policy if exists "farmgear objects insert" on storage.objects';
  execute 'drop policy if exists "farmgear objects update" on storage.objects';
  execute 'drop policy if exists "farmgear objects delete" on storage.objects';

  execute $p$
    create policy "farmgear objects read" on storage.objects for select to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects insert" on storage.objects for insert to authenticated
    with check (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects update" on storage.objects for update to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects delete" on storage.objects for delete to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos','checklist-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
end $do$;
