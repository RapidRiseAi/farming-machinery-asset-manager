-- 0207_fault_voice_storage.sql
-- Adds a private Storage bucket for fault voice notes (Scope §4.5) and extends the
-- farm-scoped storage.objects RLS to cover it. Fault media is written by trusted
-- server routes (service role, token-validated on the public QR path — ZERO anon DB
-- access), and read via server-generated signed URLs; the authenticated policy below
-- additionally lets logged-in farm users reach their own fault media directly.
--
-- Guarded so this is a no-op on a local test Postgres that has no `storage` schema —
-- there is no new business table/column/policy here, so the RLS isolation suite has
-- nothing new to assert (fault media rows live in `attachments`, already covered).

do $do$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;
  end if;

  insert into storage.buckets (id, name, public) values ('fault-voice', 'fault-voice', false)
  on conflict (id) do nothing;

  -- Re-create the farm-scoped policies with fault-voice added to the bucket set.
  execute 'drop policy if exists "farmgear objects read"   on storage.objects';
  execute 'drop policy if exists "farmgear objects insert" on storage.objects';
  execute 'drop policy if exists "farmgear objects update" on storage.objects';
  execute 'drop policy if exists "farmgear objects delete" on storage.objects';

  execute $p$
    create policy "farmgear objects read" on storage.objects for select to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects insert" on storage.objects for insert to authenticated
    with check (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects update" on storage.objects for update to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
  execute $p$
    create policy "farmgear objects delete" on storage.objects for delete to authenticated
    using (bucket_id in ('machine-photos','machine-docs','fault-photos','fault-voice','jobcard-photos')
           and app.has_farm_access(nullif((storage.foldername(name))[1], '')::uuid))
  $p$;
end $do$;
