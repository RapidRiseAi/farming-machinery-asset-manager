-- A mistyped meter reading must be undoable, and a replaced meter must be recordable.
--
-- Section (b) is the trap itself, reproduced: type 12500 where 1250 was meant, and every
-- true reading afterwards is refused as a decrease. Before 20260920100000 there was no way
-- out of it — the RLS policies to update a reading existed, and nothing in the product ever
-- used them. If these assertions ever pass without the correction command, the trap is back.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _meter_login(p_user uuid)
returns void language sql as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _meter_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('ce000000-0000-4000-9000-000000000001', 'Meter farm', 'professional', 'active');

insert into auth.users (id, email) values
  ('ce100000-0000-4000-9000-000000000001', 'meter.owner@example.test'),
  ('ce100000-0000-4000-9000-000000000002', 'meter.operator@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('ce100000-0000-4000-9000-000000000001', 'ce000000-0000-4000-9000-000000000001',
   'owner', 'Meter owner', 'meter.owner@example.test'),
  ('ce100000-0000-4000-9000-000000000002', 'ce000000-0000-4000-9000-000000000001',
   'operator', 'Meter operator', 'meter.operator@example.test');

insert into public.machines
  (id, farm_id, name, type, meter_type, status, assigned_operator_id, current_reading, current_reading_date)
values
  ('ce200000-0000-4000-9000-000000000001', 'ce000000-0000-4000-9000-000000000001',
   'Trap tractor', 'tractor', 'hours', 'active', 'ce100000-0000-4000-9000-000000000002',
   1200, current_date - 10),
  ('ce200000-0000-4000-9000-000000000002', 'ce000000-0000-4000-9000-000000000001',
   'Meterless pump', 'pump_generator', 'none', 'active', null, null, null);

insert into public.meter_readings (id, farm_id, machine_id, reading, reading_date, source) values
  ('ce300000-0000-4000-9000-000000000001', 'ce000000-0000-4000-9000-000000000001',
   'ce200000-0000-4000-9000-000000000001', 1200, current_date - 10, 'manual');

insert into public.service_plan_lines
  (id, farm_id, machine_id, task, interval_hours, last_done_reading, last_done_date)
values
  ('ce400000-0000-4000-9000-000000000001', 'ce000000-0000-4000-9000-000000000001',
   'ce200000-0000-4000-9000-000000000001', 'Engine oil', 250, 1100, current_date - 20);

-- ── (a) Both commands are reachable, invoker-rights and named as the app calls them ──
do $$
declare r record; v_args text;
begin
  for r in
    select 'correct_meter_reading' as name,
           'public.correct_meter_reading(uuid,uuid,uuid,text)' as sig
    union all
    select 'record_meter_replacement',
           'public.record_meter_replacement(uuid,uuid,numeric,date,text)'
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = r.name
    ) then
      raise exception 'METER FAIL: % does not exist', r.name;
    end if;
    -- `record_meter_replacement` does one INSERT, so RLS decides and it must stay INVOKER.
    -- `correct_meter_reading` sets deleted_at, which makes the row invisible to the SELECT
    -- policy — Postgres refuses that update — so it is DEFINER with the role check written
    -- out instead, and section (d) proves the check holds.
    if r.name = 'record_meter_replacement'
       and (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = r.name) then
      raise exception 'METER FAIL: % is SECURITY DEFINER; RLS must decide who may rebase', r.name;
    end if;
    if (select p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = r.name) is null then
      raise exception 'METER FAIL: % has no pinned search_path', r.name;
    end if;
    if has_function_privilege('anon', r.sig, 'EXECUTE') then
      raise exception 'METER FAIL: anon may execute %', r.name;
    end if;
    if not has_function_privilege('authenticated', r.sig, 'EXECUTE') then
      raise exception 'METER FAIL: authenticated may not execute %', r.name;
    end if;
  end loop;

  -- PostgREST resolves by parameter NAME.
  select pg_get_function_arguments(p.oid) into v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'correct_meter_reading';
  if v_args not like 'p_farm %' or v_args not like '%p_machine %'
     or v_args not like '%p_reading %' or v_args not like '%p_reason %' then
    raise exception 'METER FAIL: correct_meter_reading parameter names changed (%)', v_args;
  end if;
  select pg_get_function_arguments(p.oid) into v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'record_meter_replacement';
  if v_args not like 'p_farm %' or v_args not like '%p_machine %'
     or v_args not like '%p_new_reading %' or v_args not like '%p_replaced_on %'
     or v_args not like '%p_note %' then
    raise exception 'METER FAIL: record_meter_replacement parameter names changed (%)', v_args;
  end if;
end $$;

create temporary table _meter_ids (label text, id uuid);
grant all on table _meter_ids to public;

set role authenticated;

-- ── (b) The trap, and the way out ───────────────────────────────────────────
do $$
declare
  v_bad uuid;
  v_blocked boolean := false;
  v_current numeric;
  v_ok uuid;
begin
  perform _meter_login('ce100000-0000-4000-9000-000000000001');

  -- The typo: 12500 where 1250 was meant.
  v_bad := public.record_meter_reading(
    'ce000000-0000-4000-9000-000000000001',
    'ce200000-0000-4000-9000-000000000001',
    12500, current_date - 1, null);

  select current_reading into v_current from public.machines
   where id = 'ce200000-0000-4000-9000-000000000001';
  if v_current <> 12500 then
    raise exception 'METER FAIL: the typo did not take (%), so the rest proves nothing', v_current;
  end if;

  -- Every true reading afterwards is refused. This is the trap.
  begin
    perform public.record_meter_reading(
      'ce000000-0000-4000-9000-000000000001',
      'ce200000-0000-4000-9000-000000000001',
      1260, current_date, null);
  exception when others then v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'METER FAIL: a decreasing reading was accepted; the guard is gone';
  end if;

  -- The way out.
  v_current := public.correct_meter_reading(
    p_farm => 'ce000000-0000-4000-9000-000000000001',
    p_machine => 'ce200000-0000-4000-9000-000000000001',
    p_reading => v_bad,
    p_reason => 'Typed 12500 for 1250');
  if v_current <> 1200 then
    raise exception 'METER FAIL: after the correction the machine reads % not 1200', v_current;
  end if;

  select current_reading into v_current from public.machines
   where id = 'ce200000-0000-4000-9000-000000000001';
  if v_current <> 1200 then
    raise exception 'METER FAIL: the machine still reads % after the correction', v_current;
  end if;

  -- Checked after `reset role` below: a voided reading is invisible to every farm role,
  -- because `meter_readings_sel` requires `deleted_at is null`. The row itself survives.
  insert into _meter_ids(label, id) values ('voided', v_bad);

  -- And the true reading is accepted again.
  v_ok := public.record_meter_reading(
    'ce000000-0000-4000-9000-000000000001',
    'ce200000-0000-4000-9000-000000000001',
    1260, current_date, null);
  if v_ok is null then raise exception 'METER FAIL: the farm is still stuck'; end if;
end $$;

-- ── (c) The service plan is recalculated, not left on the typo ──────────────
do $$
declare v_due numeric;
begin
  perform _meter_login('ce100000-0000-4000-9000-000000000001');
  select next_due_reading into v_due from public.service_plan_lines
   where id = 'ce400000-0000-4000-9000-000000000001';
  -- Last done at 1 100 with a 250-hour interval: due at 1 350, whatever the typo said.
  if v_due is distinct from 1350 then
    raise exception 'METER FAIL: next due is % not 1350', v_due;
  end if;
end $$;

-- ── (d) Crew roles capture readings; they do not correct them ───────────────
do $$
declare v_refused boolean := false; v_id uuid;
begin
  perform _meter_login('ce100000-0000-4000-9000-000000000002');   -- the operator
  select id into v_id from public.meter_readings
   where machine_id = 'ce200000-0000-4000-9000-000000000001' and deleted_at is null
   order by reading_date desc limit 1;

  begin
    perform public.correct_meter_reading(
      p_farm => 'ce000000-0000-4000-9000-000000000001',
      p_machine => 'ce200000-0000-4000-9000-000000000001',
      p_reading => v_id, p_reason => 'not mine to correct');
  exception when others then v_refused := true;
  end;
  if not v_refused then
    raise exception 'METER FAIL: an operator corrected a reading';
  end if;
  if not exists (select 1 from public.meter_readings where id = v_id and deleted_at is null) then
    raise exception 'METER FAIL: the refused correction still voided the row';
  end if;
end $$;

-- ── (e) A replaced meter starts again, and the schedule comes with it ───────
do $$
declare
  v_id uuid;
  v_current numeric;
  v_last numeric;
  v_due numeric;
  v_ok uuid;
begin
  perform _meter_login('ce100000-0000-4000-9000-000000000001');

  -- The machine reads 1 260. A new hour meter goes on and starts at zero.
  v_id := public.record_meter_replacement(
    p_farm => 'ce000000-0000-4000-9000-000000000001',
    p_machine => 'ce200000-0000-4000-9000-000000000001',
    p_new_reading => 0,
    p_replaced_on => current_date,
    p_note => 'New hour meter fitted');
  if v_id is null then raise exception 'METER FAIL: the replacement was not recorded'; end if;

  select current_reading into v_current from public.machines
   where id = 'ce200000-0000-4000-9000-000000000001';
  if v_current <> 0 then
    raise exception 'METER FAIL: after the replacement the machine reads % not 0', v_current;
  end if;

  if not exists (
    select 1 from public.meter_replacements
     where id = v_id and previous_reading = 1260 and new_reading = 0
  ) then
    raise exception 'METER FAIL: the replacement did not keep both sides of the change';
  end if;

  -- The 250-hour line was last done at 1 100 on a meter that read 1 260: 160 hours ago.
  -- On the new meter that is "−160", floored at 0, so it is due again at 250.
  select last_done_reading, next_due_reading into v_last, v_due
    from public.service_plan_lines where id = 'ce400000-0000-4000-9000-000000000001';
  if v_last <> 0 then
    raise exception 'METER FAIL: the service line was not rebased (last done %)', v_last;
  end if;
  if v_due is distinct from 250 then
    raise exception 'METER FAIL: next due is % not 250 after the meter changed', v_due;
  end if;

  -- A reading on the new meter is accepted, where before it would have been a "decrease".
  v_ok := public.record_meter_reading(
    'ce000000-0000-4000-9000-000000000001',
    'ce200000-0000-4000-9000-000000000001',
    5, current_date, null);
  if v_ok is null then raise exception 'METER FAIL: the new meter cannot be read'; end if;
end $$;

-- ── (f) Correcting an old reading cannot resurrect the meter that was replaced ──
do $$
declare v_old uuid; v_current numeric;
begin
  perform _meter_login('ce100000-0000-4000-9000-000000000001');
  select id into v_old from public.meter_readings
   where machine_id = 'ce200000-0000-4000-9000-000000000001'
     and reading = 1260 and deleted_at is null;

  perform public.correct_meter_reading(
    p_farm => 'ce000000-0000-4000-9000-000000000001',
    p_machine => 'ce200000-0000-4000-9000-000000000001',
    p_reading => v_old, p_reason => 'also wrong, as it happens');

  select current_reading into v_current from public.machines
   where id = 'ce200000-0000-4000-9000-000000000001';
  -- The 5 on the NEW meter stands. The old instrument's hours are history.
  if v_current <> 5 then
    raise exception 'METER FAIL: the old meter came back (machine reads %)', v_current;
  end if;
end $$;

-- ── (g) Replacements are refused where they make no sense ───────────────────
do $$
declare v_refused int := 0; v_case text;
begin
  perform _meter_login('ce100000-0000-4000-9000-000000000001');

  begin  -- a machine that keeps no meter
    perform public.record_meter_replacement(
      p_farm => 'ce000000-0000-4000-9000-000000000001',
      p_machine => 'ce200000-0000-4000-9000-000000000002',
      p_new_reading => 0, p_replaced_on => current_date, p_note => null);
    v_case := 'a meterless machine had its meter replaced';
  exception when others then v_refused := v_refused + 1;
  end;

  begin  -- dated in the future
    perform public.record_meter_replacement(
      p_farm => 'ce000000-0000-4000-9000-000000000001',
      p_machine => 'ce200000-0000-4000-9000-000000000001',
      p_new_reading => 0, p_replaced_on => current_date + 1, p_note => null);
    v_case := coalesce(v_case, 'a replacement was dated in the future');
  exception when others then v_refused := v_refused + 1;
  end;

  begin  -- a negative starting reading
    perform public.record_meter_replacement(
      p_farm => 'ce000000-0000-4000-9000-000000000001',
      p_machine => 'ce200000-0000-4000-9000-000000000001',
      p_new_reading => -1, p_replaced_on => current_date, p_note => null);
    v_case := coalesce(v_case, 'a negative starting reading was accepted');
  exception when others then v_refused := v_refused + 1;
  end;

  perform _meter_login('ce100000-0000-4000-9000-000000000002');
  begin  -- an operator
    perform public.record_meter_replacement(
      p_farm => 'ce000000-0000-4000-9000-000000000001',
      p_machine => 'ce200000-0000-4000-9000-000000000001',
      p_new_reading => 0, p_replaced_on => current_date, p_note => null);
    v_case := coalesce(v_case, 'an operator rebased a machine');
  exception when others then v_refused := v_refused + 1;
  end;

  if v_case is not null then raise exception 'METER FAIL: %', v_case; end if;
  if v_refused <> 4 then
    raise exception 'METER FAIL: expected 4 refusals, counted %', v_refused;
  end if;
end $$;

reset role;

-- ── (h) A correction is a void, not a delete ────────────────────────────────
do $$
declare v_id uuid;
begin
  select id into v_id from _meter_ids where label = 'voided';
  if not exists (
    select 1 from public.meter_readings
     where id = v_id
       and deleted_at is not null
       and deleted_by = 'ce100000-0000-4000-9000-000000000001'
       and voided_reason = 'Typed 12500 for 1250'
  ) then
    raise exception 'METER FAIL: the voided reading, its reason or its author is gone';
  end if;
end $$;

rollback;
