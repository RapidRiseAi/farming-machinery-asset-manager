-- Isolation across the whole schema and the final build's new tables (A6, BRIEF section 20;
-- scenarios 37 and 38). Part 1 reads the catalogue: no table without row security, nothing granted
-- to anon, and every read policy routed through an access helper (or listed here with why it is
-- open). Part 2 seeds rows into tables this build added and reads them as each kind of person:
-- owner, operator, an account switched off, a membership that ended, a manager of another site of
-- the same customer, a linked partner, Rapid Rise without and with the second factor, another
-- business. Part 3: a switched-off person's existing session cannot use the new write functions.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ISOLATION FAIL: %', why; end if; end $$;
create function pg_temp.raises(p_sql text, p_like text) returns boolean language plpgsql as $$
begin execute p_sql; return false; exception when others then return sqlerrm like p_like; end $$;
create function pg_temp.login(u text, aal text default 'aal1') returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'aal', aal)::text, true)
$$;

-- == Part 1: the catalogue ======================================================================
do $$ declare v text; begin
  select string_agg(c.relname, ', ') into v from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  perform pg_temp.assert(v is null, format('[1] tables without row security: %s', v));

  select string_agg(distinct table_name, ', ') into v from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'PUBLIC');
  perform pg_temp.assert(v is null, format('[1] tables granted to anon or PUBLIC: %s', v));

  select string_agg(tablename || '.' || policyname, ', ') into v from pg_policies
   where schemaname = 'public' and (roles @> '{anon}' or roles @> '{public}');
  perform pg_temp.assert(v is null, format('[1] policies for anon or PUBLIC: %s', v));

  -- Every permissive read policy names an access helper, or is open on purpose (listed with why).
  select string_agg(tablename || '.' || policyname, ', ') into v from pg_policies
   where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
     and coalesce(qual, '') !~ '(has_farm_access|accessible_farm_ids|effective_farm_role|is_rr_admin|is_rr_support|auth\.uid|chat_|import_manager|asset_field|manual_|workshop|farm_member|can_view|ai_member|session_is_rapid_rise|user_workshop_id|is_farm|row_visible_to_role|asset_profile_manager|driving_access|driver_member|trips_manager|partner_doc_visible)'
     and (tablename, policyname) not in (
       -- published prices and the supplier's own invoice details: the same for every customer
       ('billing_price_versions', 'billing_price_versions_sel'),
       ('billing_service_catalogue', 'billing_service_catalogue_offer_sel'),
       ('billing_settings', 'billing_settings_sel'),
       -- which features exist and whether each is released: names only, no business data
       ('feature_flags', 'feature_flags_sel'),
       -- delegates to driving_sessions, whose own policy applies to the caller
       ('driving_events', 'driving_events_read'));
  perform pg_temp.assert(v is null, format('[1] read policies that name no access helper: %s', v));

  -- Callable functions that run as their owner have a pinned search_path (scripts/security_inventory.mjs reads them all).
  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosecdef
     and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE'))
     and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  perform pg_temp.assert(v is null, format('[1] callable owner-run functions without a pinned search_path: %s', v));

  select string_agg(p.proname, ', ') into v from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app') and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');
  perform pg_temp.assert(v is null, format('[1] owner-run functions anon can call: %s', v));
end $$;

-- == Part 2: people against the new tables ======================================================
insert into public.farms (id, name, plan, status) values
  ('ad000000-0000-4000-9000-000000000001', 'Site one', 'complete', 'active'),
  ('ad000000-0000-4000-9000-000000000002', 'Site two', 'complete', 'active'),
  ('ad000000-0000-4000-9000-000000000003', 'Another business', 'complete', 'active');
-- Site two is billed through site one: the same customer, another site.
update public.farms set billed_through = 'ad000000-0000-4000-9000-000000000001' where id = 'ad000000-0000-4000-9000-000000000002';
insert into public.workshops (id, name) values ('ad300000-0000-4000-9000-000000000001', 'Linked workshop');
insert into public.workshop_links (workshop_id, farm_id, status, see_all_vehicles, see_costs) values
  ('ad300000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'active', true, true);
insert into auth.users (id, email) select ('ad100000-0000-4000-9000-00000000000' || n)::uuid, 'iso' || n || '@example.test' from generate_series(1, 9) n;
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('ad100000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', null, 'owner', 'Owner', 'iso1@example.test', true),
  ('ad100000-0000-4000-9000-000000000002', 'ad000000-0000-4000-9000-000000000001', null, 'manager', 'Manager', 'iso2@example.test', true),
  ('ad100000-0000-4000-9000-000000000003', 'ad000000-0000-4000-9000-000000000001', null, 'operator', 'Operator', 'iso3@example.test', true),
  ('ad100000-0000-4000-9000-000000000004', 'ad000000-0000-4000-9000-000000000001', null, 'manager', 'Switched off', 'iso4@example.test', true),
  ('ad100000-0000-4000-9000-000000000005', 'ad000000-0000-4000-9000-000000000002', null, 'manager', 'Site two manager', 'iso5@example.test', true),
  ('ad100000-0000-4000-9000-000000000006', null, 'ad300000-0000-4000-9000-000000000001', 'workshop', 'Partner', 'iso6@example.test', true),
  ('ad100000-0000-4000-9000-000000000007', null, null, 'rr_admin', 'Rapid Rise', 'iso7@example.test', true),
  ('ad100000-0000-4000-9000-000000000008', 'ad000000-0000-4000-9000-000000000003', null, 'owner', 'Other owner', 'iso8@example.test', true),
  ('ad100000-0000-4000-9000-000000000009', 'ad000000-0000-4000-9000-000000000003', null, 'manager', 'Ended membership', 'iso9@example.test', true);
-- A membership in site one that ended (the person's own business is the other one).
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('ad100000-0000-4000-9000-000000000009', 'ad000000-0000-4000-9000-000000000001', 'manager', false);

insert into public.machines (id, farm_id, name, type, meter_type) values
  ('ad200000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'Tractor', 'tractor', 'hours');
insert into public.asset_field_definitions (farm_id, key, label, field_type, visibility) values
  ('ad000000-0000-4000-9000-000000000001', 'tyre_brand', 'Tyre brand', 'text', 'everyone'),
  ('ad000000-0000-4000-9000-000000000001', 'buy_price_note', 'Buying note', 'text', 'managers');
insert into public.import_batches (farm_id, source, file_name) values
  ('ad000000-0000-4000-9000-000000000001', 'sheet', 'readings.csv');
insert into public.attachments (id, farm_id, parent_type, parent_id, kind, storage_path) values
  ('ad400000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'machine', 'ad200000-0000-4000-9000-000000000001', 'doc', 's1/manual.pdf');
insert into public.manual_index (attachment_id, farm_id, machine_id, title, provider, pages, text_bytes) values
  ('ad400000-0000-4000-9000-000000000001', 'ad000000-0000-4000-9000-000000000001', 'ad200000-0000-4000-9000-000000000001', 'Manual', 'fake', 1, 10);
-- Switched off after the rows exist, as an owner would do it: the person's session is still "valid".
update public.users set active = false where id = 'ad100000-0000-4000-9000-000000000004';

create function pg_temp.seen() returns table (fields bigint, batches bigint, manuals bigint) language sql as $$
  select (select count(*) from public.asset_field_definitions where farm_id = 'ad000000-0000-4000-9000-000000000001'),
         (select count(*) from public.import_batches where farm_id = 'ad000000-0000-4000-9000-000000000001'),
         (select count(*) from public.manual_index where farm_id = 'ad000000-0000-4000-9000-000000000001')
$$;
create function pg_temp.as_person(u text, aal text default 'aal1') returns table (fields bigint, batches bigint, manuals bigint) language plpgsql as $$
begin
  perform pg_temp.login(u, aal);
  execute 'set local role authenticated';
  return query select * from pg_temp.seen();
  execute 'reset role';
end $$;

select pg_temp.assert((select (fields, batches, manuals) = (2::bigint, 1::bigint, 1::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000001')),
  '[2] the owner sees the business''s fields, imports and manuals');
select pg_temp.assert((select (fields, batches) = (1::bigint, 0::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000003')),
  '[2] an operator sees only fields shown to everyone, and no imports');
select pg_temp.assert((select (fields, batches, manuals) = (0::bigint, 0::bigint, 0::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000004')),
  '[2] a switched-off account sees nothing, with its session still open');
select pg_temp.assert((select (fields, batches, manuals) = (0::bigint, 0::bigint, 0::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000009')),
  '[2] an ended membership sees nothing of that business');
select pg_temp.assert((select (fields, batches, manuals) = (0::bigint, 0::bigint, 0::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000005')),
  '[2] a manager of another site of the same customer sees nothing of this site');
select pg_temp.assert((select fields <= 1 and batches = 0 from pg_temp.as_person('ad100000-0000-4000-9000-000000000006')),
  '[2] a linked partner sees no imports and no field kept for managers');
select pg_temp.assert((select (fields, batches, manuals) = (0::bigint, 0::bigint, 0::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000007', 'aal1')),
  '[2] Rapid Rise with only a password sees nothing');
select pg_temp.assert((select (fields, batches, manuals) = (2::bigint, 1::bigint, 1::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000007', 'aal2')),
  '[2] Rapid Rise with the second factor sees the business in support');
select pg_temp.assert((select (fields, batches, manuals) = (0::bigint, 0::bigint, 0::bigint) from pg_temp.as_person('ad100000-0000-4000-9000-000000000008')),
  '[2] another business sees nothing');
select pg_temp.assert(not has_table_privilege('anon', 'public.import_batches', 'SELECT')
  and not has_table_privilege('anon', 'public.asset_field_definitions', 'SELECT')
  and not has_table_privilege('anon', 'public.manual_index', 'SELECT')
  and not has_table_privilege('anon', 'public.chat_messages', 'SELECT'), '[2] anon reaches none of them');

-- == Part 3: a switched-off person's open session cannot write ==================================
select pg_temp.login('ad100000-0000-4000-9000-000000000004'); set local role authenticated;
select pg_temp.assert(pg_temp.raises($q$select public.import_batch_open('ad000000-0000-4000-9000-000000000001','sheet','x.csv',repeat('a',64))$q$, '%forbidden%'),
  '[3] cannot open an import');
select pg_temp.assert(pg_temp.raises($q$select public.asset_field_define('ad000000-0000-4000-9000-000000000001','Colour','text',null,null,false,'everyone',null)$q$, '%forbidden%'),
  '[3] cannot define a field');
select pg_temp.assert(pg_temp.raises($q$select public.manual_index_remove('ad400000-0000-4000-9000-000000000001')$q$, '%forbidden%'),
  '[3] cannot take a manual out of search');
reset role;
select pg_temp.login('ad100000-0000-4000-9000-000000000009'); set local role authenticated;
select pg_temp.assert(pg_temp.raises($q$select public.import_batch_open('ad000000-0000-4000-9000-000000000001','sheet','y.csv',repeat('b',64))$q$, '%forbidden%'),
  '[3] an ended membership cannot open an import there either');
reset role;

rollback;
