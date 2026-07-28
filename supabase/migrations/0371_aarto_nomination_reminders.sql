-- 0371_aarto_nomination_reminders.sql
-- AARTO nomination-deadline reminders (FR-13.2; §23) — the 0205 / 0263 engine, extended.
--
-- Reminds owner/manager as a fine's nomination_deadline approaches WHILE the driver has not
-- yet been nominated (status received | driver_identified). Once the fine is nominated / paid /
-- disputed / closed, no further reminder fires. Retired/sold machines never enqueue (Scope §4.1);
-- non-active farms are skipped. Quiet hours are honoured via app.quiet_deliver_after; each fine
-- dedupes on the stored nomination_notified_status (fire on any transition into expiring/expired,
-- re-fire weekly while expired). SECURITY DEFINER; EXECUTE revoked from public/anon/authenticated
-- and granted only to service_role; fronted by a public.cron_* wrapper the nightly route calls.
--
-- Per-farm threshold (settings): aarto_nomination_lead_days (default 14) — start reminding this
-- many days before the deadline. One template: `aarto_nomination_due` (payload carries the
-- expiring/expired status so the formatter can phrase it).

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

-- ── Lock down the app.* engine (0205 / 0263 pattern) ──────────────
revoke execute on function app.enqueue_aarto_nomination_reminders() from public, anon, authenticated;
grant  execute on function app.enqueue_aarto_nomination_reminders() to service_role;

-- ── PostgREST-callable cron wrapper (the nightly route's identity) ─
create or replace function public.cron_enqueue_aarto_nominations() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin perform app.enqueue_aarto_nomination_reminders(); end $$;

revoke execute on function public.cron_enqueue_aarto_nominations() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_aarto_nominations() to service_role;
