-- 20261119100000_scheduled_work_by_plan.sql
-- Scheduled work after a downgrade or a stopped subscription, and the weekly digest once a
-- week (task B3; BRIEF sections 6 and 19, scenario 40).
--
--  1. AARTO nomination reminders went to every active farm with a fine waiting, whatever its
--     plan. AARTO is Complete (decision 37: after a downgrade saved fines stay readable, but
--     the tool is not used anew), and a business paused for payment is "pay and download
--     only". Reminders now go only where the plan includes AARTO and the business is open.
--
--  2. The weekly digest was enqueued by whatever nightly run happened on a Monday: a rerun
--     that Monday sent it twice, and a Monday whose run failed sent nothing for a week. It
--     now goes once per business per week (Monday 00:00 South African time onward), whichever
--     run gets there first; the nightly route asks on Monday to Wednesday, so a missed Monday
--     catches up. A business that is not open (pending, suspended, closed) gets none.
--
-- Both are CREATE OR REPLACE of service-role functions with the same signatures; no table
-- changes, no data touched.

create or replace function app.enqueue_aarto_nomination_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_status        expiry_status;
  v_payload       jsonb;
  v_deliver_after timestamptz;
  v_should        boolean;
begin
  for r in
    select fn.id, fn.farm_id, fn.machine_id, fn.notice_number, fn.authority, fn.offence,
           fn.offence_date, fn.nomination_deadline, fn.status,
           fn.nomination_notified_status as notified_status, fn.nomination_notified_at as last_notified_at,
           m.name as machine_name, f.settings
    from fines fn
    join machines m on m.id = fn.machine_id
    join farms    f on f.id = fn.farm_id
    where fn.deleted_at is null
      and fn.nomination_deadline is not null
      and fn.status in ('received','driver_identified')   -- still needs a nomination
      and m.deleted_at is null and m.status not in ('retired','sold')
      and f.deleted_at is null and f.status in ('trial','active')
      -- B3: the plan includes AARTO, and the business is open.
      and app.farm_plan_allows(f.id, 'aarto')
      and app.farm_billing_gate(f.id) = 'ok'
  loop
    v_status := app.expiry_status_of(
      r.nomination_deadline,
      coalesce((r.settings->>'aarto_nomination_lead_days')::int, 14));

    if v_status is null or v_status = 'ok' then
      if r.notified_status is distinct from v_status then
        update fines set nomination_notified_status = v_status, nomination_notified_at = null where id = r.id;
      end if;
      continue;
    end if;

    v_should := (v_status is distinct from r.notified_status)
             or (v_status = 'expired' and r.notified_status = 'expired'
                 and r.last_notified_at is not null and r.last_notified_at < now() - interval '7 days');
    if not v_should then continue; end if;

    v_payload := jsonb_build_object(
      'fine_id',       r.id,
      'machine_id',    r.machine_id,
      'machine_name',  r.machine_name,
      'notice_number', r.notice_number,
      'authority',     r.authority,
      'offence',       r.offence,
      'offence_date',  r.offence_date,
      'deadline',      r.nomination_deadline,
      'status',        v_status
    );
    v_deliver_after := app.quiet_deliver_after(r.settings);
    perform app.notify_farm(r.farm_id, 'aarto_nomination_due', v_payload, v_deliver_after);
    update fines set nomination_notified_status = v_status, nomination_notified_at = now() where id = r.id;
  end loop;
end $$;
revoke execute on function app.enqueue_aarto_nomination_reminders() from public, anon, authenticated;
grant  execute on function app.enqueue_aarto_nomination_reminders() to service_role;

-- Monday 00:00 in South Africa, this week, as a moment.
create or replace function app.sast_week_start(p_now timestamptz default now()) returns timestamptz
language sql stable set search_path = public, pg_temp as $$
  select date_trunc('week', p_now at time zone 'Africa/Johannesburg') at time zone 'Africa/Johannesburg';
$$;
revoke execute on function app.sast_week_start(timestamptz) from public, anon, authenticated;
grant  execute on function app.sast_week_start(timestamptz) to service_role;

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
  v_week          timestamptz := app.sast_week_start(now());
begin
  for r in
    select f.id as farm_id, f.settings from farms f
    where f.deleted_at is null and f.status in ('trial','active')
      -- B3: an open business only, and once a week whichever run gets there first.
      and app.farm_billing_gate(f.id) = 'ok'
      and not exists (
        select 1 from notifications n
         where n.farm_id = f.id and n.template = 'weekly_digest' and n.created_at >= v_week)
  loop
    -- One digest per business, even when two runs overlap.
    perform pg_advisory_xact_lock(hashtextextended('weekly_digest:' || r.farm_id::text, 0));
    if exists (select 1 from notifications n
                where n.farm_id = r.farm_id and n.template = 'weekly_digest' and n.created_at >= v_week) then
      continue;
    end if;

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
revoke execute on function app.enqueue_weekly_digest() from public, anon, authenticated;
grant  execute on function app.enqueue_weekly_digest() to service_role;
