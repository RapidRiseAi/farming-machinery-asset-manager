-- Transactional isolation checks for 20260903074350_operator_cost_confidentiality.
--
-- The role attached to the resource farm is authoritative. A user's primary profile
-- role must neither grant costs on another farm nor suppress costs on a farm where that
-- user is an owner. Operators default closed and are opened only by the literal farm
-- setting `cost_visible_to_operators: true`.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _cost_visibility_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _cost_visibility_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, settings) values
  ('cf000000-0000-4000-8000-000000000001', 'Cost Farm A', 'professional', 'active',
   '{"cost_visible_to_operators": false}'::jsonb),
  ('cf000000-0000-4000-8000-000000000002', 'Cost Farm B', 'professional', 'active',
   '{"cost_visible_to_operators": false}'::jsonb),
  ('cf000000-0000-4000-8000-000000000003', 'Cost Farm C', 'professional', 'active',
   '{"cost_visible_to_operators": true}'::jsonb),
  ('cf000000-0000-4000-8000-000000000004', 'Cost Farm D', 'professional', 'active',
   '{}'::jsonb);

insert into auth.users (id, email) values
  ('cf100000-0000-4000-8000-000000000001', 'cost-owner-secondary-operator@example.test'),
  ('cf100000-0000-4000-8000-000000000002', 'cost-manager@example.test'),
  ('cf100000-0000-4000-8000-000000000003', 'cost-mechanic@example.test'),
  ('cf100000-0000-4000-8000-000000000004', 'cost-opted-in-operator@example.test'),
  ('cf100000-0000-4000-8000-000000000005', 'cost-operator-secondary-owner@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('cf100000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000001',
   'owner', 'Primary owner, secondary operator', 'cost-owner-secondary-operator@example.test'),
  ('cf100000-0000-4000-8000-000000000002', 'cf000000-0000-4000-8000-000000000001',
   'manager', 'Cost manager', 'cost-manager@example.test'),
  ('cf100000-0000-4000-8000-000000000003', 'cf000000-0000-4000-8000-000000000001',
   'mechanic', 'Cost mechanic', 'cost-mechanic@example.test'),
  ('cf100000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000003',
   'operator', 'Opted-in operator', 'cost-opted-in-operator@example.test'),
  ('cf100000-0000-4000-8000-000000000005', 'cf000000-0000-4000-8000-000000000004',
   'operator', 'Primary operator, secondary owner', 'cost-operator-secondary-owner@example.test');

insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('cf100000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000002', 'operator', true),
  ('cf100000-0000-4000-8000-000000000005', 'cf000000-0000-4000-8000-000000000001', 'owner', true);

-- Each insert creates an exact purchase row and finance-interest row in cost_entries.
insert into public.machines (
  id, farm_id, name, type, assigned_operator_id,
  purchase_date, purchase_price_cents, supplier,
  finance_provider, finance_total_cents, finance_monthly_cents,
  finance_term_months, finance_interest_bps
) values
  ('cf200000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000001',
   'Farm A costed tractor', 'tractor', 'cf100000-0000-4000-8000-000000000001',
   current_date, 110000, 'Supplier A', 'Bank A', 100000, 10000, 12, 1200),
  ('cf200000-0000-4000-8000-000000000002', 'cf000000-0000-4000-8000-000000000002',
   'Farm B assigned tractor', 'tractor', 'cf100000-0000-4000-8000-000000000001',
   current_date, 220000, 'Supplier B', 'Bank B', 200000, 20000, 12, 1300),
  ('cf200000-0000-4000-8000-000000000003', 'cf000000-0000-4000-8000-000000000002',
   'Farm B unassigned tractor', 'tractor', null,
   current_date, 230000, 'Supplier B2', 'Bank B2', 200000, 20000, 12, 1300),
  ('cf200000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000003',
   'Farm C assigned tractor', 'tractor', 'cf100000-0000-4000-8000-000000000004',
   current_date, 330000, 'Supplier C', 'Bank C', 300000, 30000, 12, 1400),
  ('cf200000-0000-4000-8000-000000000005', 'cf000000-0000-4000-8000-000000000004',
   'Farm D assigned tractor', 'tractor', 'cf100000-0000-4000-8000-000000000005',
   current_date, 440000, 'Supplier D', 'Bank D', 400000, 40000, 12, 1500);

insert into public.budgets (
  id, farm_id, machine_id, period_type, period_start, period_end, amount_cents
) values
  ('cf300000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000001',
   'cf200000-0000-4000-8000-000000000001', 'month', current_date, current_date, 510000),
  ('cf300000-0000-4000-8000-000000000002', 'cf000000-0000-4000-8000-000000000002',
   'cf200000-0000-4000-8000-000000000002', 'month', current_date, current_date, 520000),
  ('cf300000-0000-4000-8000-000000000003', 'cf000000-0000-4000-8000-000000000003',
   'cf200000-0000-4000-8000-000000000004', 'month', current_date, current_date, 530000),
  ('cf300000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000004',
   'cf200000-0000-4000-8000-000000000005', 'month', current_date, current_date, 540000);

-- Column privileges are the immutable part of the machine financial boundary.
do $$ begin
  if not has_column_privilege('authenticated', 'public.machines', 'name', 'select') then
    raise exception 'COST VISIBILITY FAIL: authenticated lost safe machine columns';
  end if;
  if has_column_privilege('authenticated', 'public.machines', 'purchase_price_cents', 'select')
     or has_column_privilege('authenticated', 'public.machines', 'supplier', 'select')
     or has_column_privilege('authenticated', 'public.machines', 'finance_total_cents', 'select') then
    raise exception 'COST VISIBILITY FAIL: authenticated can directly select machine financial columns';
  end if;
  if has_function_privilege('anon', 'public.can_view_farm_costs(uuid)', 'execute')
     or has_function_privilege('anon', 'public.machine_financials(uuid)', 'execute') then
    raise exception 'COST VISIBILITY FAIL: anon can execute a cost projection';
  end if;
  if not has_function_privilege('authenticated', 'public.can_view_farm_costs(uuid)', 'execute')
     or not has_function_privilege('authenticated', 'public.machine_financials(uuid)', 'execute') then
    raise exception 'COST VISIBILITY FAIL: authenticated cannot execute checked projections';
  end if;
  if not has_column_privilege('service_role', 'public.machines', 'purchase_price_cents', 'select') then
    raise exception 'COST VISIBILITY FAIL: service_role lost direct machine access';
  end if;
end $$;

-- Primary owner on A, effective operator on B: the resource-farm role wins.
set role authenticated;
do $$
declare
  n bigint;
  price bigint;
  provider text;
  blocked boolean := false;
begin
  perform _cost_visibility_login('cf100000-0000-4000-8000-000000000001');

  if app.effective_farm_role(auth.uid(), 'cf000000-0000-4000-8000-000000000001') <> 'owner' then
    raise exception 'COST VISIBILITY FAIL: primary Farm A role is not owner';
  end if;
  if app.effective_farm_role(auth.uid(), 'cf000000-0000-4000-8000-000000000002') <> 'operator' then
    raise exception 'COST VISIBILITY FAIL: secondary Farm B role is not operator';
  end if;
  if not public.can_view_farm_costs('cf000000-0000-4000-8000-000000000001') then
    raise exception 'COST VISIBILITY FAIL: owner cannot read Farm A costs';
  end if;
  if public.can_view_farm_costs('cf000000-0000-4000-8000-000000000002') then
    raise exception 'COST VISIBILITY FAIL: primary owner role leaked into operator Farm B';
  end if;

  select count(*) into n from machines
   where id = 'cf200000-0000-4000-8000-000000000002';
  if n <> 1 then
    raise exception 'COST VISIBILITY FAIL: operator lost assigned non-financial machine row';
  end if;
  select count(*) into n from machines
   where id = 'cf200000-0000-4000-8000-000000000003';
  if n <> 0 then
    raise exception 'COST VISIBILITY FAIL: operator read an unassigned machine';
  end if;

  select count(*) into n from cost_entries
   where farm_id = 'cf000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'COST VISIBILITY FAIL: opted-out operator read % cost rows', n; end if;
  select count(*) into n from budgets
   where farm_id = 'cf000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'COST VISIBILITY FAIL: opted-out operator read % budgets', n; end if;
  select count(*) into n from audit_log
   where farm_id = 'cf000000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'COST VISIBILITY FAIL: opted-out operator read % audit rows', n; end if;
  select count(*) into n
    from public.machine_financials('cf200000-0000-4000-8000-000000000002');
  if n <> 0 then raise exception 'COST VISIBILITY FAIL: opted-out operator RPC returned % rows', n; end if;

  begin
    execute 'select purchase_price_cents from public.machines where id = '
      || quote_literal('cf200000-0000-4000-8000-000000000002');
  exception when insufficient_privilege then
    blocked := true;
  end;
  if not blocked then
    raise exception 'COST VISIBILITY FAIL: direct purchase-price SELECT was allowed';
  end if;

  select purchase_price_cents, finance_provider into price, provider
    from public.machine_financials('cf200000-0000-4000-8000-000000000001');
  if price <> 110000 or provider <> 'Bank A' then
    raise exception 'COST VISIBILITY FAIL: owner RPC values were %, %', price, provider;
  end if;
  select count(*) into n from cost_entries
   where farm_id = 'cf000000-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'COST VISIBILITY FAIL: owner sees % Farm A costs, expected 2', n; end if;
end $$;
reset role;

-- Manager and mechanic retain costs without the operator setting.
set role authenticated;
do $$ declare n bigint; uid uuid; begin
  foreach uid in array array[
    'cf100000-0000-4000-8000-000000000002'::uuid,
    'cf100000-0000-4000-8000-000000000003'::uuid
  ] loop
    perform _cost_visibility_login(uid);
    if not public.can_view_farm_costs('cf000000-0000-4000-8000-000000000001') then
      raise exception 'COST VISIBILITY FAIL: manager/mechanic % cannot view costs', uid;
    end if;
    select count(*) into n from cost_entries
     where farm_id = 'cf000000-0000-4000-8000-000000000001';
    if n <> 2 then raise exception 'COST VISIBILITY FAIL: manager/mechanic % sees % costs', uid, n; end if;
    select count(*) into n
      from public.machine_financials('cf200000-0000-4000-8000-000000000001');
    if n <> 1 then raise exception 'COST VISIBILITY FAIL: manager/mechanic % lost financial RPC', uid; end if;
  end loop;
end $$;
reset role;

-- Literal opt-in opens the ledger/budget and the assigned machine projection. It does
-- not weaken assignment visibility for a second machine.
update public.farms
   set settings = pg_catalog.jsonb_set(settings, '{cost_visible_to_operators}', 'true'::jsonb, true)
 where id = 'cf000000-0000-4000-8000-000000000002';

set role authenticated;
do $$ declare n bigint; price bigint; begin
  perform _cost_visibility_login('cf100000-0000-4000-8000-000000000001');
  if not public.can_view_farm_costs('cf000000-0000-4000-8000-000000000002') then
    raise exception 'COST VISIBILITY FAIL: opted-in secondary-farm operator stayed closed';
  end if;
  select count(*) into n from cost_entries
   where farm_id = 'cf000000-0000-4000-8000-000000000002';
  if n <> 4 then raise exception 'COST VISIBILITY FAIL: opted-in operator sees % costs, expected 4', n; end if;
  select count(*) into n from budgets
   where farm_id = 'cf000000-0000-4000-8000-000000000002';
  if n <> 1 then raise exception 'COST VISIBILITY FAIL: opted-in operator sees % budgets', n; end if;
  select purchase_price_cents into price
    from public.machine_financials('cf200000-0000-4000-8000-000000000002');
  if price <> 220000 then raise exception 'COST VISIBILITY FAIL: opted-in RPC returned %', price; end if;
  select count(*) into n
    from public.machine_financials('cf200000-0000-4000-8000-000000000003');
  if n <> 0 then raise exception 'COST VISIBILITY FAIL: opt-in bypassed assignment visibility'; end if;
end $$;
reset role;

-- A primary operator on an explicitly opted-in farm is allowed.
set role authenticated;
do $$ declare n bigint; begin
  perform _cost_visibility_login('cf100000-0000-4000-8000-000000000004');
  if not public.can_view_farm_costs('cf000000-0000-4000-8000-000000000003') then
    raise exception 'COST VISIBILITY FAIL: primary opted-in operator stayed closed';
  end if;
  select count(*) into n from cost_entries
   where farm_id = 'cf000000-0000-4000-8000-000000000003';
  if n <> 2 then raise exception 'COST VISIBILITY FAIL: primary opted-in operator sees % costs', n; end if;
  select count(*) into n
    from public.machine_financials('cf200000-0000-4000-8000-000000000004');
  if n <> 1 then raise exception 'COST VISIBILITY FAIL: primary opted-in operator lost RPC'; end if;
end $$;
reset role;

-- The reverse multi-site case: a primary operator remains closed on D, but their
-- effective owner role on A grants the exact same data as any other Farm A owner.
set role authenticated;
do $$ declare n bigint; begin
  perform _cost_visibility_login('cf100000-0000-4000-8000-000000000005');
  if public.can_view_farm_costs('cf000000-0000-4000-8000-000000000004') then
    raise exception 'COST VISIBILITY FAIL: absent setting did not default closed for operator';
  end if;
  if app.effective_farm_role(auth.uid(), 'cf000000-0000-4000-8000-000000000001') <> 'owner'
     or not public.can_view_farm_costs('cf000000-0000-4000-8000-000000000001') then
    raise exception 'COST VISIBILITY FAIL: primary operator role suppressed secondary owner access';
  end if;
  select count(*) into n from cost_entries
   where farm_id = 'cf000000-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'COST VISIBILITY FAIL: secondary owner sees % Farm A costs', n; end if;
  select count(*) into n
    from public.machine_financials('cf200000-0000-4000-8000-000000000001');
  if n <> 1 then raise exception 'COST VISIBILITY FAIL: secondary owner lost machine financials'; end if;
  select count(*) into n
    from public.machine_financials('cf200000-0000-4000-8000-000000000002');
  if n <> 0 then raise exception 'COST VISIBILITY FAIL: secondary owner crossed into Farm B'; end if;
end $$;
reset role;

select pg_catalog.set_config('request.jwt.claims', '', false);

-- Exercise every masked projection, including quantities, soft deletion and tenant
-- isolation. Use live monetary fixtures so a missing row cannot masquerade as masking.
update public.farms set settings = '{"cost_visible_to_operators": false}'
 where id = 'cf000000-0000-4000-8000-000000000002';
do $$
declare f uuid; m uuid; suffix text; i integer;
begin
  for i in 1..3 loop
    suffix := lpad(i::text, 12, '0');
    f := ('cf000000-0000-4000-8000-' || suffix)::uuid;
    m := ('cf200000-0000-4000-8000-' || lpad((case when i = 3 then 4 else i end)::text, 12, '0'))::uuid;
    insert into public.job_cards(id, farm_id, machine_id, type, mechanic_user_id)
      values (('cf400000-0000-4000-8000-' || suffix)::uuid, f, m, 'repair', 'cf100000-0000-4000-8000-000000000001');
    insert into public.job_card_lines(id, farm_id, job_card_id, kind, description, qty, unit_cost_cents)
      values (('cf410000-0000-4000-8000-' || suffix)::uuid, f, ('cf400000-0000-4000-8000-' || suffix)::uuid,
              'part', 'Filter', 2, 1234);
    insert into public.fuel_tanks(id, farm_id, name)
      values (('cf420000-0000-4000-8000-' || suffix)::uuid, f, 'Test tank');
    insert into public.fuel_deliveries(id, farm_id, tank_id, litres, price_per_l_cents, doc_url)
      values (('cf430000-0000-4000-8000-' || suffix)::uuid, f, ('cf420000-0000-4000-8000-' || suffix)::uuid,
              100, 1234, 'https://example.test/confidential-invoice');
    insert into public.fuel_issues(id, farm_id, tank_id, machine_id, litres, cost_cents, price_per_l_cents)
      values (('cf440000-0000-4000-8000-' || suffix)::uuid, f, ('cf420000-0000-4000-8000-' || suffix)::uuid,
              m, 10, 12340, 1234);
    insert into public.parts_catalogue(id, farm_id, part_no, typical_cost_cents)
      values (('cf450000-0000-4000-8000-' || suffix)::uuid, f, 'cost-test-filter', 1234);
    insert into public.service_kits(id, farm_id, machine_id, name)
      values (('cf460000-0000-4000-8000-' || suffix)::uuid, f, m, 'Test kit');
    insert into public.service_kit_items(id, farm_id, service_kit_id, part_catalogue_id, qty, unit_cost_cents)
      values (('cf470000-0000-4000-8000-' || suffix)::uuid, f, ('cf460000-0000-4000-8000-' || suffix)::uuid,
              ('cf450000-0000-4000-8000-' || suffix)::uuid, 2, 1234);
    insert into public.stock_items(id, farm_id, part_catalogue_id)
      values (('cf480000-0000-4000-8000-' || suffix)::uuid, f, ('cf450000-0000-4000-8000-' || suffix)::uuid);
    insert into public.stock_movements(id, farm_id, stock_item_id, kind, qty, unit_cost_cents)
      values (('cf490000-0000-4000-8000-' || suffix)::uuid, f, ('cf480000-0000-4000-8000-' || suffix)::uuid,
              'receipt', 4, 1234);
    insert into public.work_requests(id, farm_id, machine_id, quote_amount_cents, invoice_amount_cents)
      values (('cf500000-0000-4000-8000-' || suffix)::uuid, f, m, 1234, 2468);
    insert into public.attachments(id, farm_id, parent_type, parent_id, kind, storage_path, created_by)
      values (('cf510000-0000-4000-8000-' || suffix)::uuid, f, 'job_card', ('cf400000-0000-4000-8000-' || suffix)::uuid,
              'photo', f || '/cf400000-0000-4000-8000-' || suffix || '/photo-test.jpg', 'cf100000-0000-4000-8000-000000000001'),
             (('cf520000-0000-4000-8000-' || suffix)::uuid, f, 'job_card', ('cf400000-0000-4000-8000-' || suffix)::uuid,
              'invoice', f || '/cf400000-0000-4000-8000-' || suffix || '/invoice-test.pdf', 'cf100000-0000-4000-8000-000000000001');
    insert into public.notifications(id, farm_id, user_id, channel, template, payload)
      values (('cf530000-0000-4000-8000-' || suffix)::uuid, f, 'cf100000-0000-4000-8000-000000000001', 'inapp',
              'job_completed', '{"total_cents":2468}');
  end loop;
end $$;

set role authenticated;
do $$
declare tab text; fields text[]; n bigint; raw_n bigint; blocked boolean; exported jsonb;
begin
  perform _cost_visibility_login('cf100000-0000-4000-8000-000000000001');
  if pg_has_role('authenticated', 'fleetwise_cost_reader', 'MEMBER') then
    raise exception 'COST VISIBILITY FAIL: authenticated can assume the projection owner';
  end if;
  for tab, fields in select * from (values
    ('job_cards', array['parts_total_cents','labour_total_cents','other_total_cents','total_cents']),
    ('job_card_lines', array['unit_cost_cents','rate_cents','total_cents']),
    ('fuel_deliveries', array['price_per_l_cents','doc_url']),
    ('fuel_issues', array['cost_cents','price_per_l_cents']),
    ('parts_catalogue', array['typical_cost_cents']),
    ('service_kit_items', array['unit_cost_cents']),
    ('stock_movements', array['unit_cost_cents']),
    ('work_requests', array['quote_amount_cents','invoice_amount_cents'])
  ) as protected(table_name, columns) loop
    execute format('select count(*) from public.%I where farm_id = $1', tab)
      into raw_n using 'cf000000-0000-4000-8000-000000000002'::uuid;
    execute format('select count(*) from public.%I where farm_id = $1', tab || '_visible')
      into n using 'cf000000-0000-4000-8000-000000000002'::uuid;
    if raw_n = 0 or n <> raw_n then
      raise exception 'COST VISIBILITY FAIL: % projection lost operational rows (% vs %)', tab, n, raw_n;
    end if;
    execute format('select count(*) from public.%I v where farm_id = $1 and jsonb_strip_nulls(to_jsonb(v)) ?| $2', tab || '_visible')
      into n using 'cf000000-0000-4000-8000-000000000002'::uuid, fields;
    if n <> 0 then raise exception 'COST VISIBILITY FAIL: % leaked operator costs', tab; end if;
    execute format('select count(*) from public.%I v where farm_id = $1 and jsonb_strip_nulls(to_jsonb(v)) ?| $2', tab || '_visible')
      into n using 'cf000000-0000-4000-8000-000000000001'::uuid, fields;
    if n = 0 then raise exception 'COST VISIBILITY FAIL: % lost owner costs', tab; end if;
    execute format('select count(*) from public.%I where farm_id = $1', tab || '_visible')
      into n using 'cf000000-0000-4000-8000-000000000003'::uuid;
    if n <> 0 then raise exception 'COST VISIBILITY FAIL: % projection crossed tenant boundary', tab; end if;
    blocked := false;
    begin
      execute format('select %I from public.%I limit 1', fields[1], tab);
    exception when insufficient_privilege then blocked := true;
    end;
    if not blocked then raise exception 'COST VISIBILITY FAIL: raw % financial SELECT allowed', tab; end if;
  end loop;
  if (select qty from public.job_card_lines_visible where id = 'cf410000-0000-4000-8000-000000000002') <> 2
     or (select litres from public.fuel_issues_visible where id = 'cf440000-0000-4000-8000-000000000002') <> 10 then
    raise exception 'COST VISIBILITY FAIL: operational quantity/consumption lost';
  end if;
  if not exists (select 1 from public.attachments where id = 'cf510000-0000-4000-8000-000000000002')
     or exists (select 1 from public.attachments where id = 'cf520000-0000-4000-8000-000000000002') then
    raise exception 'COST VISIBILITY FAIL: photo/invoice disclosure incorrect';
  end if;
  if app.storage_cost_visible('jobcard-photos', 'cf000000-0000-4000-8000-000000000002/cf400000-0000-4000-8000-000000000002/invoice-test.pdf')
     or not app.storage_cost_visible('jobcard-photos', 'cf000000-0000-4000-8000-000000000002/cf400000-0000-4000-8000-000000000002/photo-test.jpg') then
    raise exception 'COST VISIBILITY FAIL: storage financial disclosure incorrect';
  end if;
  if exists (select 1 from public.notifications where id = 'cf530000-0000-4000-8000-000000000002') then
    raise exception 'COST VISIBILITY FAIL: queued message leaks costs after role downgrade';
  end if;
  -- This multi-farm subject is intentionally routed to a FleetWise administrator
  -- by the existing POPIA scope guard. A denial must remain a denial, not a bypass.
  blocked := false;
  begin
    exported := public.export_personal_data(auth.uid());
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'COST VISIBILITY FAIL: multi-farm export scope guard bypassed'; end if;
end $$;
reset role;

-- Exercise the private redaction stage as its owner with the same caller identity.
-- The browser cannot invoke this helper directly; the public export wraps it only
-- after the independently tested subject-access authorization has succeeded.
do $$ declare result jsonb; begin
  result := app.redact_export_financials(jsonb_build_object(
    'job_cards', jsonb_build_array(jsonb_build_object('farm_id','cf000000-0000-4000-8000-000000000002','total_cents',2468)),
    'attachments_created', jsonb_build_array(jsonb_build_object('farm_id','cf000000-0000-4000-8000-000000000002','kind','invoice','parent_type','job_card')),
    'notifications', jsonb_build_array(jsonb_build_object('farm_id','cf000000-0000-4000-8000-000000000002','template','work_request_quoted','payload','{"amount_cents":2468}'::jsonb))
  ));
  if result->'job_cards'->0 ? 'total_cents'
     or jsonb_array_length(result->'attachments_created') <> 0
     or jsonb_array_length(result->'notifications') <> 0 then
    raise exception 'COST VISIBILITY FAIL: export redaction retained restricted costs';
  end if;
end $$;

-- Opting in restores exact financial values through the same operational projection.
update public.farms set settings = '{"cost_visible_to_operators": true}'
 where id = 'cf000000-0000-4000-8000-000000000002';
set role authenticated;
do $$ begin
  perform _cost_visibility_login('cf100000-0000-4000-8000-000000000001');
  if (select total_cents from public.job_cards_visible where id = 'cf400000-0000-4000-8000-000000000002') is distinct from 2468::bigint
     or (select unit_cost_cents from public.service_kit_items_visible where id = 'cf470000-0000-4000-8000-000000000002') is distinct from 1234::bigint then
    raise exception 'COST VISIBILITY FAIL: operator opt-in failed to restore exact costs';
  end if;
end $$;
reset role;

select pg_catalog.set_config('request.jwt.claims', '', false);
select 'ALL OPERATOR COST-CONFIDENTIALITY TESTS PASSED' as result;

rollback;
