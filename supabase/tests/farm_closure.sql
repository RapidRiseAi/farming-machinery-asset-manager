\set ON_ERROR_STOP on
-- Permanent closure: what goes, and above all what must not (20261107100000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- CI has no Storage; a stand-in, so the file list can be proved.
create schema if not exists storage;
create table if not exists storage.objects (bucket_id text, name text, metadata jsonb);

-- The account being closed, signed up the real way so it has an invoice.
insert into auth.users (id, email) values
  ('e6100000-0000-4000-9000-000000000001', 'owner@closing.test'),
  ('e6100000-0000-4000-9000-000000000002', 'driver@closing.test'),
  ('e6100000-0000-4000-9000-000000000003', 'both@closing.test'),
  ('e6100000-0000-4000-9000-000000000004', 'neighbour@staying.test');
select public.billing_create_pending_signup(
  'e6100000-0000-4000-9000-000000000001', 'owner@closing.test', 'Closing Owner', 'Closing Farm',
  'essential', 'monthly', 5, null);

create temporary table closing on commit drop as
  select farm_id as id from public.users where id = 'e6100000-0000-4000-9000-000000000001';

-- A neighbour who must be untouched, and a second site for one person.
insert into public.farms (id, name, plan, status, billing_period) values
  ('e6000000-0000-4000-9000-000000000002', 'Staying Farm', 'complete', 'active', 'monthly');
insert into public.users (id, farm_id, role, name, email, active)
select 'e6100000-0000-4000-9000-000000000002', id, 'operator', 'Driver', 'driver@closing.test', true from closing;
insert into public.users (id, farm_id, role, name, email, active)
select 'e6100000-0000-4000-9000-000000000003', id, 'manager', 'Both', 'both@closing.test', true from closing;
insert into public.users (id, farm_id, role, name, email, active) values
  ('e6100000-0000-4000-9000-000000000004', 'e6000000-0000-4000-9000-000000000002', 'owner', 'Neighbour', 'neighbour@staying.test', true);
insert into public.user_farm_memberships (user_id, farm_id, role, active)
values ('e6100000-0000-4000-9000-000000000003', 'e6000000-0000-4000-9000-000000000002', 'manager', true)
on conflict do nothing;

insert into public.machines (id, farm_id, name, type)
select 'e6200000-0000-4000-9000-000000000001', id, 'Gone tractor', 'tractor' from closing;
insert into public.machines (id, farm_id, name, type) values
  ('e6200000-0000-4000-9000-000000000002', 'e6000000-0000-4000-9000-000000000002', 'Staying tractor', 'tractor');
insert into public.faults (farm_id, machine_id, title, severity)
select id, 'e6200000-0000-4000-9000-000000000001', 'Leak', 'low' from closing;

-- A contractor who worked for them.
insert into public.workshops (id, name) values ('e6300000-0000-4000-9000-000000000001', 'Their mechanic');
insert into public.workshop_links (workshop_id, farm_id, status)
select 'e6300000-0000-4000-9000-000000000001', id, 'active' from closing;
insert into public.partner_documents (id, workshop_id, farm_id, doc_type, bill_to_name, number, issue_date, status, source)
select 'e6400000-0000-4000-9000-000000000001', 'e6300000-0000-4000-9000-000000000001', id,
       'invoice', 'Closing Farm', 'INV-1', current_date, 'sent', 'built' from closing;

insert into storage.objects (bucket_id, name, metadata)
select 'machine-photos', id::text || '/a/photo.jpg', '{"size": 10}' from closing
union all select 'partner-docs', id::text || '/doc/invoice.pdf', '{"size": 20}' from closing
union all select 'machine-photos', 'e6000000-0000-4000-9000-000000000002/b/photo.jpg', '{"size": 30}';

do $t$
declare
  v_farm uuid := (select id from closing);
  v jsonb;
  v_invoices int := (select count(*) from public.billing_invoices where farm_id = v_farm);
begin
  if v_invoices < 1 then raise exception 'the test needs an invoice to keep'; end if;

  v := public.close_farm_permanently(v_farm, 'e6100000-0000-4000-9000-000000000001');

  -- Gone.
  if exists (select 1 from public.machines where farm_id = v_farm) then raise exception 'a machine survived'; end if;
  if exists (select 1 from public.faults where farm_id = v_farm) then raise exception 'a fault survived'; end if;
  if exists (select 1 from public.workshop_links where farm_id = v_farm) then raise exception 'a link survived'; end if;
  if exists (select 1 from public.users where id in ('e6100000-0000-4000-9000-000000000001', 'e6100000-0000-4000-9000-000000000002')) then
    raise exception 'a person who belonged only here survived';
  end if;
  if not (v -> 'logins') ? 'e6100000-0000-4000-9000-000000000001' or not (v -> 'logins') ? 'e6100000-0000-4000-9000-000000000002' then
    raise exception 'logins to remove: %', v -> 'logins';
  end if;

  -- Kept for tax.
  if (select count(*) from public.billing_invoices where farm_id = v_farm) <> v_invoices then
    raise exception 'an invoice was lost';
  end if;
  if not exists (select 1 from public.farms where id = v_farm and deleted_at is not null and status = 'cancelled') then
    raise exception 'the marker row is wrong';
  end if;
  if exists (select 1 from public.billing_subscriptions where farm_id = v_farm and status <> 'cancelled') then
    raise exception 'a subscription is still running';
  end if;
  if (select retain_until from public.farm_closures where farm_id = v_farm) <= current_date + 1800 then
    raise exception 'the closure record is not kept for five years';
  end if;

  -- A contractor's records stay theirs, without the link.
  if not exists (select 1 from public.partner_documents
                  where id = 'e6400000-0000-4000-9000-000000000001' and farm_id is null and bill_to_name = 'Closing Farm') then
    raise exception 'the contractor lost their invoice';
  end if;
  if not exists (select 1 from public.workshops where id = 'e6300000-0000-4000-9000-000000000001') then
    raise exception 'the contractor''s business went';
  end if;

  -- Somebody on another site keeps their login and moves there.
  if (select farm_id from public.users where id = 'e6100000-0000-4000-9000-000000000003')
     <> 'e6000000-0000-4000-9000-000000000002' then
    raise exception 'the person on two sites did not move';
  end if;
  if (v -> 'logins') ? 'e6100000-0000-4000-9000-000000000003' then
    raise exception 'the person on two sites was marked to lose their login';
  end if;

  -- The neighbour is untouched.
  if not exists (select 1 from public.machines where id = 'e6200000-0000-4000-9000-000000000002') then
    raise exception 'another business lost a machine';
  end if;

  -- Only their own files, never a contractor's or a neighbour's.
  if jsonb_array_length(v -> 'files') <> 1 or (v -> 'files' -> 0 ->> 'bucket') <> 'machine-photos' then
    raise exception 'files: %', v -> 'files';
  end if;

  -- The guards are back on.
  if current_setting('session_replication_role') <> 'origin' then raise exception 'the guards stayed off'; end if;

  -- Twice is refused.
  begin
    perform public.close_farm_permanently(v_farm, 'e6100000-0000-4000-9000-000000000003');
    raise exception 'an account was closed twice';
  exception when raise_exception then
    if sqlerrm <> 'already closed' then raise; end if;
  end;

  -- Five years on, the rest goes.
  update public.farm_closures set retain_until = current_date - 1 where farm_id = v_farm;
  if public.purge_expired_closures() <> 1 then raise exception 'the purge found nothing'; end if;
  if exists (select 1 from public.billing_invoices where farm_id = v_farm) or exists (select 1 from public.farms where id = v_farm) then
    raise exception 'the purge left something behind';
  end if;
end $t$;

-- Nobody but the server may call any of this.
do $t$
begin
  if has_function_privilege('authenticated', 'public.close_farm_permanently(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.close_farm_permanently(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.farm_file_objects(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.purge_expired_closures()', 'EXECUTE') then
    raise exception 'closure is for the server alone';
  end if;
  if has_table_privilege('authenticated', 'public.farm_closure_requests', 'SELECT') then
    raise exception 'a signed-in person can read closure requests';
  end if;
end $t$;

rollback;
