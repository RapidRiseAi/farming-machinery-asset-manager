-- 0242_fuel_consumption_anomaly.sql
-- Fuel consumption metric (§23: L/hr for hours meters, L/100km for km meters) and the
-- fuel-anomaly notification engine (FR-6.3 / FR-14.2: flag a draw that deviates from the
-- asset's rolling baseline — possible leak/theft). Follows the 0205 pattern exactly:
-- app.* engine (never PostgREST-reachable), EXECUTE revoked from public/anon/authenticated
-- and granted only to service_role, fronted by a public.cron_* wrapper the nightly route
-- calls; retired/sold + soft-deleted machines never enqueue; quiet hours honoured.

-- Dedupe marker so an anomalous issue notifies at most once.
alter table fuel_issues add column if not exists anomaly_notified_at timestamptz;

-- ── Consumption metric (SECURITY INVOKER → RLS applies) ───────────
-- Interval ("brim-to-brim") method: order a machine's metered draws by meter, and for
-- each consecutive pair with a positive meter delta attribute the LATER draw's litres to
-- that interval. Lifetime consumption = Σ interval litres ÷ Σ meter delta. The same
-- method is mirrored client-side in src/lib/fuel.ts so the UI trend and this metric agree.
-- Returns jsonb {unit, litres, meter_span, intervals, consumption (L per meter unit),
-- per_100km (km assets only)}. A cross-farm caller sees no rows under RLS → zeros.
create or replace function app.machine_fuel_consumption(p_machine uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  with mt as (select meter_type from public.machines where id = p_machine),
  ordered as (
    select fi.litres, fi.meter_reading,
           lag(fi.meter_reading) over (order by fi.meter_reading, fi.date, fi.id) as prev_meter
    from public.fuel_issues fi
    where fi.machine_id = p_machine and fi.deleted_at is null
      and fi.meter_reading is not null and fi.litres is not null and fi.litres > 0
  ),
  intervals as (
    select litres, (meter_reading - prev_meter) as md
    from ordered
    where prev_meter is not null and meter_reading - prev_meter > 0
  ),
  agg as (
    select coalesce(sum(litres), 0)::numeric as litres,
           coalesce(sum(md), 0)::numeric     as span,
           count(*)::int                     as n
    from intervals
  )
  select jsonb_build_object(
    'unit',        (select meter_type from mt),
    'litres',      a.litres,
    'meter_span',  a.span,
    'intervals',   a.n,
    'consumption', case when a.span > 0 then round(a.litres / a.span, 4) else null end,
    'per_100km',   case when (select meter_type from mt) = 'km' and a.span > 0
                        then round(a.litres / a.span * 100, 2) else null end
  ) from agg a;
$$;
grant execute on function app.machine_fuel_consumption(uuid) to authenticated, service_role;

-- ── Fuel-anomaly enqueue (Scope §23 / FR-6.3 / FR-14.2) ───────────
-- For each metered draw with enough history, compare its interval consumption to the
-- machine's rolling baseline (mean of ALL prior intervals). If it exceeds the baseline by
-- the farm's threshold (settings.fuel_anomaly_pct, default 50%) and at least
-- settings.fuel_anomaly_min_history intervals of history exist (default 3), enqueue a
-- 'fuel_anomaly' notification to the farm's owner/manager (quiet hours honoured) and mark
-- the draw notified (dedupe). Retired/sold, soft-deleted, and non-metered machines are
-- excluded, matching every other alert (Scope §4.1).
create or replace function app.enqueue_fuel_anomalies() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_payload       jsonb;
  v_deliver_after timestamptz;
begin
  for r in
    with base as (
      select fi.id, fi.farm_id, fi.machine_id, fi.date, fi.litres, fi.meter_reading,
             fi.anomaly_notified_at, m.name as machine_name, m.meter_type, f.settings,
             lag(fi.meter_reading) over w as prev_meter
      from fuel_issues fi
      join machines m on m.id = fi.machine_id
      join farms    f on f.id = fi.farm_id
      where fi.deleted_at is null and fi.machine_id is not null
        and fi.meter_reading is not null and fi.litres is not null and fi.litres > 0
        and m.deleted_at is null and m.status not in ('retired','sold')
        and m.meter_type in ('hours','km')
        and f.deleted_at is null and f.status in ('trial','active')
      window w as (partition by fi.machine_id order by fi.meter_reading, fi.date, fi.id)
    ),
    intervals as (
      select *, litres / (meter_reading - prev_meter) as consumption
      from base
      where prev_meter is not null and meter_reading - prev_meter > 0
    ),
    ranked as (
      select *,
        avg(consumption) over (partition by machine_id order by meter_reading, date, id
             rows between unbounded preceding and 1 preceding) as baseline,
        count(*)         over (partition by machine_id order by meter_reading, date, id
             rows between unbounded preceding and 1 preceding) as prior_n
      from intervals
    )
    select id, farm_id, machine_id, machine_name, meter_type, date, litres, settings,
           consumption, baseline, prior_n
    from ranked
    where anomaly_notified_at is null
      and baseline is not null and baseline > 0
      and prior_n >= coalesce((settings->>'fuel_anomaly_min_history')::int, 3)
      and consumption > baseline * (1 + coalesce((settings->>'fuel_anomaly_pct')::numeric, 50) / 100.0)
  loop
    v_payload := jsonb_build_object(
      'issue_id',    r.id,
      'machine_id',  r.machine_id,
      'machine_name', r.machine_name,
      'unit',        r.meter_type,
      'date',        r.date,
      'litres',      r.litres,
      'consumption', round(r.consumption, 4),
      'baseline',    round(r.baseline, 4),
      'delta_pct',   round((r.consumption / r.baseline - 1) * 100, 0)
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'fuel_anomaly', v_payload, v_deliver_after);
    update fuel_issues set anomaly_notified_at = now() where id = r.id;
  end loop;
end $$;

-- ── Lock down the app.* engine (0205 pattern) ─────────────────────
revoke execute on function app.enqueue_fuel_anomalies() from public, anon, authenticated;
grant  execute on function app.enqueue_fuel_anomalies() to service_role;

-- ── PostgREST-callable cron wrapper ───────────────────────────────
create or replace function public.cron_enqueue_fuel_anomalies() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_fuel_anomalies(); end $$;

revoke execute on function public.cron_enqueue_fuel_anomalies() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_fuel_anomalies() to service_role;
