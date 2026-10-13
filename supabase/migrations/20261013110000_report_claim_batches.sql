-- 20261013110000_report_claim_batches.sql
-- Scheduled reports claimed a few at a time.
--
-- The nightly run claimed EVERY due report on the platform in one call: for each it wrote a
-- pending run and moved the schedule on, then the worker built and emailed them one by one.
-- Two limits cut that short with nothing to say so. The API returns at most 1 000 rows, so
-- on a night with more due (500 farms with two monthly reports on the 1st, or the monthly,
-- quarterly and yearly reports of 1 January) the rest were claimed and never sent, and the
-- next night's claim was cut the same way. And a function has a time limit long before a
-- thousand reports are built: whatever was claimed and not reached waited six hours to be
-- treated as stale, then came back the next night.
--
-- The engine now takes p_limit and stops after that many claims, oldest due first, and in
-- batches it does not retry an attempt that failed in the last six hours (that is, earlier
-- in the same run): it is retried by the next run, as before. The worker
-- (src/lib/scheduled-reports.ts) claims a batch, delivers it, and claims the next only while
-- it has time, so nothing is claimed that is not about to be sent; what is left stays due and
-- goes out on the next run. Without p_limit the engine claims everything, as before, which is
-- what the owner's "send it now" (one schedule) still asks for.
--
-- A parameter is added, so the functions are dropped and created again: a second overload
-- beside the old one would make every two-argument call ambiguous.

drop function if exists public.cron_run_due_report_schedules();
drop function if exists app.run_due_report_schedules(uuid, date);

create function app.run_due_report_schedules(
  p_only  uuid default null,
  p_today date default null,
  p_limit integer default null
)
returns table (
  run_id           uuid,
  schedule_id      uuid,
  farm_id          uuid,
  farm_name        text,
  schedule_name    text,
  report_key       report_family,
  output_format    report_format,
  lang             app_language,
  period_start     date,
  period_end       date,
  include_inactive boolean,
  site             text,
  recipients       text[]
)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r                  record;
  v_retry            report_schedule_runs%rowtype;
  v_today            date := coalesce(p_today, current_date);
  v_ps               date;
  v_pe               date;
  v_next             date;
  v_to               text[];
  v_run              uuid;
  v_retrying         boolean;
  v_report_key       report_family;
  v_output_format    report_format;
  v_lang             app_language;
  v_include_inactive boolean;
  v_site             text;
  v_claimed          integer := 0;
begin
  for r in
    select s.*, f.name as farm_name
      from report_schedules s
      join farms f on f.id = s.farm_id
     where s.deleted_at is null
       and s.active
       and (p_only is null or s.id = p_only)
       and (
         (s.next_run_date <= v_today
          and (s.ends_on is null or s.next_run_date <= s.ends_on))
         or exists (
           select 1
             from report_schedule_runs q
            where q.schedule_id = s.id
              and q.deleted_at is null
              and q.status in ('pending', 'failed')
              and not exists (
                select 1
                  from report_schedule_runs sent
                 where sent.schedule_id = q.schedule_id
                   and sent.period_start = q.period_start
                   and sent.deleted_at is null
                   and sent.status = 'sent'
              )
         )
       )
       and f.deleted_at is null
       -- A farm that stopped paying is not emailed.
       and f.status in ('trial', 'active')
       -- And neither is one whose plan no longer unlocks reports. Checked by RANK, not
       -- through app.has_entitlement: that decides via auth.uid(), and the cron has no
       -- session, so it would answer false for every farm and silently send nothing.
       and app.plan_rank(f.plan) >= app.feature_min_rank('advanced_reports')
     -- Oldest due first, so a batch never starves the schedules behind it.
     order by s.next_run_date, s.id
     -- Only the schedule row, and only as each is fetched. `last_period_start` and the
     -- runs table both answer a SEQUENCE of runs; this answers two runs at the same
     -- instant, which is a different problem, the second caller waits here, re-reads,
     -- and finds the period already claimed below.
     for update of s
  loop
    -- One live claim blocks every later period for this schedule. This is both the
    -- double-fire guard and the ordering rule: an older delivery finishes (or becomes
    -- stale after six hours) before a newer cadence period may be claimed.
    --
    -- In batches, an attempt that FAILED within the same window counts as live too: the
    -- worker claims again after every full batch, and without this the same failing
    -- reports came back in every batch until its time ran out, a row and often an email
    -- attempt each time. They are retried by the next run, once, as before batching; an
    -- unlimited claim (the owner's "send it now") still retries at once.
    if exists (
      select 1
        from report_schedule_runs q
       where q.schedule_id = r.id
         and q.deleted_at is null
         and (q.status = 'pending' or (p_limit is not null and q.status = 'failed'))
         and q.created_at > now() - interval '6 hours'
         and not exists (
           select 1
             from report_schedule_runs sent
            where sent.schedule_id = q.schedule_id
              and sent.period_start = q.period_start
              and sent.deleted_at is null
              and sent.status = 'sent'
         )
         and not exists (
           select 1
             from report_schedule_runs newer
            where newer.schedule_id = q.schedule_id
              and newer.period_start = q.period_start
              and newer.deleted_at is null
              and (newer.created_at > q.created_at
                   or (newer.created_at = q.created_at and newer.id > q.id))
         )
    ) then
      continue;
    end if;

    -- Retry the oldest unresolved period, but only from its latest attempt. An earlier
    -- failed row is historical once a newer attempt exists; selecting it again would
    -- create an endless retry loop. A sent row for the period is terminal regardless of
    -- how many failed attempts came before it.
    select q.*
      into v_retry
      from report_schedule_runs q
     where q.schedule_id = r.id
       and q.deleted_at is null
       and (q.status = 'failed'
            or (q.status = 'pending' and q.created_at <= now() - interval '6 hours'))
       and not exists (
         select 1
           from report_schedule_runs sent
          where sent.schedule_id = q.schedule_id
            and sent.period_start = q.period_start
            and sent.deleted_at is null
            and sent.status = 'sent'
       )
       and not exists (
         select 1
           from report_schedule_runs newer
          where newer.schedule_id = q.schedule_id
            and newer.period_start = q.period_start
            and newer.deleted_at is null
            and (newer.created_at > q.created_at
                 or (newer.created_at = q.created_at and newer.id > q.id))
       )
     order by q.period_start, q.created_at, q.id
     limit 1
     for update of q;

    v_retrying := found;
    if v_retrying then
      v_ps               := v_retry.period_start;
      v_pe               := v_retry.period_end;
      v_report_key       := v_retry.report_key;
      v_output_format    := v_retry.output_format;
      v_lang             := v_retry.lang;
      v_include_inactive := v_retry.include_inactive;
      v_site             := v_retry.site;
    else
      select p.period_start, p.period_end
        into v_ps, v_pe
        from app.report_period(r.cadence, r.next_run_date) p;

      v_next             := app.advance_by_cadence(r.next_run_date, r.cadence);
      v_report_key       := r.report_key;
      v_output_format    := r.output_format;
      v_lang             := r.lang;
      v_include_inactive := r.include_inactive;
      v_site             := r.site;

      -- A manually rewound schedule still cannot send a period twice. The partial unique
      -- index is the final guarantee; this branch advances the pointer without relying on
      -- an exception for the ordinary already-sent case.
      if exists (
        select 1 from report_schedule_runs q
         where q.schedule_id = r.id
           and q.period_start = v_ps
           and q.deleted_at is null
           and q.status = 'sent'
      ) then
        update report_schedules
           set next_run_date = v_next, updated_at = now()
         where report_schedules.id = r.id;
        continue;
      end if;
    end if;

    -- Addresses, resolved NOW. A named farm user contributes `users.email` and nothing
    -- was ever copied, so a person who has been deactivated, soft-deleted, or erased
    -- under POPIA (which nulls the address) simply stops appearing here.
    select array_agg(distinct a.addr order by a.addr) into v_to from (
      select lower(btrim(u.email)) as addr
        from report_schedule_recipients rc
        join users u on u.id = rc.user_id
       where rc.schedule_id = r.id
         and rc.deleted_at is null
         -- Membership is live data, not frozen configuration: removing a secondary-farm
         -- member must stop the next delivery without deleting the historical recipient.
         and app.report_recipient_belongs_to_farm(rc.user_id, rc.farm_id)
         and u.active and u.deleted_at is null
         and u.email is not null and btrim(u.email) <> ''
      union
      select lower(btrim(rc.email))
        from report_schedule_recipients rc
       where rc.schedule_id = r.id
         and rc.deleted_at is null
         and rc.email is not null
    ) a;

    -- Nobody to send to is a configuration mistake, not a period to burn: the clock
    -- moves on so the schedule does not sit permanently due, but no run is claimed, so
    -- the moment somebody is added the next period goes out normally.
    if v_to is null or cardinality(v_to) = 0 then
      if not v_retrying then
        update report_schedules
           set next_run_date = v_next,
               active = case when r.ends_on is not null and v_next > r.ends_on
                             then false else r.active end,
               updated_at = now()
         where report_schedules.id = r.id;
      end if;
      continue;
    end if;

    if v_retrying and v_retry.status = 'pending' then
      update report_schedule_runs
         set status = 'failed',
             error = left(concat_ws('; ', nullif(error, ''), 'delivery claim expired before completion'), 900)
       where id = v_retry.id;
    end if;

    insert into report_schedule_runs (
      schedule_id, farm_id, period_start, period_end, report_key, output_format, lang,
      include_inactive, site, recipients, status
    ) values (
      r.id, r.farm_id, v_ps, v_pe, v_report_key, v_output_format, v_lang,
      v_include_inactive, v_site, v_to, 'pending'
    ) returning id into v_run;

    if v_retrying then
      update report_schedules
         set last_run_at = now(), updated_at = now()
       where report_schedules.id = r.id;
    else
      update report_schedules
         set last_period_start = v_ps,
             last_run_at       = now(),
             next_run_date     = v_next,
             updated_at        = now()
       where report_schedules.id = r.id;
    end if;

    run_id           := v_run;
    schedule_id      := r.id;
    farm_id          := r.farm_id;
    farm_name        := r.farm_name;
    schedule_name    := r.name;
    report_key       := v_report_key;
    output_format    := v_output_format;
    lang             := v_lang;
    period_start     := v_ps;
    period_end       := v_pe;
    include_inactive := v_include_inactive;
    site             := v_site;
    recipients       := v_to;
    return next;

    -- A batch, when asked for one: the caller delivers these before claiming more, so a
    -- claim never runs ahead of what can be sent before the function's time is up.
    v_claimed := v_claimed + 1;
    exit when p_limit is not null and v_claimed >= p_limit;
  end loop;
end $$;

revoke execute on function app.run_due_report_schedules(uuid, date, integer) from public, anon, authenticated;
grant  execute on function app.run_due_report_schedules(uuid, date, integer) to service_role;

create function public.cron_run_due_report_schedules(p_limit integer default null)
returns table (
  run_id           uuid,
  schedule_id      uuid,
  farm_id          uuid,
  farm_name        text,
  schedule_name    text,
  report_key       report_family,
  output_format    report_format,
  lang             app_language,
  period_start     date,
  period_end       date,
  include_inactive boolean,
  site             text,
  recipients       text[]
)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return query select * from app.run_due_report_schedules(null, null, p_limit);
end $$;

revoke execute on function public.cron_run_due_report_schedules(integer) from public, anon, authenticated;
grant  execute on function public.cron_run_due_report_schedules(integer) to service_role;
