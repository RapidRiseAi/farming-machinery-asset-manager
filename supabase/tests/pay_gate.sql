\set ON_ERROR_STOP on
-- The pay gate in the database (20261112090000): a member's own session cannot change the
-- working data of a business whose gate is not 'ok'; a suspended or closed one can still be
-- read (pay and download); a pending one cannot be read either. Paying, the account and a
-- contractor's own books stay open; Rapid Rise is never stopped.
--
--   P paid (active subscription, nothing owed)   -> ok
--   N signed up, never paid (pending)            -> pending
--   S invoice overdue past the grace             -> suspended
--   C cancelled, its paid period over            -> closed
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- == Fixtures =================================================================
update public.billing_price_versions set status = 'retired' where status = 'active';
insert into public.billing_price_versions (id, version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps, status) values
  ('b9800000-0000-4000-9000-000000000001', 'b9-synthetic', 'complete', 'monthly', 1111, 1, 0, 'active');

insert into public.farms (id, name, plan, status, billing_period, suspended_for) values
  ('b9000000-0000-4000-9000-000000000001', 'Paid farm',      'complete', 'active',    'monthly', null),
  ('b9000000-0000-4000-9000-000000000002', 'Pending farm',   'complete', 'active',    'monthly', null),
  ('b9000000-0000-4000-9000-000000000003', 'Suspended farm', 'complete', 'suspended', 'monthly', 'billing'),
  ('b9000000-0000-4000-9000-000000000004', 'Closed farm',    'complete', 'active',    'monthly', null);

insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status,
  current_period_start, current_period_end, next_billing_on, ended_on, cancelled_at) values
  ('b9700000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active',
   current_date - 10, current_date + 19, current_date + 20, null, null),
  ('b9700000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002', 'complete', 'monthly', 'pending',
   null, null, null, null, null),
  ('b9700000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000003', 'complete', 'monthly', 'suspended',
   current_date - 40, current_date - 11, current_date - 10, null, null),
  ('b9700000-0000-4000-9000-000000000004', 'b9000000-0000-4000-9000-000000000004', 'complete', 'monthly', 'cancelled',
   current_date - 40, current_date - 11, null, current_date - 1, now() - interval '20 days');

-- The invoice the pending farm's Pay button would charge.
insert into public.billing_invoices (id, farm_id, subscription_id, invoice_ref, status,
  period_start, period_end, issued_on, due_on, plan, billing_period, asset_count,
  unit_price_incl_cents, months_charged, price_version_id, price_version_label, vat_rate_bps) values
  ('b9810000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002',
   'b9700000-0000-4000-9000-000000000002', 'B9-INV-0002', 'draft', current_date, current_date + 29,
   current_date, current_date, 'complete', 'monthly', 1, 1111, 1,
   'b9800000-0000-4000-9000-000000000001', 'b9-synthetic', 0);

insert into public.workshops (id, name) values ('b9400000-0000-4000-9000-000000000001', 'Gate Diesel Works');

insert into auth.users (id, email) values
  ('b9100000-0000-4000-9000-000000000001', 'paid.owner@gate.test'),
  ('b9100000-0000-4000-9000-000000000002', 'pending.owner@gate.test'),
  ('b9100000-0000-4000-9000-000000000003', 'suspended.owner@gate.test'),
  ('b9100000-0000-4000-9000-000000000004', 'closed.owner@gate.test'),
  ('b9100000-0000-4000-9000-000000000005', 'two.sites@gate.test'),
  ('b9100000-0000-4000-9000-000000000006', 'contractor@gate.test'),
  ('b9100000-0000-4000-9000-000000000007', 'rapid.rise@gate.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('b9100000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000001', null, 'owner', 'Paid Owner', 'paid.owner@gate.test', true),
  ('b9100000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002', null, 'owner', 'Pending Owner', 'pending.owner@gate.test', true),
  ('b9100000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000003', null, 'owner', 'Suspended Owner', 'suspended.owner@gate.test', true),
  ('b9100000-0000-4000-9000-000000000004', 'b9000000-0000-4000-9000-000000000004', null, 'owner', 'Closed Owner', 'closed.owner@gate.test', true),
  -- Home site pending, a manager on the paid farm too.
  ('b9100000-0000-4000-9000-000000000005', 'b9000000-0000-4000-9000-000000000002', null, 'manager', 'Two Sites', 'two.sites@gate.test', true),
  ('b9100000-0000-4000-9000-000000000006', null, 'b9400000-0000-4000-9000-000000000001', 'workshop', 'Contractor', 'contractor@gate.test', true),
  ('b9100000-0000-4000-9000-000000000007', null, null, 'rr_admin', 'Rapid Rise', 'rapid.rise@gate.test', true);
insert into public.user_farm_memberships (user_id, farm_id, role) values
  ('b9100000-0000-4000-9000-000000000005', 'b9000000-0000-4000-9000-000000000001', 'manager');

-- The contractor works for the paid, the pending and the suspended farm.
insert into public.workshop_links (workshop_id, farm_id, status, see_all_vehicles) values
  ('b9400000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000001', 'active', true),
  ('b9400000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000002', 'active', true),
  ('b9400000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000003', 'active', true);

insert into public.machines (id, farm_id, name, type) values
  ('b9200000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000001', 'Paid tractor', 'tractor'),
  ('b9200000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002', 'Pending tractor', 'tractor'),
  ('b9200000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000003', 'Suspended tractor', 'tractor'),
  ('b9200000-0000-4000-9000-000000000004', 'b9000000-0000-4000-9000-000000000004', 'Closed tractor', 'tractor');
-- Enough rows on the paid farm that a per-row gate would show in the call count below.
insert into public.machines (farm_id, name, type)
select 'b9000000-0000-4000-9000-000000000001', 'Bakkie ' || n, 'bakkie' from generate_series(1, 40) n;

insert into public.faults (id, farm_id, machine_id) values
  ('b9300000-0000-4000-9000-000000000001', 'b9000000-0000-4000-9000-000000000001', 'b9200000-0000-4000-9000-000000000001'),
  ('b9300000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002', 'b9200000-0000-4000-9000-000000000002'),
  ('b9300000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000003', 'b9200000-0000-4000-9000-000000000003');
insert into public.job_cards (farm_id, machine_id, type) values
  ('b9000000-0000-4000-9000-000000000002', 'b9200000-0000-4000-9000-000000000002', 'repair'),
  ('b9000000-0000-4000-9000-000000000003', 'b9200000-0000-4000-9000-000000000003', 'repair');
insert into public.asset_aliases (farm_id, machine_id, alias) values
  ('b9000000-0000-4000-9000-000000000001', 'b9200000-0000-4000-9000-000000000001', 'the red one'),
  ('b9000000-0000-4000-9000-000000000003', 'b9200000-0000-4000-9000-000000000003', 'the old one');

-- The contractor's own books: a draft quote to each stopped farm, and a client record.
insert into public.partner_documents (id, farm_id, workshop_id, kind, status, number, subject) values
  ('b9500000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000003', 'b9400000-0000-4000-9000-000000000001', 'quote', 'draft', 'B9-Q-3', 'Clutch'),
  ('b9500000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002', 'b9400000-0000-4000-9000-000000000001', 'quote', 'draft', 'B9-Q-2', 'Hydraulics');
insert into public.partner_clients (id, workshop_id, name, farm_id) values
  ('b9600000-0000-4000-9000-000000000003', 'b9400000-0000-4000-9000-000000000001', 'Suspended farm', 'b9000000-0000-4000-9000-000000000003');

-- A shared library row (no farm): never stopped.
insert into public.checklist_templates (id, farm_id, name) values
  ('b9900000-0000-4000-9000-000000000001', null, 'Shared pre-start check');

insert into public.notifications (user_id, farm_id, channel, template) values
  ('b9100000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002', 'inapp', 'billing_pending');

create or replace function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;

-- == The fixtures are in the four states, and the helper agrees with the gate ===
do $t$
declare
  r record;
begin
  if app.farm_billing_gate('b9000000-0000-4000-9000-000000000001') <> 'ok'
     or app.farm_billing_gate('b9000000-0000-4000-9000-000000000002') <> 'pending'
     or app.farm_billing_gate('b9000000-0000-4000-9000-000000000003') <> 'suspended'
     or app.farm_billing_gate('b9000000-0000-4000-9000-000000000004') <> 'closed' then
    raise exception 'the fixtures are not ok, pending, suspended and closed';
  end if;
  -- Each owner, asked about their own farm: refused for writing exactly when the gate is
  -- not ok, refused for reading exactly when it is pending.
  for r in select * from (values
      ('b9100000-0000-4000-9000-000000000001'::uuid, 'b9000000-0000-4000-9000-000000000001'::uuid),
      ('b9100000-0000-4000-9000-000000000002', 'b9000000-0000-4000-9000-000000000002'),
      ('b9100000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000003'),
      ('b9100000-0000-4000-9000-000000000004', 'b9000000-0000-4000-9000-000000000004')) v(u, f)
  loop
    perform pg_temp.as_user(r.u);
    if (r.f in (select app.stopped_farm_ids(true))) is distinct from (app.farm_billing_gate(r.f) <> 'ok')
       or (r.f in (select app.stopped_farm_ids(false))) is distinct from (app.farm_billing_gate(r.f) = 'pending') then
      raise exception 'app.stopped_farm_ids disagrees with app.farm_billing_gate on %', r.f;
    end if;
  end loop;
  -- The member of two farms: only the pending home farm, never the paid one.
  perform pg_temp.as_user('b9100000-0000-4000-9000-000000000005');
  if array(select app.stopped_farm_ids(true)) <> array['b9000000-0000-4000-9000-000000000002'::uuid] then
    raise exception 'the two-site member''s stopped farms are wrong';
  end if;
  -- The contractor: the pending and the suspended customer for writing, the pending one for reading.
  perform pg_temp.as_user('b9100000-0000-4000-9000-000000000006');
  if (select count(*) from app.stopped_farm_ids(true)) <> 2
     or array(select app.stopped_farm_ids(false)) <> array['b9000000-0000-4000-9000-000000000002'::uuid] then
    raise exception 'the contractor''s stopped farms are wrong';
  end if;
  -- Rapid Rise, with its second factor: nothing is stopped.
  perform pg_temp.as_user('b9100000-0000-4000-9000-000000000007', 'aal2');
  if exists (select 1 from app.stopped_farm_ids(true)) then raise exception 'Rapid Rise was stopped'; end if;
  perform pg_catalog.set_config('request.jwt.claims', '', true);
end $t$;

-- == A paid farm's owner works as before ======================================
select pg_temp.as_user('b9100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines where farm_id = 'b9000000-0000-4000-9000-000000000001') <> 41 then
    raise exception 'the paid owner cannot read their vehicles';
  end if;
  insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000001', 'New truck', 'truck');
  update public.machines set name = 'Paid tractor 2' where id = 'b9200000-0000-4000-9000-000000000001';
  if not found then raise exception 'the paid owner cannot change a vehicle'; end if;
  delete from public.asset_aliases where farm_id = 'b9000000-0000-4000-9000-000000000001';
  if not found then raise exception 'the paid owner cannot delete a name'; end if;
end $t$;
reset role;

-- == The gate runs once per business per statement, not once per row =========
set local track_functions = 'all';
create temp table b9_calls (n bigint) on commit drop;
grant all on b9_calls to authenticated;
insert into b9_calls select coalesce(pg_stat_get_xact_function_calls('app.farm_billing_gate(uuid)'::regprocedure), 0);
select pg_temp.as_user('b9100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines where farm_id = 'b9000000-0000-4000-9000-000000000001') < 40 then
    raise exception 'the paid owner lost vehicles';
  end if;
end $t$;
reset role;
do $t$
declare v_calls bigint;
begin
  v_calls := coalesce(pg_stat_get_xact_function_calls('app.farm_billing_gate(uuid)'::regprocedure), 0)
             - (select n from b9_calls);
  if v_calls > 5 then
    raise exception 'reading 42 vehicles asked the billing gate % times: it runs per row', v_calls;
  end if;
end $t$;

-- == A pending farm's owner: no working data, but the farm, the bill and the account ==
select pg_temp.as_user('b9100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines) <> 0 or (select count(*) from public.faults) <> 0 then
    raise exception 'a business that never paid reads its working data';
  end if;
  begin
    insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000002', 'Sneaky', 'truck');
    raise exception 'a business that never paid added a vehicle';
  exception when insufficient_privilege then null;
  end;
  update public.machines set name = 'Sneaky' where farm_id = 'b9000000-0000-4000-9000-000000000002';
  if found then raise exception 'a business that never paid changed a vehicle'; end if;
  if (select count(*) from public.job_cards_visible) <> 0 then
    raise exception 'the pending farm reads through a cost view';
  end if;
  -- A row with no farm is the shared library, open whatever this business owes.
  if (select count(*) from public.checklist_templates where id = 'b9900000-0000-4000-9000-000000000001') <> 1 then
    raise exception 'a stopped business lost the shared library';
  end if;
  -- What the pay screen needs.
  if (select count(*) from public.farms where id = 'b9000000-0000-4000-9000-000000000002') <> 1 then
    raise exception 'the pending owner cannot read their farm';
  end if;
  if (select count(*) from public.billing_subscriptions where farm_id = 'b9000000-0000-4000-9000-000000000002') <> 1
     or (select count(*) from public.billing_invoices where farm_id = 'b9000000-0000-4000-9000-000000000002') <> 1 then
    raise exception 'the pending owner cannot read the subscription and invoice they must pay';
  end if;
  if public.farm_billing_gate('b9000000-0000-4000-9000-000000000002') <> 'pending' then
    raise exception 'the pay screen cannot ask the gate';
  end if;
  -- Their own account and inbox.
  update public.users set name = 'Pending Owner Renamed' where id = 'b9100000-0000-4000-9000-000000000002';
  if not found then raise exception 'the pending owner cannot change their own name'; end if;
  update public.notifications set read_at = now() where user_id = 'b9100000-0000-4000-9000-000000000002';
  if not found then raise exception 'the pending owner cannot mark a notice read'; end if;
  if (select count(*) from public.users where id = 'b9100000-0000-4000-9000-000000000002') <> 1 then
    raise exception 'the pending owner cannot read their own account';
  end if;
end $t$;
reset role;

-- == A suspended farm's owner: reads (download), no writes ====================
select pg_temp.as_user('b9100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines where farm_id = 'b9000000-0000-4000-9000-000000000003') <> 1
     or (select count(*) from public.faults where farm_id = 'b9000000-0000-4000-9000-000000000003') <> 1
     or (select count(*) from public.job_cards_visible where farm_id = 'b9000000-0000-4000-9000-000000000003') <> 1 then
    raise exception 'a suspended farm cannot read its records to download them';
  end if;
  if (select count(*) from public.billing_subscriptions where farm_id = 'b9000000-0000-4000-9000-000000000003') <> 1 then
    raise exception 'a suspended owner cannot read the subscription';
  end if;
  begin
    insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000003', 'Sneaky', 'truck');
    raise exception 'a suspended farm added a vehicle';
  exception when insufficient_privilege then null;
  end;
  update public.machines set name = 'Sneaky' where farm_id = 'b9000000-0000-4000-9000-000000000003';
  if found then raise exception 'a suspended farm changed a vehicle'; end if;
  delete from public.asset_aliases where farm_id = 'b9000000-0000-4000-9000-000000000003';
  if found then raise exception 'a suspended farm deleted a name'; end if;
  -- Answering a contractor's paperwork is the farm's work too.
  begin
    insert into public.partner_documents (farm_id, workshop_id, kind, status, number, subject) values
      ('b9000000-0000-4000-9000-000000000003', 'b9400000-0000-4000-9000-000000000001', 'invoice', 'draft', 'B9-F-3', 'Received');
    raise exception 'a suspended farm recorded a supplier document';
  exception when insufficient_privilege then null;
  end;
  update public.users set name = 'Suspended Owner Renamed' where id = 'b9100000-0000-4000-9000-000000000003';
  if not found then raise exception 'a suspended owner cannot change their own name'; end if;
end $t$;
reset role;
do $t$ begin
  if not exists (select 1 from public.asset_aliases where farm_id = 'b9000000-0000-4000-9000-000000000003' and alias = 'the old one') then
    raise exception 'the suspended farm''s name was deleted after all';
  end if;
end $t$;

-- == A closed farm's owner: the same ===========================================
select pg_temp.as_user('b9100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines where farm_id = 'b9000000-0000-4000-9000-000000000004') <> 1 then
    raise exception 'a closed farm cannot read its records to take them away';
  end if;
  begin
    insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000004', 'Sneaky', 'truck');
    raise exception 'a closed farm added a vehicle';
  exception when insufficient_privilege then null;
  end;
  update public.machines set name = 'Sneaky' where farm_id = 'b9000000-0000-4000-9000-000000000004';
  if found then raise exception 'a closed farm changed a vehicle'; end if;
end $t$;
reset role;

-- == A member of a stopped farm and a paid one works on the paid one ===========
select pg_temp.as_user('b9100000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines where farm_id = 'b9000000-0000-4000-9000-000000000001') < 41 then
    raise exception 'the two-site member cannot read the paid farm';
  end if;
  if (select count(*) from public.machines where farm_id = 'b9000000-0000-4000-9000-000000000002') <> 0 then
    raise exception 'the two-site member reads the pending farm';
  end if;
  insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000001', 'Second site truck', 'truck');
  begin
    insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000002', 'Sneaky', 'truck');
    raise exception 'the two-site member added a vehicle to the pending farm';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

-- == A contractor: refused on a stopped farm's rows, not on its own or a paid farm's ==
select pg_temp.as_user('b9100000-0000-4000-9000-000000000006');
set local role authenticated;
do $t$ begin
  update public.faults set description = 'Looked at it' where id = 'b9300000-0000-4000-9000-000000000001';
  if not found then raise exception 'the contractor cannot work on the paid farm'; end if;
  update public.faults set description = 'Looked at it' where id = 'b9300000-0000-4000-9000-000000000003';
  if found then raise exception 'the contractor worked on the suspended farm'; end if;
  if (select count(*) from public.faults where id = 'b9300000-0000-4000-9000-000000000003') <> 1 then
    raise exception 'the suspended rule is read, not hide: the contractor should still see it';
  end if;
  if (select count(*) from public.faults where id = 'b9300000-0000-4000-9000-000000000002') <> 0 then
    raise exception 'the contractor reads the pending farm';
  end if;
  -- Its own books, about those same customers.
  update public.partner_documents set subject = 'Clutch and plates' where id = 'b9500000-0000-4000-9000-000000000003';
  if not found then raise exception 'the contractor cannot edit its own quote to a suspended customer'; end if;
  if (select count(*) from public.partner_documents where id = 'b9500000-0000-4000-9000-000000000002') <> 1 then
    raise exception 'the contractor cannot read its own quote to a pending customer';
  end if;
  update public.partner_clients set phone = '0820000000' where id = 'b9600000-0000-4000-9000-000000000003';
  if not found then raise exception 'the contractor cannot keep its client list'; end if;
end $t$;
reset role;

-- == Rapid Rise is unaffected ===================================================
select pg_temp.as_user('b9100000-0000-4000-9000-000000000007', 'aal2');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.machines where farm_id in ('b9000000-0000-4000-9000-000000000002',
        'b9000000-0000-4000-9000-000000000003', 'b9000000-0000-4000-9000-000000000004')) <> 3 then
    raise exception 'Rapid Rise cannot read the stopped farms';
  end if;
  update public.machines set name = 'Checked by Rapid Rise' where id = 'b9200000-0000-4000-9000-000000000003';
  if not found then raise exception 'Rapid Rise cannot change a suspended farm''s vehicle'; end if;
  insert into public.machines (farm_id, name, type) values ('b9000000-0000-4000-9000-000000000002', 'Loaded by staff', 'truck');
end $t$;
reset role;

-- == Every table with a farm_id is gated, or open on purpose ===================
do $t$
declare
  t record;
  v_cmd text;
  v_rule text;
  v_has boolean;
  v_needs boolean;
  v_gated integer := 0;
  v_def text;
begin
  for t in
    select c.relname
      from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'farm_id' and not a.attisdropped)
  loop
    select r.rule into v_rule from app.pay_gate_rules r where r.table_name = t.relname;
    foreach v_cmd in array array['select', 'insert', 'update', 'delete'] loop
      v_needs := v_rule is distinct from 'open' and exists (
        select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.relname
           and p.permissive = 'PERMISSIVE' and p.cmd in ('ALL', upper(v_cmd))
           and p.roles && array['public', 'authenticated']::name[]);
      select coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '') into v_def
        from pg_policies p
       where p.schemaname = 'public' and p.tablename = t.relname and p.policyname = 'pay_gate_' || v_cmd
         and p.permissive = 'RESTRICTIVE' and p.roles = array['authenticated']::name[];
      v_has := found;
      if v_needs and not v_has then
        raise exception 'public.% has no pay_gate_% policy: gate it with app.pay_gate_apply or list it in app.pay_gate_rules', t.relname, v_cmd;
      end if;
      if v_has and not v_needs then
        raise exception 'public.% has a pay_gate_% policy it should not have', t.relname, v_cmd;
      end if;
      if v_has and v_def not like '%stopped_farm_ids(' || (v_cmd <> 'select')::text || ')%' then
        raise exception 'public.%''s pay_gate_% asks the wrong question', t.relname, v_cmd;
      end if;
      if v_has and v_cmd = 'select' then v_gated := v_gated + 1; end if;
    end loop;
  end loop;
  if v_gated < 60 then raise exception 'only % tables are gated', v_gated; end if;

  -- No rule names a table that is not there.
  if exists (select 1 from app.pay_gate_rules r
              where to_regclass(format('public.%I', r.table_name)) is null
                 or not exists (select 1 from pg_attribute a where a.attrelid = to_regclass(format('public.%I', r.table_name))
                                  and a.attname = 'farm_id' and not a.attisdropped)) then
    raise exception 'app.pay_gate_rules names a table without a farm_id';
  end if;

  -- Who may call what.
  if has_function_privilege('anon', 'app.stopped_farm_ids(boolean)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'app.stopped_farm_ids(boolean)', 'EXECUTE') then
    raise exception 'app.stopped_farm_ids has the wrong grants';
  end if;
  if has_function_privilege('authenticated', 'app.pay_gate_apply(text)', 'EXECUTE')
     or has_function_privilege('anon', 'app.pay_gate_apply(text)', 'EXECUTE')
     or has_function_privilege('service_role', 'app.pay_gate_apply(text)', 'EXECUTE') then
    raise exception 'a session can run app.pay_gate_apply';
  end if;
  if has_table_privilege('authenticated', 'app.pay_gate_rules', 'SELECT') then
    raise exception 'a session can read app.pay_gate_rules';
  end if;
  if not exists (select 1 from pg_proc where oid = 'app.stopped_farm_ids(boolean)'::regprocedure
                   and prosecdef and array_to_string(proconfig, ',') like 'search_path=%') then
    raise exception 'app.stopped_farm_ids is not security definer with a pinned search_path';
  end if;

  -- Run again, nothing changes (the migration can be applied twice).
  if app.pay_gate_apply('machines') <> 4 or app.pay_gate_apply('billing_invoices') <> 0 then
    raise exception 'app.pay_gate_apply is not repeatable';
  end if;
end $t$;

rollback;
