-- 20260920090000_atomic_fuel_issue.sql
-- A fuel draw and the driver-usage log it implies, written in ONE transaction.
--
-- WHY
-- =============================================================================
-- `src/app/(app)/fuel/actions.ts` inserted the issue, then inserted the usage log and
-- never read the second result. A failure there was invisible: the litres and the cost
-- were recorded, the driver's utilisation history silently was not, and nothing said so.
-- The 11 September 2026 audit listed it as a known limitation ("Normal in-app fuel issue
-- and usage-log writes are still separate"), and it survived because nothing failed
-- loudly enough to be noticed.
--
-- The PUBLIC QR path has had an atomic command since 20260903143000
-- (`record_public_qr_fuel`). This gives the authenticated path the same guarantee, in the
-- same shape as `record_meter_reading` (20260903074034): SECURITY INVOKER so RLS still
-- decides every row, the role checked against `app.effective_farm_role` rather than
-- against whatever the page chose to render, and the plan gate re-checked in the database
-- so a caller that skips the TypeScript gate is still refused.
--
-- WHAT IT DELIBERATELY DOES NOT CHANGE
-- =============================================================================
-- A fuel draw does NOT advance `machines.current_reading`; only meter readings and job
-- cards do that, and the QR fuel path behaves the same way. The meter on a draw is
-- evidence for consumption (litres per hour) and for the usage log, and quietly making it
-- a meter reading here would change every machine's service-due arithmetic.
--
-- VAT is computed from the farm's own rate with the identical expression the QR path uses,
-- which is also `exVatCents` in `src/lib/money.ts`:
--   round(incl * 10000 / (10000 + rate)). Money stays ex-VAT cents with the rate captured.

create or replace function public.record_fuel_issue(
  p_farm uuid,
  p_tank uuid,
  p_machine uuid default null,
  p_date date default current_date,
  p_litres numeric default null,
  p_meter numeric default null,
  p_cost_incl_cents bigint default null,
  p_activity text default null,
  p_driver_user uuid default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
  v_role user_role;
  v_driver uuid := auth.uid();
  v_plan farm_plan;
  v_vat_text text;
  v_vat_rate_bps integer := 1500;
  v_activity text := nullif(btrim(coalesce(p_activity, '')), '');
  v_meter_type meter_type;
  v_cost_ex_cents bigint;
  v_price_per_l_cents bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null
     or v_role not in ('rr_admin','owner','manager','mechanic','operator') then
    raise exception 'This person may not record a fuel draw.' using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;

  if p_litres is null or p_litres <= 0 or p_litres > 99999999999.9 then
    raise exception 'A valid number of litres is required.' using errcode = '22023';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'A fuel draw cannot be dated in the future.' using errcode = '22023';
  end if;
  if p_meter is not null and (p_meter < 0 or p_meter > 99999999999.9) then
    raise exception 'A valid non-negative meter reading is required.' using errcode = '22023';
  end if;
  if p_cost_incl_cents is not null
     and (p_cost_incl_cents < 0 or p_cost_incl_cents > 900000000000000000) then
    raise exception 'A valid cost is required.' using errcode = '22023';
  end if;
  if v_activity is not null and v_activity not in (
       'ploughing', 'planting', 'spraying', 'harvesting', 'transport',
       'irrigation', 'generator', 'loading', 'other'
     ) then
    raise exception 'That is not a fuel activity.' using errcode = '22023';
  end if;

  -- The plan gate, in the database. `requireEntitlement("fuel")` in the action is the
  -- courtesy; this is the rule. Same comparison the QR path makes.
  -- Read, never FOR UPDATE. A row lock on `farms` needs UPDATE privilege and puts the
  -- farm's UPDATE policy in the way, which would refuse the operator recording a draw -
  -- and nothing here reads-then-writes the farm. The QR path locks because it may have to
  -- create a default tank; this path is given its tank.
  select f.plan, f.settings ->> 'vat_rate_bps'
    into v_plan, v_vat_text
    from public.farms f
   where f.id = p_farm
     and f.deleted_at is null;
  if not found then
    raise exception 'Farm not found.' using errcode = '42501';
  end if;
  if app.plan_rank(v_plan) < app.feature_min_rank('fuel') then
    raise exception 'This farm''s plan does not include fuel.' using errcode = '42501';
  end if;

  -- The tank must be this farm's. RLS would refuse another farm's row anyway; this says so
  -- with a sentence instead of a constraint violation.
  perform 1
     from public.fuel_tanks t
    where t.id = p_tank
      and t.farm_id = p_farm
      and t.deleted_at is null;
  if not found then
    raise exception 'Fuel tank not found.' using errcode = '42501';
  end if;

  if p_machine is not null then
    select m.meter_type
      into v_meter_type
      from public.machines m
     where m.id = p_machine
       and m.farm_id = p_farm
       and m.deleted_at is null
       and app.row_visible_to_role(p_farm, p_machine);
    if not found then
      raise exception 'Machine not found or not visible to this person.'
        using errcode = '42501';
    end if;
    if p_meter is not null and v_meter_type = 'none' then
      raise exception 'That machine does not keep a meter reading.' using errcode = '22023';
    end if;
  elsif p_meter is not null then
    raise exception 'A meter reading needs a machine.' using errcode = '22023';
  end if;

  -- Same access-scoped helper the meter-reading command uses: a caller may not SELECT
  -- another teammate's membership row to find this out.
  if p_driver_user is not null and app.user_belongs_to_farm(p_driver_user, p_farm) then
    v_driver := p_driver_user;
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

  insert into public.fuel_issues(
    farm_id, tank_id, machine_id, date, litres, meter_reading,
    cost_cents, price_per_l_cents, vat_rate_bps, activity, by_user
  ) values (
    p_farm, p_tank, p_machine, p_date, p_litres, p_meter,
    v_cost_ex_cents, v_price_per_l_cents,
    case when p_cost_incl_cents is null then null else v_vat_rate_bps end,
    v_activity, auth.uid()
  ) returning id into v_id;

  -- Only where the draw names a machine AND a meter: the same condition the action
  -- applied, kept so this changes atomicity and nothing else.
  if p_machine is not null and p_meter is not null then
    insert into public.usage_logs(
      farm_id, machine_id, driver_user_id, occurred_on, meter_reading, source, note
    ) values (
      p_farm, p_machine, v_driver, p_date, p_meter, 'app',
      case when v_activity is null then 'Fuel draw'
           else format('Fuel draw (%s)', v_activity) end
    );
  end if;

  return v_id;
end $$;

revoke execute on function public.record_fuel_issue(
  uuid, uuid, uuid, date, numeric, numeric, bigint, text, uuid
) from public, anon;
grant execute on function public.record_fuel_issue(
  uuid, uuid, uuid, date, numeric, numeric, bigint, text, uuid
) to authenticated, service_role;

comment on function public.record_fuel_issue(
  uuid, uuid, uuid, date, numeric, numeric, bigint, text, uuid
) is
  'Records one fuel draw and, when it names a machine and a meter, the driver-usage log '
  'that goes with it, in a single transaction. Replaces two separate inserts in '
  'fuel/actions.ts whose second result was never checked.';
