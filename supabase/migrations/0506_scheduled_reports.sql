-- 0506_scheduled_reports.sql
-- Reports that arrive without anybody fetching them (FR-11.5).
--
-- `/reports` computes every family and hands them over as CSV, a workbook or a printed
-- page — but only to somebody who remembers to open it on the right day. The owner who
-- most needs the monthly cost report is the one least likely to be at a laptop on the
-- 1st, and an accountant who needs twelve consecutive months has to be asked twelve
-- times. Email works now (Resend, 0414), so the missing half is a standing instruction:
-- this report, this often, to these people.
--
-- ── What this is NOT ─────────────────────────────────────────────────────────
--
-- It is not a second report engine. Nothing here computes a figure. The SQL below
-- decides only WHICH schedules are due and claims a period; the numbers come from the
-- same `getReportData` the screen calls, and the CSV grids and the workbook come from
-- the same builders the download routes use (src/lib/report-export.ts). The screen and
-- the emailed copy are the same code, so they cannot disagree.
--
-- ── The idempotency key, and why it is a ROW and not a column ────────────────
--
-- 0433 (standing invoices) records `last_period_start` on the schedule and skips a run
-- whose period is not past it. That is exactly right THERE, because the artefact it
-- guards — the invoice — is created inside the same transaction as the key. Here the
-- artefact is an email sent by a process outside the transaction, which can fail after
-- the key has been written. A scalar column cannot say "September was claimed and the
-- send failed", so it would either burn a period on a bounce or re-send one that went.
--
-- So the key is a ROW per attempt in `report_schedule_runs`, and the guarantee is
-- enforced by a partial unique index rather than by application logic (the 0470
-- reasoning): `(schedule_id, period_start) where status = 'sent'`. A period can be
-- ATTEMPTED more than once; it can be SENT exactly once, and the database is what says
-- so. `last_period_start` is still kept on the schedule — it is what the screen shows
-- and what `advance_by_cadence` steps from — but it never decides.
--
-- Two runs at the same instant are a different problem from two runs in sequence, and
-- both are answered: the claim locks the schedule row (`for update`), so a cron that
-- double-fires has the second caller wait, re-read, and find the period already claimed.
--
-- ── Judgement calls, stated ──────────────────────────────────────────────────
--
-- 1. RECIPIENTS are farm users AND typed addresses, by different mechanisms.
--    A farm user is stored as a `user_id` and NOTHING else — the address is resolved at
--    send time from `users.email`. No second copy of a person's email exists to go
--    stale, a deactivated person stops receiving that night, and the F8 (POPIA) erasure,
--    which nulls `users.email`, silently and correctly removes them. A pinned membership
--    guard accepts the primary farm or an active F7 membership, so a real multi-site user
--    works while an rr_admin, contractor, removed member, or unrelated user cannot be
--    named. The same live check runs again when each delivery is claimed.
--    A typed address exists because real farms send this to an accountant, a bank or a
--    co-op, and refusing would only mean the owner forwards it by hand — an
--    unlogged copy of the same data, which is strictly worse for POPIA. So it is
--    allowed, restricted to owner/manager, and EVERY send records the exact address list
--    it went to (`report_schedule_runs.recipients`), which is the record POPIA §4 asks
--    for and `document_emails` already sets the precedent for.
--
-- 2. QUIET HOURS DO NOT APPLY. They exist (0205/0261) to stop an ALERT buzzing a phone
--    at 03:00. A scheduled report is email, on a cadence the recipient chose, read when
--    convenient; delaying it by seven hours helps nobody and makes the send time
--    unpredictable for an accountant who works to a date. The nightly cron already runs
--    at one fixed hour, which is the only timing guarantee this needs.
--
-- 3. AN EMPTY PERIOD IS STILL SENT. "Nothing was spent in August" is an answer; silence
--    is not distinguishable from a schedule that has quietly broken, and an accountant
--    reconciling twelve months must not find eleven files and have to work out which
--    month is missing and why. The email says in words that the period was empty; the
--    attachment is still there so the series has no gaps.
--
-- 4. A FARM THAT IS NOT PAYING IS NOT EMAILED. `farms.status` must be trial/active, and
--    the plan must still unlock `advanced_reports` — checked here by plan rank rather
--    than by `app.has_entitlement`, which decides through `auth.uid()` and would return
--    false for every schedule when the cron (which has no session) calls it.

-- ── Which report, and in what shape ──────────────────────────────────────────
-- One value per family the reports screen already computes, plus `all` for the whole
-- set. Enums rather than free text so a typo cannot silently produce an empty email.
create type report_family as enum (
  'all', 'cost', 'by_type', 'problems', 'compliance', 'fuel', 'contractors',
  'budgets', 'utilisation'
);

create type report_format as enum ('csv', 'xlsx', 'pdf');

-- ── The standing instruction ─────────────────────────────────────────────────
create table report_schedules (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null references farms(id),
  name              text not null,                       -- what the farm calls it

  report_key        report_family not null default 'all',
  output_format     report_format not null default 'xlsx',
  -- Reused from 0433 rather than a second cadence enum: `app.advance_by_cadence` is
  -- already the one place month arithmetic lives, and it is already proven against
  -- Postgres on leap years and short months.
  cadence           recurrence_cadence not null default 'monthly',

  -- The next day this fires. Moved on by exactly one cadence after each claim.
  next_run_date     date not null default current_date,
  ends_on           date,
  -- The period the last claim covered. Shown on screen; see the header — it does not
  -- decide anything.
  last_period_start date,
  last_run_at       timestamptz,

  -- The same two narrowings the reports screen offers, so an emailed copy is the same
  -- report a person would have downloaded (FR-11.3).
  include_inactive  boolean not null default false,
  site              text,

  -- One language per schedule, so the covering email and the attachment inside it are
  -- written in the same one. Defaults to the language of whoever set it up.
  lang              app_language not null default 'en',

  active            boolean not null default true,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,

  constraint report_schedules_farm_fk foreign key (farm_id) references farms(id),
  -- A fresh schedule cannot end before it begins. Once at least one period has been
  -- claimed, next_run_date may move past ends_on while active remains true: that is the
  -- distinct FINISHED state (`isLive` is false), while active=false remains a user pause.
  constraint report_schedules_ends_ck check (
    ends_on is null or not active or ends_on >= next_run_date or last_period_start is not null
  )
);
create index report_schedules_farm_idx on report_schedules(farm_id);
create index report_schedules_due_idx  on report_schedules(next_run_date)
  where active and deleted_at is null;
-- The (id, farm_id) pair every child row points at, so a recipient or a run can never
-- belong to one schedule while naming another farm — the composite-FK rule this codebase
-- uses everywhere a row hangs off another.
create unique index report_schedules_id_farm_uq on report_schedules(id, farm_id);

comment on table report_schedules is
  'A report the nightly cron builds and emails on a cadence (FR-11.5). Nothing here '
  'computes a figure: the numbers come from the same code the /reports screen calls.';

-- ── Who it goes to ───────────────────────────────────────────────────────────
create table report_schedule_recipients (
  id           uuid primary key default gen_random_uuid(),
  schedule_id  uuid not null,
  farm_id      uuid not null,
  -- Exactly one of the two. A farm user is a REFERENCE (address resolved at send time);
  -- an outside address is stored, because there is nothing else to store it in.
  user_id      uuid,
  email        text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,

  constraint report_schedule_recipients_sched_fk
    foreign key (schedule_id, farm_id) references report_schedules(id, farm_id) on delete cascade,
  -- A plain user FK is intentional: users.farm_id is only the PRIMARY farm, so a
  -- composite FK would reject a legitimate multi-site member. The pinned trigger below
  -- enforces live primary-or-membership tenancy instead.
  constraint report_schedule_recipients_user_fk
    foreign key (user_id) references users(id),
  constraint report_schedule_recipients_one_ck check (
    (user_id is not null and email is null) or (user_id is null and email is not null)
  ),
  constraint report_schedule_recipients_email_ck check (
    email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);

-- A schedule may name a farm-side user only while that active account belongs to this
-- farm, either as its primary farm or through an active, nondeleted F7 membership.
-- SECURITY DEFINER is required so both the trigger and the cron resolve membership past
-- users/membership RLS; no browser role may call it as an arbitrary-user oracle.
create or replace function app.report_recipient_belongs_to_farm(
  p_user uuid,
  p_farm uuid
) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1
      from public.users u
     where u.id = p_user
       and u.active
       and u.deleted_at is null
       and u.role in ('owner', 'manager', 'mechanic', 'operator')
       and (
         u.farm_id = p_farm
         or exists (
           select 1
             from public.user_farm_memberships m
            where m.user_id = u.id
              and m.farm_id = p_farm
              and m.role in ('owner', 'manager', 'mechanic', 'operator')
              and m.active
              and m.deleted_at is null
         )
       )
  );
$$;

revoke execute on function app.report_recipient_belongs_to_farm(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function app.enforce_report_recipient_farm()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.user_id is not null
     and not app.report_recipient_belongs_to_farm(new.user_id, new.farm_id) then
    raise exception 'report recipient is not an active member of this farm'
      using errcode = '23514';
  end if;
  return new;
end $$;

revoke execute on function app.enforce_report_recipient_farm()
  from public, anon, authenticated, service_role;

create trigger report_schedule_recipients_farm_guard
  before insert or update of user_id, farm_id on report_schedule_recipients
  for each row execute function app.enforce_report_recipient_farm();

create index report_schedule_recipients_sched_idx on report_schedule_recipients(schedule_id);
-- No duplicate person and no duplicate address on one schedule.
create unique index report_schedule_recipients_user_uq
  on report_schedule_recipients(schedule_id, user_id) where deleted_at is null and user_id is not null;
create unique index report_schedule_recipients_email_uq
  on report_schedule_recipients(schedule_id, lower(email)) where deleted_at is null and email is not null;

comment on column report_schedule_recipients.email is
  'An address outside the farm (accountant, bank, co-op). Personal information under '
  'POPIA: held on the farm''s instruction, removable at any time, and every send it '
  'receives is recorded in report_schedule_runs.recipients.';

-- ── What actually happened ───────────────────────────────────────────────────
-- One row per ATTEMPT, failures included — the same reason document_emails exists: a
-- bounce nobody sees leaves the owner believing they were told.
create table report_schedule_runs (
  id            uuid primary key default gen_random_uuid(),
  schedule_id   uuid not null,
  farm_id       uuid not null,
  period_start  date not null,
  period_end    date not null,
  report_key    report_family not null,
  output_format report_format not null,
  lang          app_language not null default 'en',
  include_inactive boolean not null default false,
  site          text,
  -- The exact addresses this attempt went to, frozen at claim time. A recipient removed
  -- next month does not rewrite what happened last month.
  recipients    text[] not null default '{}',
  status        text not null default 'pending'
                check (status in ('pending', 'sent', 'failed')),
  row_count     int,                                  -- how much was in the report
  bytes         int,                                  -- attachment size, for support
  provider      text,
  provider_id   text,
  error         text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid,

  constraint report_schedule_runs_sched_fk
    foreign key (schedule_id, farm_id) references report_schedules(id, farm_id) on delete cascade,
  constraint report_schedule_runs_period_ck check (period_end >= period_start)
);
create index report_schedule_runs_sched_idx on report_schedule_runs(schedule_id, period_start desc);
create index report_schedule_runs_farm_idx  on report_schedule_runs(farm_id, created_at desc);

-- THE guarantee. A period may be attempted more than once — a send that failed on
-- Tuesday should go out on Wednesday — but it can be SENT exactly once, and this index
-- is what says so, not a check somebody could forget to write.
create unique index report_schedule_runs_sent_uq
  on report_schedule_runs(schedule_id, period_start)
  where status = 'sent' and deleted_at is null;

comment on table report_schedule_runs is
  'One row per send attempt, failures included. The partial unique index on '
  '(schedule_id, period_start) where status = ''sent'' is the idempotency key: a period '
  'can be retried but never sent twice.';

-- ── RLS ──────────────────────────────────────────────────────────────────────
--
-- Farm-scoped as usual, and then narrowed twice on purpose:
--
--   * `app.is_farm_side()` (0392) keeps a LINKED CONTRACTOR out. `app.has_farm_access`
--     deliberately admits a workshop with an active link, and a contractor reading this
--     table would read the farm's staff email list and learn that the whole cost report
--     leaves the farm every month. F16 (0400) narrowed a partner to the vehicles they
--     work on; a new table must not quietly reopen the door.
--   * owner/manager only, because pointing a farm's cost report at an outside address is
--     at least as consequential as adding a partner, which 0301 restricts the same way.
--     An operator has no business reading it either — it names people and addresses.
--
-- rr_admin keeps cross-tenant read/write, as everywhere else.
do $do$
declare
  t    text;
  pred text := '(app.is_rr_admin() or (app.is_farm_side() and app.has_farm_access(farm_id) '
               'and app.current_app_role() in (''owner'', ''manager'')))';
begin
  foreach t in array array['report_schedules', 'report_schedule_recipients', 'report_schedule_runs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using (deleted_at is null and %2$s)', t, pred);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (%2$s)', t, pred);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (%2$s) with check (%2$s)', t, pred);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (%2$s)', t, pred);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $do$;
-- anon gets ZERO: 0102 revokes the default privileges and no anon policy exists here.

-- Audit the CONFIGURATION (who pointed a farm's data where), not the log. The runs table
-- is itself the record, exactly as document_emails is, and a nightly insert per schedule
-- would double every row for no extra evidence.
create trigger report_schedules_audit
  after insert or update or delete on report_schedules
  for each row execute function app_audit();
create trigger report_schedule_recipients_audit
  after insert or update or delete on report_schedule_recipients
  for each row execute function app_audit();

-- ── The period a run covers ──────────────────────────────────────────────────
--
-- The last COMPLETE period ending before the run date — "the August report" arrives in
-- early September, which is what an accountant expects and what makes consecutive files
-- add up. Deriving it from the run date rather than storing it means a schedule that
-- fires late still reports the month it belongs to.
create or replace function app.report_period(
  p_cadence recurrence_cadence,
  p_run     date,
  out period_start date,
  out period_end   date
)
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  case p_cadence
    when 'weekly' then
      -- date_trunc('week') is Monday, so this is the Mon–Sun that just ended.
      period_end   := date_trunc('week', p_run)::date - 1;
      period_start := period_end - 6;
    when 'monthly' then
      period_end   := date_trunc('month', p_run)::date - 1;
      period_start := date_trunc('month', period_end)::date;
    when 'quarterly' then
      period_end   := date_trunc('quarter', p_run)::date - 1;
      period_start := date_trunc('quarter', period_end)::date;
    when 'yearly' then
      period_end   := date_trunc('year', p_run)::date - 1;
      period_start := date_trunc('year', period_end)::date;
  end case;
end $$;

revoke execute on function app.report_period(recurrence_cadence, date) from public, anon, authenticated;
grant  execute on function app.report_period(recurrence_cadence, date) to service_role;

-- ── The engine ───────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER because the nightly cron runs with no session, exactly like every
-- other 0205-pattern engine. It CLAIMS work and returns it; it does not send anything,
-- because Postgres cannot build a workbook or reach Resend. The worker
-- (src/lib/scheduled-reports.ts) builds each claimed run from the reports code the
-- screen uses and writes the outcome back onto the run row.
create or replace function app.run_due_report_schedules(
  p_only  uuid default null,
  p_today date default null
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
     -- Only the schedule row, and only as each is fetched. `last_period_start` and the
     -- runs table both answer a SEQUENCE of runs; this answers two runs at the same
     -- instant, which is a different problem — the second caller waits here, re-reads,
     -- and finds the period already claimed below.
     for update of s
  loop
    -- One live claim blocks every later period for this schedule. This is both the
    -- double-fire guard and the ordering rule: an older delivery finishes (or becomes
    -- stale after six hours) before a newer cadence period may be claimed.
    if exists (
      select 1
        from report_schedule_runs q
       where q.schedule_id = r.id
         and q.deleted_at is null
         and q.status = 'pending'
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
  end loop;
end $$;

revoke execute on function app.run_due_report_schedules(uuid, date) from public, anon, authenticated;
grant  execute on function app.run_due_report_schedules(uuid, date) to service_role;

create or replace function public.cron_run_due_report_schedules()
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
  return query select * from app.run_due_report_schedules(null, null);
end $$;

revoke execute on function public.cron_run_due_report_schedules() from public, anon, authenticated;
grant  execute on function public.cron_run_due_report_schedules() to service_role;

-- ── "Send the due one now" ───────────────────────────────────────────────────
-- The owner's own button, for a schedule that is behind or newly set up. Ownership is
-- checked HERE rather than left to the engine, because the engine is SECURITY DEFINER
-- and would otherwise honour any id handed to it (0433's rule, and the reason
-- public._f14_probe was dangerous: a definer function that trusts its argument).
create or replace function public.run_report_schedule(p_id uuid)
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
declare v_farm uuid;
begin
  select s.farm_id into v_farm
    from report_schedules s
   where s.id = p_id and s.deleted_at is null;
  if v_farm is null then
    raise exception 'schedule not found' using errcode = 'P0002';
  end if;

  if not app.is_rr_admin()
     and not (app.is_farm_side()
              and app.has_farm_access(v_farm)
              and app.current_app_role() in ('owner', 'manager')) then
    raise exception 'That schedule belongs to another farm.' using errcode = '42501';
  end if;

  return query select * from app.run_due_report_schedules(p_id, null);
end $$;

revoke execute on function public.run_report_schedule(uuid) from public, anon;
grant  execute on function public.run_report_schedule(uuid) to authenticated, service_role;

comment on function public.run_report_schedule(uuid) is
  'Claim this schedule''s due period now. Ownership is checked here because the engine '
  'it calls is SECURITY DEFINER and would otherwise trust any id.';
