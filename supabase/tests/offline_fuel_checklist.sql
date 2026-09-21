-- Diesel draws and pre-start checks replay from the offline queue.
--
-- These two are the captures people make where the signal is worst, at the bowser and
-- beside the machine at first light, and until 20260920120000 the queue carried neither.
-- The assertions are about the replay: the same row it would have written online, the same
-- idempotency (a flush that runs twice must not draw the diesel twice), the same
-- authorisation re-checked from live rows, and a failed check still raising its fault a day
-- late.
--
-- App scope only. The public-QR branches of this function cannot run on PGlite, the token
-- lookup fails there for reasons that predate this work, and `atomic_offline_capture.sql`
-- fails identically on a clean checkout.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, settings) values
  ('0f000000-0000-4000-9000-000000000001', 'Offline fuel farm', 'professional', 'active',
   '{"vat_rate_bps": 1500}'::jsonb);

insert into public.workshops (id, name) values
  ('0f600000-0000-4000-9000-000000000001', 'Offline workshop');

insert into auth.users (id, email) values
  ('0f100000-0000-4000-9000-000000000001', 'offline.fuel.operator@example.test'),
  ('0f100000-0000-4000-9000-000000000002', 'offline.fuel.workshop@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('0f100000-0000-4000-9000-000000000001', '0f000000-0000-4000-9000-000000000001',
   'operator', 'Offline operator', 'offline.fuel.operator@example.test');
insert into public.users (id, workshop_id, role, name, email) values
  ('0f100000-0000-4000-9000-000000000002', '0f600000-0000-4000-9000-000000000001',
   'workshop', 'Offline workshop user', 'offline.fuel.workshop@example.test');
insert into public.workshop_links (workshop_id, farm_id, status, see_all_vehicles) values
  ('0f600000-0000-4000-9000-000000000001', '0f000000-0000-4000-9000-000000000001', 'active', true);

insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('0f200000-0000-4000-9000-000000000001', '0f000000-0000-4000-9000-000000000001',
   'Bowser tractor', 'tractor', 'hours', 'active', '0f100000-0000-4000-9000-000000000001'),
  -- Not assigned to the operator: the queue must refuse it on replay, whatever the device
  -- believed when it was last online.
  ('0f200000-0000-4000-9000-000000000002', '0f000000-0000-4000-9000-000000000001',
   'Somebody else''s tractor', 'tractor', 'hours', 'active', null);

insert into public.fuel_tanks (id, farm_id, name) values
  ('0f300000-0000-4000-9000-000000000001', '0f000000-0000-4000-9000-000000000001', 'Main tank');

insert into public.checklist_templates (id, farm_id, name) values
  ('0f400000-0000-4000-9000-000000000001', '0f000000-0000-4000-9000-000000000001', 'Daily pre-start');
insert into public.checklist_template_fields
  (id, template_id, farm_id, sort_order, field_type, label, fail_when, fail_urgency)
values
  ('0f500000-0000-4000-9000-000000000001', '0f400000-0000-4000-9000-000000000001',
   '0f000000-0000-4000-9000-000000000001', 0, 'checkbox', 'Brakes work', 'unchecked', 'stopped');

-- Only the trusted sync route may replay a capture: proved by the grants, not by running
-- as service_role. PGlite does not honour BYPASSRLS, so a capture replayed under that role
-- there sees no rows at all, which is why atomic_offline_capture.sql fails on PGlite and
-- passes in CI. The calls below therefore run as the suite's own role; every check inside
-- the function reads the actor and the machine from live rows, so the logic under test is
-- identical.
do $$
begin
  if has_function_privilege('anon',
       'public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('authenticated',
       'public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)', 'EXECUTE') then
    raise exception 'OFFLINE FAIL: a browser role may replay captures';
  end if;
  if not has_function_privilege('service_role',
       'public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)', 'EXECUTE') then
    raise exception 'OFFLINE FAIL: the sync route may not replay captures';
  end if;
end $$;

-- == (a) A diesel draw replays as the row it would have written online =======
do $$
declare
  v_res jsonb;
  v_issue public.fuel_issues%rowtype;
  v_usage int;
begin
  v_res := public.apply_offline_capture(
    '0f700000-0000-4000-9000-000000000001', now() - interval '2 hours', 'log_fuel', 'app',
    '0f100000-0000-4000-9000-000000000001',
    jsonb_build_object(
      'machine_id', '0f200000-0000-4000-9000-000000000001',
      'tank_id', '0f300000-0000-4000-9000-000000000001',
      'litres', '120',
      'meter_reading', '1450',
      'activity', 'ploughing',
      'cost_incl_cents', '11500'));

  if v_res->>'status' <> 'applied' then
    raise exception 'OFFLINE FUEL FAIL: status was % (%)', v_res->>'status', v_res;
  end if;

  select * into v_issue from public.fuel_issues where id = (v_res->>'entity_id')::uuid;
  if v_issue.litres <> 120 then raise exception 'OFFLINE FUEL FAIL: litres %', v_issue.litres; end if;
  -- R115,00 inclusive at 15% is R100,00 ex-VAT, the same arithmetic as the online command,
  -- now through app.ex_vat_cents rather than a third copy of the expression.
  if v_issue.cost_cents <> 10000 then
    raise exception 'OFFLINE FUEL FAIL: ex-VAT cost % not 10000', v_issue.cost_cents;
  end if;
  if v_issue.vat_rate_bps <> 1500 then
    raise exception 'OFFLINE FUEL FAIL: VAT rate not captured (%)', v_issue.vat_rate_bps;
  end if;
  if v_issue.by_user <> '0f100000-0000-4000-9000-000000000001' then
    raise exception 'OFFLINE FUEL FAIL: the draw lost its author';
  end if;

  select count(*) into v_usage from public.usage_logs
   where machine_id = '0f200000-0000-4000-9000-000000000001' and meter_reading = 1450;
  if v_usage <> 1 then
    raise exception 'OFFLINE FUEL FAIL: % driver-usage rows, expected 1', v_usage;
  end if;

  if not exists (
    select 1 from public.sync_log
     where client_id = '0f700000-0000-4000-9000-000000000001'
       and mutation = 'log_fuel' and status = 'applied'
  ) then
    raise exception 'OFFLINE FUEL FAIL: the capture was not acknowledged in sync_log';
  end if;
end $$;

-- == (b) A second flush of the same capture draws no more diesel =============
do $$
declare v_res jsonb; v_count int;
begin
  v_res := public.apply_offline_capture(
    '0f700000-0000-4000-9000-000000000001', now() - interval '2 hours', 'log_fuel', 'app',
    '0f100000-0000-4000-9000-000000000001',
    jsonb_build_object(
      'machine_id', '0f200000-0000-4000-9000-000000000001',
      'tank_id', '0f300000-0000-4000-9000-000000000001',
      'litres', '120',
      'meter_reading', '1450',
      'activity', 'ploughing',
      'cost_incl_cents', '11500'));
  if coalesce((v_res->>'duplicate')::boolean, false) is not true then
    raise exception 'OFFLINE FUEL FAIL: the replay was not recognised as a duplicate (%)', v_res;
  end if;
  select count(*) into v_count from public.fuel_issues
   where machine_id = '0f200000-0000-4000-9000-000000000001';
  if v_count <> 1 then
    raise exception 'OFFLINE FUEL FAIL: the same draw was recorded % times', v_count;
  end if;
end $$;

-- == (c) A pre-start check replays, and a failed answer still raises a fault =
do $$
declare v_res jsonb; v_values int; v_faults int;
begin
  v_res := public.apply_offline_capture(
    '0f700000-0000-4000-9000-000000000002', now() - interval '6 hours', 'submit_checklist', 'app',
    '0f100000-0000-4000-9000-000000000001',
    jsonb_build_object(
      'machine_id', '0f200000-0000-4000-9000-000000000001',
      'template_id', '0f400000-0000-4000-9000-000000000001',
      'template_name', 'Daily pre-start',
      'meter_reading', '1450',
      'notes', 'captured in the shed',
      'values', jsonb_build_array(
        jsonb_build_object(
          'template_field_id', '0f500000-0000-4000-9000-000000000001',
          'sort_order', 0, 'field_type', 'checkbox', 'label', 'Brakes work',
          'value_text', 'false', 'notes', 'pedal soft')
      )::text));

  if v_res->>'status' <> 'applied' then
    raise exception 'OFFLINE CHECK FAIL: status was % (%)', v_res->>'status', v_res;
  end if;

  select count(*) into v_values from public.checklist_instance_values
   where instance_id = (v_res->>'entity_id')::uuid;
  if v_values <> 1 then
    raise exception 'OFFLINE CHECK FAIL: % answers stored, expected 1', v_values;
  end if;

  select count(*) into v_faults from public.faults
   where checklist_instance_id = (v_res->>'entity_id')::uuid and urgency = 'stopped';
  if v_faults <> 1 then
    raise exception 'OFFLINE CHECK FAIL: the failed answer raised % faults', v_faults;
  end if;

  if not exists (
    select 1 from public.checklist_instances
     where id = (v_res->>'entity_id')::uuid
       and performed_by = '0f100000-0000-4000-9000-000000000001'
       and defects_raised_at is not null
  ) then
    raise exception 'OFFLINE CHECK FAIL: the checklist lost its author or its defect stamp';
  end if;
end $$;

-- == (d) The replay re-checks who may do what, from live rows ================
do $$
declare v_refused int := 0; v_case text; v_before int; v_after int;
begin
  select count(*) into v_before from public.fuel_issues;

  begin  -- an operator, on a machine that is not theirs
    perform public.apply_offline_capture(
      '0f700000-0000-4000-9000-000000000003', now(), 'log_fuel', 'app',
      '0f100000-0000-4000-9000-000000000001',
      jsonb_build_object('machine_id', '0f200000-0000-4000-9000-000000000002',
        'tank_id', '0f300000-0000-4000-9000-000000000001', 'litres', '50'));
    v_case := 'an operator drew diesel for a machine that is not theirs';
  exception when others then v_refused := v_refused + 1;
  end;

  begin  -- a workshop: here for job cards, not for the farm's diesel
    perform public.apply_offline_capture(
      '0f700000-0000-4000-9000-000000000004', now(), 'log_fuel', 'app',
      '0f100000-0000-4000-9000-000000000002',
      jsonb_build_object('machine_id', '0f200000-0000-4000-9000-000000000001',
        'tank_id', '0f300000-0000-4000-9000-000000000001', 'litres', '50'));
    v_case := coalesce(v_case, 'a workshop drew the farm''s diesel');
  exception when others then v_refused := v_refused + 1;
  end;

  begin  -- somebody else's tank
    perform public.apply_offline_capture(
      '0f700000-0000-4000-9000-000000000005', now(), 'log_fuel', 'app',
      '0f100000-0000-4000-9000-000000000001',
      jsonb_build_object('machine_id', '0f200000-0000-4000-9000-000000000001',
        'tank_id', '0f300000-0000-4000-9000-0000000000ff', 'litres', '50'));
    v_case := coalesce(v_case, 'a draw came out of a tank that is not the farm''s');
  exception when others then v_refused := v_refused + 1;
  end;

  begin  -- nonsense litres
    perform public.apply_offline_capture(
      '0f700000-0000-4000-9000-000000000006', now(), 'log_fuel', 'app',
      '0f100000-0000-4000-9000-000000000001',
      jsonb_build_object('machine_id', '0f200000-0000-4000-9000-000000000001',
        'tank_id', '0f300000-0000-4000-9000-000000000001', 'litres', '0'));
    v_case := coalesce(v_case, 'zero litres replayed');
  exception when others then v_refused := v_refused + 1;
  end;

  begin  -- a checklist with no answers is not an inspection
    perform public.apply_offline_capture(
      '0f700000-0000-4000-9000-000000000007', now(), 'submit_checklist', 'app',
      '0f100000-0000-4000-9000-000000000001',
      jsonb_build_object('machine_id', '0f200000-0000-4000-9000-000000000001',
        'template_name', 'Empty', 'values', '[]'));
    v_case := coalesce(v_case, 'an empty checklist replayed');
  exception when others then v_refused := v_refused + 1;
  end;

  if v_case is not null then raise exception 'OFFLINE FAIL: %', v_case; end if;
  if v_refused <> 5 then
    raise exception 'OFFLINE FAIL: expected 5 refusals, counted %', v_refused;
  end if;

  select count(*) into v_after from public.fuel_issues;
  if v_after <> v_before then
    raise exception 'OFFLINE FAIL: a refused replay still wrote % row(s)', v_after - v_before;
  end if;
end $$;

rollback;
