-- 0205_service_notifications.sql
-- Service-due notification engine + weekly digest + stale-meter nudge, plus the
-- public cron wrappers the nightly route calls (Scope §4.3, §4.7).
--
-- Channel is IN-APP only (Stage 1). WhatsApp (Stage 2 / BSP API) is deferred; a
-- later worker maps queued rows to WhatsApp. Retired/sold and soft-deleted machines
-- never enqueue (Scope §4.1). All writer functions are SECURITY DEFINER with EXECUTE
-- revoked from public/anon/authenticated and granted only to service_role — the exact
-- pattern established by 0202/0203. The `app.*` engine lives in the app schema (never
-- reachable via PostgREST); PostgREST-callable `public.cron_*` wrappers front it.

-- ── Dedupe / read / delivery bookkeeping ──────────────────────────
-- service_plan_lines remembers the status it last notified on, so we only fire on a
-- transition (and re-fire weekly while overdue).
alter table service_plan_lines
  add column if not exists notified_status  service_line_status,
  add column if not exists last_notified_at timestamptz;

-- notifications gains read tracking (the in-app centre needs it — none existed) and a
-- quiet-hours delivery gate. deliver_after > now() means "hold until then"; the in-app
-- centre hides such rows until the timestamp passes (see docs/CRON.md).
alter table notifications
  add column if not exists read_at       timestamptz,
  add column if not exists deliver_after timestamptz;

-- Helps the in-app centre list a user's currently-deliverable unread rows cheaply.
create index if not exists notifications_user_unread_idx
  on notifications(user_id, created_at desc)
  where read_at is null and deleted_at is null;

-- ── Quiet hours (Scope §4.7: no non-urgent messages 20:00–05:00 SAST) ──
-- Returns the timestamptz a non-urgent row created *now* should be held until, or NULL
-- if we are outside the farm's quiet window (deliver immediately).
--
-- Settings keys (Africa/Johannesburg). Primary keys match the live settings UI
-- (integer hours): quiet_hours_start (default 20), quiet_hours_end (default 5). The
-- time-string aliases quiet_start/quiet_end are also honoured if present. A window of
-- zero width (start == end) disables quiet hours.
create or replace function app.quiet_deliver_after(p_settings jsonb) returns timestamptz
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_zone     text := 'Africa/Johannesburg';
  v_start    time := coalesce(
                       nullif(p_settings->>'quiet_start', '')::time,
                       make_time(coalesce((p_settings->>'quiet_hours_start')::int, 20), 0, 0));
  v_end      time := coalesce(
                       nullif(p_settings->>'quiet_end', '')::time,
                       make_time(coalesce((p_settings->>'quiet_hours_end')::int, 5), 0, 0));
  v_local_ts timestamp := (now() at time zone v_zone);   -- SAST wall clock
  v_local_t  time := v_local_ts::time;
  v_local_d  date := v_local_ts::date;
  v_in_quiet boolean;
  v_target   timestamp;                                  -- SAST wall clock target
begin
  if v_start = v_end then
    return null;                                         -- quiet hours disabled
  elsif v_start > v_end then
    v_in_quiet := (v_local_t >= v_start) or (v_local_t < v_end);   -- wraps midnight
  else
    v_in_quiet := (v_local_t >= v_start) and (v_local_t < v_end);
  end if;

  if not v_in_quiet then
    return null;
  end if;

  if v_local_t < v_end then
    v_target := v_local_d + v_end;             -- early-morning: later today
  else
    v_target := (v_local_d + 1) + v_end;       -- evening: tomorrow's window end
  end if;
  return (v_target at time zone v_zone);
end $$;

-- ── Notify overload carrying a delivery gate ──────────────────────
-- app.notify_farm(uuid,text,jsonb) from 0203 is UNCHANGED (fault/job triggers still
-- use it). This 4-arg overload adds deliver_after so the enqueue engine can respect
-- quiet hours. Same owner/manager targeting, same in-app channel.
create or replace function app.notify_farm(
  p_farm uuid, p_template text, p_payload jsonb, p_deliver_after timestamptz
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notifications (farm_id, user_id, channel, template, payload, status, deliver_after)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued', p_deliver_after
  from users u
  where u.farm_id = p_farm and u.role in ('owner','manager') and u.active and u.deleted_at is null;
end $$;

-- ── Service due-soon / overdue enqueue (Scope §4.3, §4.7 msgs 1–2) ──
-- For every live line on a live, non-retired/sold machine:
--   * status due_soon|overdue that differs from notified_status → notify + record it.
--   * status overdue already notified but last_notified_at older than 7 days → re-notify
--     (weekly escalation until done) + bump last_notified_at.
--   * status back to ok → silently clear the dedupe marker (no message).
create or replace function app.enqueue_service_notifications() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_template      text;
  v_payload       jsonb;
  v_deliver_after timestamptz;
  v_should_notify boolean;
begin
  for r in
    select spl.id as line_id, spl.farm_id, spl.machine_id, spl.task, spl.status,
           spl.notified_status, spl.last_notified_at,
           spl.next_due_reading, spl.next_due_date,
           m.name as machine_name, f.settings as settings
    from service_plan_lines spl
    join machines m on m.id = spl.machine_id
    join farms    f on f.id = spl.farm_id
    where spl.deleted_at is null
      and m.deleted_at is null
      and m.status not in ('retired','sold')
      and f.deleted_at is null
  loop
    if r.status = 'ok' then
      if r.notified_status is distinct from 'ok' then
        update service_plan_lines
          set notified_status = 'ok', last_notified_at = null
          where id = r.line_id;
      end if;
      continue;
    end if;

    -- status is due_soon or overdue here
    v_should_notify :=
         (r.status is distinct from r.notified_status)
      or (r.status = 'overdue' and r.notified_status = 'overdue'
          and r.last_notified_at is not null
          and r.last_notified_at < now() - interval '7 days');

    if not v_should_notify then
      continue;
    end if;

    v_template := case when r.status = 'overdue' then 'service_overdue' else 'service_due_soon' end;
    v_payload  := jsonb_build_object(
      'line_id',          r.line_id,
      'machine_id',       r.machine_id,
      'machine_name',     r.machine_name,
      'task',             r.task,
      'next_due_reading', r.next_due_reading,
      'next_due_date',    r.next_due_date
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, v_template, v_payload, v_deliver_after);

    update service_plan_lines
      set notified_status = r.status, last_notified_at = now()
      where id = r.line_id;
  end loop;
end $$;

-- ── Stale-meter nudge (Scope §4.3 / §4.7 msg 6) ───────────────────
-- One digest-style 'stale_meter' row per farm listing the machines whose reading is
-- older than the farm's threshold (default 30 days). Metered, non-retired/sold, live
-- machines only. Deduped to at most one per farm per 7 days.
create or replace function app.enqueue_stale_meter_nudges() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_payload       jsonb;
  v_deliver_after timestamptz;
begin
  for r in
    select f.id as farm_id, f.settings,
           jsonb_agg(jsonb_build_object('machine_id', m.id, 'machine_name', m.name)
                     order by m.name) as machines,
           count(*) as stale_count
    from farms f
    join machines m on m.farm_id = f.id
    where f.deleted_at is null
      and f.status in ('trial','active')
      and m.deleted_at is null
      and m.meter_type <> 'none'
      and m.status not in ('retired','sold')
      and (m.current_reading_date is null
           or m.current_reading_date < current_date
              - coalesce((f.settings->>'stale_reading_days')::int,
                         (f.settings->>'stale_meter_days')::int, 30))
    group by f.id, f.settings
  loop
    if exists (
      select 1 from notifications n
      where n.farm_id = r.farm_id and n.template = 'stale_meter'
        and n.created_at > now() - interval '7 days'
    ) then
      continue;                                  -- already nudged this week
    end if;

    v_payload := jsonb_build_object('machines', r.machines, 'count', r.stale_count);
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'stale_meter', v_payload, v_deliver_after);
  end loop;
end $$;

-- ── Weekly digest (Scope §4.7 msg 5) ──────────────────────────────
-- One 'weekly_digest' per active farm: counts + arrays for due-soon / overdue lines,
-- open faults, and machines in the workshop. The CALLER decides it's Monday.
create or replace function app.enqueue_weekly_digest() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_due           jsonb;
  v_overdue       jsonb;
  v_faults        jsonb;
  v_workshop      jsonb;
  v_payload       jsonb;
  v_deliver_after timestamptz;
begin
  for r in
    select f.id as farm_id, f.settings from farms f
    where f.deleted_at is null and f.status in ('trial','active')
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'line_id', spl.id, 'machine_id', spl.machine_id, 'task', spl.task,
             'next_due_reading', spl.next_due_reading, 'next_due_date', spl.next_due_date)), '[]'::jsonb)
      into v_due
      from service_plan_lines spl join machines m on m.id = spl.machine_id
      where spl.farm_id = r.farm_id and spl.deleted_at is null and spl.status = 'due_soon'
        and m.deleted_at is null and m.status not in ('retired','sold');

    select coalesce(jsonb_agg(jsonb_build_object(
             'line_id', spl.id, 'machine_id', spl.machine_id, 'task', spl.task,
             'next_due_reading', spl.next_due_reading, 'next_due_date', spl.next_due_date)), '[]'::jsonb)
      into v_overdue
      from service_plan_lines spl join machines m on m.id = spl.machine_id
      where spl.farm_id = r.farm_id and spl.deleted_at is null and spl.status = 'overdue'
        and m.deleted_at is null and m.status not in ('retired','sold');

    select coalesce(jsonb_agg(jsonb_build_object(
             'fault_id', flt.id, 'machine_id', flt.machine_id,
             'urgency', flt.urgency, 'created_at', flt.created_at)), '[]'::jsonb)
      into v_faults
      from faults flt join machines m on m.id = flt.machine_id
      where flt.farm_id = r.farm_id and flt.deleted_at is null
        and flt.status in ('open','in_job','scheduled')
        and m.deleted_at is null and m.status not in ('retired','sold');

    select coalesce(jsonb_agg(jsonb_build_object('machine_id', m.id, 'machine_name', m.name)), '[]'::jsonb)
      into v_workshop
      from machines m
      where m.farm_id = r.farm_id and m.deleted_at is null and m.status = 'in_workshop';

    v_payload := jsonb_build_object(
      'due_soon_count',    jsonb_array_length(v_due),
      'overdue_count',     jsonb_array_length(v_overdue),
      'open_faults_count', jsonb_array_length(v_faults),
      'in_workshop_count', jsonb_array_length(v_workshop),
      'due_soon',    v_due,
      'overdue',     v_overdue,
      'open_faults', v_faults,
      'in_workshop', v_workshop
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'weekly_digest', v_payload, v_deliver_after);
  end loop;
end $$;

-- ── Lock down the app.* engine (0202/0203 pattern) ────────────────
revoke execute on function app.quiet_deliver_after(jsonb)                    from public, anon, authenticated;
revoke execute on function app.notify_farm(uuid, text, jsonb, timestamptz)   from public, anon, authenticated;
revoke execute on function app.enqueue_service_notifications()               from public, anon, authenticated;
revoke execute on function app.enqueue_stale_meter_nudges()                  from public, anon, authenticated;
revoke execute on function app.enqueue_weekly_digest()                       from public, anon, authenticated;
grant  execute on function app.quiet_deliver_after(jsonb)                    to service_role;
grant  execute on function app.notify_farm(uuid, text, jsonb, timestamptz)   to service_role;
grant  execute on function app.enqueue_service_notifications()               to service_role;
grant  execute on function app.enqueue_stale_meter_nudges()                  to service_role;
grant  execute on function app.enqueue_weekly_digest()                       to service_role;

-- ── PostgREST-callable cron wrappers ──────────────────────────────
-- PostgREST exposes only the `public` schema, so the nightly route (service-role
-- client) calls these thin wrappers, not the app.* functions directly.
create or replace function public.cron_recalc_all_due() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.recalc_all_due(); end $$;

create or replace function public.cron_enqueue_service_notifications() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_service_notifications(); end $$;

create or replace function public.cron_enqueue_stale_meter_nudges() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_stale_meter_nudges(); end $$;

create or replace function public.cron_enqueue_weekly_digest() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_weekly_digest(); end $$;

revoke execute on function
  public.cron_recalc_all_due(),
  public.cron_enqueue_service_notifications(),
  public.cron_enqueue_stale_meter_nudges(),
  public.cron_enqueue_weekly_digest()
from public, anon, authenticated;
grant execute on function
  public.cron_recalc_all_due(),
  public.cron_enqueue_service_notifications(),
  public.cron_enqueue_stale_meter_nudges(),
  public.cron_enqueue_weekly_digest()
to service_role;
