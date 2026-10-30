-- Support deadlines are chased every hour, not once a night.
--
-- The promise is a same-day answer during support hours (decision of 26 October 2026,
-- app.support_due_at). app.escalate_support_tickets ran only from the nightly billing cron
-- (03:20 UTC), so a request due at 17:00 was first chased the next morning, after it was
-- late. It is pure SQL (it writes Rapid Rise's in-app notifications), so the database's own
-- scheduler runs it at five past every hour, chasing what falls due within the next two
-- hours. The nightly run stays as a backstop. A ticket is still chased at most once in 20
-- hours (app.due_support_escalations), so the hourly run never repeats itself.
--
-- Hosted Supabase only: plain PostgreSQL and PGlite test databases have no pg_cron, and
-- skip this, as the WhatsApp scheduler (20261016083512) does.
do $install$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'The hourly support chase needs hosted pg_cron; skipped';
    return;
  end if;
  create extension if not exists pg_cron;
  revoke all on schema cron from public, anon, authenticated, service_role;
  revoke execute on all functions in schema cron from public, anon, authenticated, service_role;

  -- cron.schedule with an existing name replaces that job, so this can be run again.
  perform cron.schedule('fleetwise-support-chase', '5 * * * *', $job$
    select app.escalate_support_tickets(interval '2 hours');
  $job$);

  -- Keep the run history short, like the WhatsApp jobs.
  perform cron.schedule('fleetwise-support-chase-history', '25 2 * * *', $job$
    delete from cron.job_run_details where end_time < now() - interval '7 days'
      and jobid in (select jobid from cron.job where jobname in
        ('fleetwise-support-chase', 'fleetwise-support-chase-history'));
  $job$);
end
$install$;
