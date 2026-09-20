-- A failed pre-start answer must become a fault, once.
--
-- Checklists recorded answers and nothing followed them: a driver could tick "Brakes: no"
-- and the farm learned about it when something went wrong. `record_checklist_defects`
-- (20260920110000) opens one fault per failed answer, and `defects_raised_at` is what stops
-- a retried submit or an offline replay opening the same broken brake twice.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _defect_login(p_user uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
$$;
grant execute on function _defect_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('da000000-0000-4000-9000-000000000001', 'Defect farm', 'professional', 'active');

insert into auth.users (id, email) values
  ('da100000-0000-4000-9000-000000000001', 'defect.operator@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('da100000-0000-4000-9000-000000000001', 'da000000-0000-4000-9000-000000000001',
   'operator', 'Defect operator', 'defect.operator@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('da200000-0000-4000-9000-000000000001', 'da000000-0000-4000-9000-000000000001',
   'Checked tractor', 'tractor', 'hours', 'active', 'da100000-0000-4000-9000-000000000001');

insert into public.checklist_templates (id, farm_id, name) values
  ('da300000-0000-4000-9000-000000000001', 'da000000-0000-4000-9000-000000000001', 'Daily pre-start');

-- Four fields: two that can fail, one that fails the other way round, one with no rule.
insert into public.checklist_template_fields
  (id, template_id, farm_id, sort_order, field_type, label, fail_when, fail_threshold, fail_urgency)
values
  ('da400000-0000-4000-9000-000000000001', 'da300000-0000-4000-9000-000000000001',
   'da000000-0000-4000-9000-000000000001', 0, 'checkbox', 'Brakes work', 'unchecked', null, 'stopped'),
  ('da400000-0000-4000-9000-000000000002', 'da300000-0000-4000-9000-000000000001',
   'da000000-0000-4000-9000-000000000001', 1, 'checkbox', 'Oil leak seen', 'checked', null, 'limping'),
  ('da400000-0000-4000-9000-000000000003', 'da300000-0000-4000-9000-000000000001',
   'da000000-0000-4000-9000-000000000001', 2, 'number', 'Tread depth mm', 'below', 3, 'limping'),
  ('da400000-0000-4000-9000-000000000004', 'da300000-0000-4000-9000-000000000001',
   'da000000-0000-4000-9000-000000000001', 3, 'text', 'Anything else', null, null, null);

set role authenticated;

-- ── (a) A completed checklist with three bad answers opens three faults ─────
do $$
declare v_raised int; v_faults int; v_stopped int;
begin
  perform _defect_login('da100000-0000-4000-9000-000000000001');

  insert into public.checklist_instances
    (id, farm_id, machine_id, template_id, template_name, status, performed_by, completed_at, created_by)
  values
    ('da500000-0000-4000-9000-000000000001', 'da000000-0000-4000-9000-000000000001',
     'da200000-0000-4000-9000-000000000001', 'da300000-0000-4000-9000-000000000001',
     'Daily pre-start', 'completed', 'da100000-0000-4000-9000-000000000001', now(),
     'da100000-0000-4000-9000-000000000001');

  insert into public.checklist_instance_values
    (farm_id, instance_id, template_field_id, sort_order, field_type, label, value_text, notes)
  values
    -- Brakes NOT ticked: a defect, and a serious one.
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000001',
     'da400000-0000-4000-9000-000000000001', 0, 'checkbox', 'Brakes work', 'false', 'pedal goes to the floor'),
    -- Oil leak ticked: a defect the other way round.
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000001',
     'da400000-0000-4000-9000-000000000002', 1, 'checkbox', 'Oil leak seen', 'true', null),
    -- Tread below the threshold.
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000001',
     'da400000-0000-4000-9000-000000000003', 2, 'number', 'Tread depth mm', '2', null),
    -- No rule: never a defect, whatever it says.
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000001',
     'da400000-0000-4000-9000-000000000004', 3, 'text', 'Anything else', 'sounds rough', null);

  v_raised := public.record_checklist_defects('da500000-0000-4000-9000-000000000001');
  if v_raised <> 3 then
    raise exception 'DEFECT FAIL: % faults raised, expected 3', v_raised;
  end if;

  select count(*) into v_faults from public.faults
   where checklist_instance_id = 'da500000-0000-4000-9000-000000000001';
  if v_faults <> 3 then
    raise exception 'DEFECT FAIL: % faults on the machine, expected 3', v_faults;
  end if;

  -- The urgency comes from the rule, so "brakes" does not arrive as "can still work".
  select count(*) into v_stopped from public.faults
   where checklist_instance_id = 'da500000-0000-4000-9000-000000000001'
     and urgency = 'stopped';
  if v_stopped <> 1 then
    raise exception 'DEFECT FAIL: the brake defect did not carry its urgency';
  end if;

  -- The fault reads like the inspection, and keeps what the driver wrote.
  if not exists (
    select 1 from public.faults
     where checklist_instance_id = 'da500000-0000-4000-9000-000000000001'
       and description = 'Daily pre-start — Brakes work: pedal goes to the floor'
  ) then
    raise exception 'DEFECT FAIL: the fault does not name the checklist, field and note';
  end if;
end $$;

-- ── (b) Running it again raises nothing — offline replay and retries ────────
do $$
declare v_again int; v_faults int;
begin
  perform _defect_login('da100000-0000-4000-9000-000000000001');
  v_again := public.record_checklist_defects('da500000-0000-4000-9000-000000000001');
  if v_again <> 0 then
    raise exception 'DEFECT FAIL: a second run raised % more faults', v_again;
  end if;
  select count(*) into v_faults from public.faults
   where checklist_instance_id = 'da500000-0000-4000-9000-000000000001';
  if v_faults <> 3 then
    raise exception 'DEFECT FAIL: the same defects were raised twice (% faults)', v_faults;
  end if;
end $$;

-- ── (c) A draft is not an inspection yet ────────────────────────────────────
do $$
declare v_raised int;
begin
  perform _defect_login('da100000-0000-4000-9000-000000000001');
  insert into public.checklist_instances
    (id, farm_id, machine_id, template_id, template_name, status, performed_by, created_by)
  values
    ('da500000-0000-4000-9000-000000000002', 'da000000-0000-4000-9000-000000000001',
     'da200000-0000-4000-9000-000000000001', 'da300000-0000-4000-9000-000000000001',
     'Daily pre-start', 'draft', 'da100000-0000-4000-9000-000000000001',
     'da100000-0000-4000-9000-000000000001');
  insert into public.checklist_instance_values
    (farm_id, instance_id, template_field_id, sort_order, field_type, label, value_text)
  values
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000002',
     'da400000-0000-4000-9000-000000000001', 0, 'checkbox', 'Brakes work', 'false');

  v_raised := public.record_checklist_defects('da500000-0000-4000-9000-000000000002');
  if v_raised <> 0 then
    raise exception 'DEFECT FAIL: a draft raised % faults', v_raised;
  end if;
end $$;

-- ── (d) A clean inspection raises nothing at all ────────────────────────────
do $$
declare v_raised int;
begin
  perform _defect_login('da100000-0000-4000-9000-000000000001');
  insert into public.checklist_instances
    (id, farm_id, machine_id, template_id, template_name, status, performed_by, completed_at, created_by)
  values
    ('da500000-0000-4000-9000-000000000003', 'da000000-0000-4000-9000-000000000001',
     'da200000-0000-4000-9000-000000000001', 'da300000-0000-4000-9000-000000000001',
     'Daily pre-start', 'completed', 'da100000-0000-4000-9000-000000000001', now(),
     'da100000-0000-4000-9000-000000000001');
  insert into public.checklist_instance_values
    (farm_id, instance_id, template_field_id, sort_order, field_type, label, value_text)
  values
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000003',
     'da400000-0000-4000-9000-000000000001', 0, 'checkbox', 'Brakes work', 'true'),
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000003',
     'da400000-0000-4000-9000-000000000002', 1, 'checkbox', 'Oil leak seen', 'false'),
    ('da000000-0000-4000-9000-000000000001', 'da500000-0000-4000-9000-000000000003',
     'da400000-0000-4000-9000-000000000003', 2, 'number', 'Tread depth mm', '7');

  v_raised := public.record_checklist_defects('da500000-0000-4000-9000-000000000003');
  if v_raised <> 0 then
    raise exception 'DEFECT FAIL: a clean checklist raised % faults', v_raised;
  end if;
end $$;

-- ── (e) It cannot reach another farm's checklist ────────────────────────────
do $$
declare v_raised int;
begin
  perform _defect_login('da100000-0000-4000-9000-000000000001');
  -- A checklist id that this person cannot see resolves to nothing, not to a fault on
  -- somebody else's machine. RLS does that: the function is SECURITY INVOKER.
  v_raised := public.record_checklist_defects('da500000-0000-4000-9000-0000000000ff');
  if v_raised <> 0 then
    raise exception 'DEFECT FAIL: an unreachable checklist raised %', v_raised;
  end if;
end $$;

reset role;

rollback;
