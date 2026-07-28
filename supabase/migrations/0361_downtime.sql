-- 0361_downtime.sql
-- Downtime per asset — feature G1 (Scope §23 "downtime per asset").
--
-- "Downtime" = the number of days a machine spent DOWN (status in_workshop or
-- out_of_service) inside a chosen window. There is no dedicated status-history table:
-- the append-only audit_log (0008) already records every machines.status change (the
-- audit trigger writes {old,new} snapshots on each UPDATE and a {new} snapshot on
-- INSERT). We reconstruct each asset's status timeline from those diffs and sum the time
-- spent in a down status, clamped to the window.
--
-- Formula (documented so the app and SQL agree):
--   * status_events = one row per real status change: the machine's INSERT (its initial
--     status) plus every UPDATE where diff.old.status <> diff.new.status.
--   * Each event's status holds from its timestamp until the NEXT event (lead()), or
--     until now() for the final (still-current) status.
--   * A segment counts as downtime when its status is in_workshop / out_of_service.
--   * Each segment is clipped to [p_from 00:00, p_to+1 00:00) and summed in days.
-- Runs SECURITY INVOKER: RLS on audit_log (farm-scoped, 0101) is the isolation guarantor,
-- so a caller only ever reconstructs downtime for machines on farms they can access.

create or replace function app.fleet_downtime(p_from date, p_to date)
returns table (machine_id uuid, down_days numeric)
language sql stable
set search_path = public, pg_temp
as $$
  with status_events as (
    select
      a.entity_id as machine_id,
      a.at        as changed_at,
      coalesce(a.diff -> 'new' ->> 'status', a.diff -> 'old' ->> 'status') as status
    from audit_log a
    where a.entity = 'machines'
      and a.action in ('insert', 'update')
      and (a.diff -> 'new' ->> 'status') is not null
      -- keep the initial insert, and only status-changing updates (ignore reading advances etc.)
      and (
        a.action = 'insert'
        or (a.diff -> 'old' ->> 'status') is distinct from (a.diff -> 'new' ->> 'status')
      )
  ),
  ordered as (
    select
      machine_id,
      changed_at,
      status,
      lead(changed_at) over (partition by machine_id order by changed_at) as next_at
    from status_events
  ),
  windowed as (
    select
      machine_id,
      status,
      greatest(changed_at, p_from::timestamptz)                         as seg_start,
      least(coalesce(next_at, now()), (p_to + 1)::timestamptz)          as seg_end
    from ordered
  )
  select
    machine_id,
    round(sum(extract(epoch from (seg_end - seg_start)) / 86400.0)::numeric, 2) as down_days
  from windowed
  where status in ('in_workshop', 'out_of_service')
    and seg_end > seg_start
  group by machine_id;
$$;

-- Scalar convenience for the machine-detail page (0 when never down in the window).
create or replace function app.machine_downtime_days(p_machine uuid, p_from date, p_to date)
returns numeric
language sql stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select fd.down_days from app.fleet_downtime(p_from, p_to) fd where fd.machine_id = p_machine),
    0
  )::numeric;
$$;

-- ── PostgREST-callable wrappers (public schema; SECURITY INVOKER so RLS still applies) ──
create or replace function public.fleet_downtime(p_from date, p_to date)
returns table (machine_id uuid, down_days numeric)
language sql stable
set search_path = public, pg_temp
as $$
  select * from app.fleet_downtime(p_from, p_to);
$$;

create or replace function public.machine_downtime_days(p_machine uuid, p_from date, p_to date)
returns numeric
language sql stable
set search_path = public, pg_temp
as $$
  select app.machine_downtime_days(p_machine, p_from, p_to);
$$;

-- Least privilege: anon gets nothing; authenticated (RLS-scoped) + service_role (cron) may call.
revoke execute on function app.fleet_downtime(date, date)                from public, anon;
revoke execute on function app.machine_downtime_days(uuid, date, date)   from public, anon;
revoke execute on function public.fleet_downtime(date, date)             from public, anon;
revoke execute on function public.machine_downtime_days(uuid, date, date) from public, anon;
grant  execute on function app.fleet_downtime(date, date)                to authenticated, service_role;
grant  execute on function app.machine_downtime_days(uuid, date, date)   to authenticated, service_role;
grant  execute on function public.fleet_downtime(date, date)             to authenticated, service_role;
grant  execute on function public.machine_downtime_days(uuid, date, date) to authenticated, service_role;
