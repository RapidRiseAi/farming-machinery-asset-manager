-- 20261028110200_asset_finance_documents.sql
-- The signed agreement, the lease, the policy schedule: attached to a finance agreement or
-- a contract through the existing `attachments` mechanism (0006), stored in a private
-- bucket of their own.
--
-- == Two new parent types =====================================================
-- `attachments_parent_type_ck` has been dropped and re-added with a fixed list by four
-- migrations. Re-adding it from a fixed list here would silently drop any parent type
-- another change adds in the meantime, so the list is rebuilt from the constraint AS IT
-- STANDS, plus the two this feature needs. (A later migration that re-adds it from a
-- fixed list must include 'finance_agreement' and 'asset_contract'.)
--
-- == Narrower than every other attachment =====================================
-- `attachments_sel` lets anybody with farm access read a farm's attachment rows. A
-- finance document is owner and manager material (20261028110100), so restrictive
-- policies close the two new parent types to everyone else, for reading and writing, and
-- an insert must name an agreement or contract of the same farm.
--
-- == The files ================================================================
-- Bucket `finance-docs`, private, 10 MB, images or PDF, paths `{farm_id}/{parent_id}/...`.
-- Its storage policies use the same finance check, so a mechanic who somehow learns an
-- object key still cannot sign or download it. No-op on a test Postgres without the
-- `storage` schema, like 0200/0201.

do $rebuild$
declare
  v_def  text;
  v_vals text[];
begin
  select pg_catalog.pg_get_constraintdef(c.oid)
    into v_def
    from pg_catalog.pg_constraint c
   where c.conrelid = 'public.attachments'::regclass
     and c.conname = 'attachments_parent_type_ck';
  if v_def is null then
    raise exception 'attachments_parent_type_ck is missing; review before adding finance parent types';
  end if;

  select array_agg(distinct m[1] order by m[1])
    into v_vals
    from regexp_matches(v_def, '''([a-z_]+)''', 'g') as m;
  if v_vals is null or not ('machine' = any (v_vals)) then
    raise exception 'attachments_parent_type_ck has an unexpected shape: %', v_def;
  end if;

  select array_agg(distinct v order by v)
    into v_vals
    from unnest(v_vals || array['finance_agreement', 'asset_contract']) as v;

  alter table public.attachments drop constraint attachments_parent_type_ck;
  execute format(
    'alter table public.attachments add constraint attachments_parent_type_ck check (parent_type = any (%L::text[]))',
    v_vals);
end
$rebuild$;

-- An attachment row for a finance parent must point at a live agreement or contract of
-- its own farm. SECURITY DEFINER because the caller's own SELECT would also do, but a
-- policy expression should not depend on the order RLS is evaluated in.
create or replace function app.finance_parent_ok(p_parent_type text, p_parent uuid, p_farm uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case p_parent_type
    when 'finance_agreement' then exists (
      select 1 from public.finance_agreements a
       where a.id = p_parent and a.farm_id = p_farm and a.deleted_at is null)
    when 'asset_contract' then exists (
      select 1 from public.asset_contracts c
       where c.id = p_parent and c.farm_id = p_farm and c.deleted_at is null)
    else true
  end;
$$;

revoke execute on function app.finance_parent_ok(text, uuid, uuid) from public, anon;
grant execute on function app.finance_parent_ok(text, uuid, uuid) to authenticated, service_role;

create policy attachments_finance_sel on public.attachments
  as restrictive for select to authenticated
  using (parent_type not in ('finance_agreement', 'asset_contract') or app.can_view_farm_finance(farm_id));

create policy attachments_finance_ins on public.attachments
  as restrictive for insert to authenticated
  with check (
    parent_type not in ('finance_agreement', 'asset_contract')
    or (app.can_view_farm_finance(farm_id) and app.finance_parent_ok(parent_type, parent_id, farm_id))
  );

create policy attachments_finance_upd on public.attachments
  as restrictive for update to authenticated
  using (parent_type not in ('finance_agreement', 'asset_contract') or app.can_view_farm_finance(farm_id))
  with check (parent_type not in ('finance_agreement', 'asset_contract') or app.can_view_farm_finance(farm_id));

create policy attachments_finance_del on public.attachments
  as restrictive for delete to authenticated
  using (parent_type not in ('finance_agreement', 'asset_contract') or app.can_view_farm_finance(farm_id));

-- == Storage ==================================================================
-- The farm an object belongs to, from the first segment of its key. A key that is not a
-- uuid there belongs to no farm, which the finance check answers with false.
create or replace function app.finance_storage_farm(p_name text)
returns uuid
language plpgsql
immutable
set search_path = pg_temp
as $$
begin
  return nullif(split_part(p_name, '/', 1), '')::uuid;
exception when invalid_text_representation then
  return null;
end
$$;

revoke execute on function app.finance_storage_farm(text) from public, anon;
grant execute on function app.finance_storage_farm(text) to authenticated, service_role;

do $storage$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('finance-docs', 'finance-docs', false, 10485760, array['image/*', 'application/pdf'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists "finance docs read" on storage.objects';
  execute 'drop policy if exists "finance docs insert" on storage.objects';
  execute 'drop policy if exists "finance docs update" on storage.objects';
  execute 'drop policy if exists "finance docs delete" on storage.objects';

  execute $p$
    create policy "finance docs read" on storage.objects for select to authenticated
    using (bucket_id = 'finance-docs'
           and app.can_view_farm_finance(app.finance_storage_farm(name)))
  $p$;
  execute $p$
    create policy "finance docs insert" on storage.objects for insert to authenticated
    with check (bucket_id = 'finance-docs'
                and app.can_view_farm_finance(app.finance_storage_farm(name)))
  $p$;
  execute $p$
    create policy "finance docs update" on storage.objects for update to authenticated
    using (bucket_id = 'finance-docs'
           and app.can_view_farm_finance(app.finance_storage_farm(name)))
    with check (bucket_id = 'finance-docs'
                and app.can_view_farm_finance(app.finance_storage_farm(name)))
  $p$;
  execute $p$
    create policy "finance docs delete" on storage.objects for delete to authenticated
    using (bucket_id = 'finance-docs'
           and app.can_view_farm_finance(app.finance_storage_farm(name)))
  $p$;
end
$storage$;
