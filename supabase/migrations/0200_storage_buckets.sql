-- 0200_storage_buckets.sql
-- Private Storage buckets for machine photos/docs, fault photos, and job-card photos.
-- Objects are served via signed URLs generated server-side; there are no public
-- buckets. Guarded so the same migration is a no-op on a local test Postgres that
-- has no `storage` schema.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values
      ('machine-photos', 'machine-photos', false),
      ('machine-docs',   'machine-docs',   false),
      ('fault-photos',   'fault-photos',   false),
      ('jobcard-photos', 'jobcard-photos', false)
    on conflict (id) do nothing;
  end if;
end $$;
