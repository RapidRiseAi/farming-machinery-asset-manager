-- Public QR captures are submitted by trusted server actions with the service-role
-- client. Keep token resolution, validation and every dependent write in one database
-- transaction so a failed usage log (or trigger) can never leave a partial capture.
--
-- These functions are SECURITY INVOKER: they borrow no privilege, are executable only
-- by service_role, and therefore stay off the anonymous PostgREST surface.

create or replace function public.record_public_qr_reading(
  p_token uuid,
  p_reading numeric,
  p_reporter text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_machine_id public.machines.id%type;
  v_farm_id public.farms.id%type;
  v_meter_type public.meter_type;
  v_current_reading public.machines.current_reading%type;
  v_current_date public.machines.current_reading_date%type;
  v_reporter text := nullif(btrim(coalesce(p_reporter, '')), '');
  v_reading_id public.meter_readings.id%type;
begin
  if p_token is null
     or p_reading is null
     or p_reading < 0
     or p_reading > 99999999999.9
     or p_reading <> round(p_reading, 1)
     or char_length(coalesce(v_reporter, '')) > 200 then
    return jsonb_build_object('ok', false, 'error', 'invalid_reading');
  end if;

  select m.id, m.farm_id, m.meter_type, m.current_reading, m.current_reading_date
    into v_machine_id, v_farm_id, v_meter_type, v_current_reading, v_current_date
    from public.machines m
    join public.farms f on f.id = m.farm_id
     and f.deleted_at is null and f.status in ('trial', 'active')
     and app.farm_billing_gate(f.id) = 'ok'
   where m.public_token = p_token
     and m.deleted_at is null
   for update of m;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_meter_type = 'none' then
    return jsonb_build_object('ok', false, 'error', 'invalid_reading');
  end if;
  if (
    select count(*)
      from public.meter_readings r
     where r.machine_id = v_machine_id
       and r.farm_id = v_farm_id
       and r.source = 'qr'
       and r.created_at >= now() - interval '10 minutes'
  ) >= 30 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_current_reading is not null
     and (v_current_date is null or current_date >= v_current_date)
     and p_reading < v_current_reading then
    return jsonb_build_object('ok', false, 'error', 'reading_backwards');
  end if;

  insert into public.meter_readings(
    farm_id, machine_id, reading, reading_date, source, by_user
  ) values (
    v_farm_id, v_machine_id, p_reading, current_date, 'qr', null
  ) returning id into v_reading_id;

  -- app_meter_reading_after advances machines.current_reading and recalculates due
  -- service lines inside this same transaction. If this insert fails, those trigger
  -- writes and the reading above roll back together.
  insert into public.usage_logs(
    farm_id, machine_id, driver_name, occurred_on, meter_reading, source
  ) values (
    v_farm_id, v_machine_id, v_reporter, current_date, p_reading, 'qr'
  );

  return jsonb_build_object('ok', true, 'reading_id', v_reading_id);
end $$;

create or replace function public.record_public_qr_fuel(
  p_token uuid,
  p_litres numeric,
  p_meter_reading numeric,
  p_driver text,
  p_activity text,
  p_cost_incl_cents bigint
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_machine_id public.machines.id%type;
  v_farm_id public.farms.id%type;
  v_meter_type public.meter_type;
  v_current_reading public.machines.current_reading%type;
  v_current_date public.machines.current_reading_date%type;
  v_plan public.farm_plan;
  v_vat_text text;
  v_vat_rate_bps integer := 1500;
  v_driver text := nullif(btrim(coalesce(p_driver, '')), '');
  v_activity text := nullif(btrim(coalesce(p_activity, '')), '');
  v_tank_id public.fuel_tanks.id%type;
  v_issue_id public.fuel_issues.id%type;
  v_cost_ex_cents bigint;
  v_price_per_l_cents bigint;
begin
  if p_token is null
     or p_litres is null
     or p_litres <= 0
     or p_litres > 99999999999.9
     or p_litres <> round(p_litres, 1)
     or (p_meter_reading is not null and (
       p_meter_reading < 0
       or p_meter_reading > 99999999999.9
       or p_meter_reading <> round(p_meter_reading, 1)
     ))
     or p_cost_incl_cents < 0
     or p_cost_incl_cents > 900000000000000000
     or char_length(coalesce(v_driver, '')) > 200
     or (v_activity is not null and v_activity not in (
       'ploughing', 'planting', 'spraying', 'harvesting', 'transport',
       'irrigation', 'generator', 'loading', 'other'
     )) then
    return jsonb_build_object('ok', false, 'error', 'invalid_fuel');
  end if;

  -- Lock both rows. The farm lock serialises default-tank creation for this path; the
  -- machine lock makes the optional meter comparison stable during the capture.
  select m.id, m.farm_id, m.meter_type, m.current_reading, m.current_reading_date,
         f.plan, f.settings ->> 'vat_rate_bps'
    into v_machine_id, v_farm_id, v_meter_type, v_current_reading, v_current_date,
         v_plan, v_vat_text
    from public.machines m
    join public.farms f on f.id = m.farm_id
     and f.deleted_at is null and f.status in ('trial', 'active')
     and app.farm_billing_gate(f.id) = 'ok'
   where m.public_token = p_token
     and m.deleted_at is null
   for update of m, f;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if app.plan_rank(v_plan) < app.feature_min_rank('fuel') then
    return jsonb_build_object('ok', false, 'error', 'upgrade');
  end if;
  if (
    select count(*)
      from public.fuel_issues i
     where i.machine_id = v_machine_id
       and i.farm_id = v_farm_id
       and i.by_user is null
       and i.created_at >= now() - interval '10 minutes'
  ) >= 20 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if p_meter_reading is not null and v_meter_type = 'none' then
    return jsonb_build_object('ok', false, 'error', 'invalid_fuel');
  end if;
  if p_meter_reading is not null
     and v_current_reading is not null
     and (v_current_date is null or current_date >= v_current_date)
     and p_meter_reading < v_current_reading then
    return jsonb_build_object('ok', false, 'error', 'reading_backwards');
  end if;

  if v_vat_text ~ '^[0-9]{1,5}$'
     and v_vat_text::numeric between 0 and 10000 then
    v_vat_rate_bps := v_vat_text::integer;
  end if;
  if p_cost_incl_cents is not null then
    v_cost_ex_cents := round(
      p_cost_incl_cents::numeric * 10000 / (10000 + v_vat_rate_bps)
    )::bigint;
    v_price_per_l_cents := round(v_cost_ex_cents::numeric / p_litres)::bigint;
  end if;

  select t.id
    into v_tank_id
    from public.fuel_tanks t
   where t.farm_id = v_farm_id
     and t.deleted_at is null
   order by t.created_at, t.id
   limit 1;

  if v_tank_id is null then
    insert into public.fuel_tanks(farm_id, name)
      values (v_farm_id, 'Default tank')
      returning id into v_tank_id;
  end if;

  insert into public.fuel_issues(
    farm_id, tank_id, machine_id, date, litres, meter_reading,
    cost_cents, price_per_l_cents, vat_rate_bps, activity, driver_name
  ) values (
    v_farm_id, v_tank_id, v_machine_id, current_date, p_litres, p_meter_reading,
    v_cost_ex_cents, v_price_per_l_cents,
    case when p_cost_incl_cents is null then null else v_vat_rate_bps end,
    v_activity, v_driver
  ) returning id into v_issue_id;

  insert into public.usage_logs(
    farm_id, machine_id, driver_name, occurred_on, meter_reading, source, note
  ) values (
    v_farm_id, v_machine_id, v_driver, current_date, p_meter_reading, 'qr',
    case when v_activity is null then 'Fuel draw (QR)'
         else format('Fuel draw (%s)', v_activity) end
  );

  return jsonb_build_object('ok', true, 'fuel_issue_id', v_issue_id);
end $$;

create or replace function public.record_public_qr_fault(
  p_token uuid,
  p_description text,
  p_urgency public.fault_urgency,
  p_category text,
  p_reporter text,
  p_lat numeric,
  p_lng numeric
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_machine_id public.machines.id%type;
  v_farm_id public.farms.id%type;
  v_fault_id public.faults.id%type;
  v_description text := nullif(btrim(coalesce(p_description, '')), '');
  v_category text := nullif(btrim(coalesce(p_category, '')), '');
  v_reporter text := nullif(btrim(coalesce(p_reporter, '')), '');
begin
  if p_token is null
     or v_description is null
     or char_length(v_description) > 2000
     or p_urgency is null
     or char_length(coalesce(v_category, '')) > 80
     or char_length(coalesce(v_reporter, '')) > 200
     or (p_lat is not null and (p_lat < -90 or p_lat > 90))
     or (p_lng is not null and (p_lng < -180 or p_lng > 180))
     or ((p_lat is null) <> (p_lng is null)) then
    return jsonb_build_object('ok', false, 'error', 'invalid_fault');
  end if;

  select m.id, m.farm_id
    into v_machine_id, v_farm_id
    from public.machines m
    join public.farms f on f.id = m.farm_id
     and f.deleted_at is null and f.status in ('trial', 'active')
     and app.farm_billing_gate(f.id) = 'ok'
   where m.public_token = p_token
     and m.deleted_at is null
   for update of m;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if (
    select count(*)
      from public.faults x
     where x.machine_id = v_machine_id
       and x.farm_id = v_farm_id
       and x.reported_by is null
       and x.created_at >= now() - interval '10 minutes'
  ) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into public.faults(
    farm_id, machine_id, reporter_name, description, category, urgency, status, lat, lng
  ) values (
    v_farm_id, v_machine_id, v_reporter, v_description, v_category, p_urgency,
    'open', p_lat, p_lng
  ) returning id into v_fault_id;

  return jsonb_build_object(
    'ok', true, 'fault_id', v_fault_id, 'farm_id', v_farm_id
  );
end $$;

revoke execute on function public.record_public_qr_reading(uuid, numeric, text)
  from public, anon, authenticated;
revoke execute on function public.record_public_qr_fuel(uuid, numeric, numeric, text, text, bigint)
  from public, anon, authenticated;
revoke execute on function public.record_public_qr_fault(uuid, text, public.fault_urgency, text, text, numeric, numeric)
  from public, anon, authenticated;

grant execute on function public.record_public_qr_reading(uuid, numeric, text)
  to service_role;
grant execute on function public.record_public_qr_fuel(uuid, numeric, numeric, text, text, bigint)
  to service_role;
grant execute on function public.record_public_qr_fault(uuid, text, public.fault_urgency, text, text, numeric, numeric)
  to service_role;
