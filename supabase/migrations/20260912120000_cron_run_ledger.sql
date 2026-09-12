-- 20260912120000_cron_run_ledger.sql
-- "Did the cron run last night?" had no answer, and the one that matters had none at all.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- Measured on production before writing this. The NIGHTLY pass is provably firing on
-- Vercel's schedule: 90 `notifications` rows land in the 03:00–03:59 UTC window across 14
-- distinct days, the most recent on 2026-09-07. That is not because anything records the
-- run — it is a side effect of those engines happening to WRITE something.
--
-- The BILLING pass has no such side effect. When nothing is due it raises no invoice,
-- claims no charge, sends no receipt and enqueues no reminder — correctly — and its entire
-- output is a JSON body returned to Vercel's scheduler, which is read by nobody. The route
-- says so itself, in a comment above `captureError`: "a billing engine that quietly stopped
-- working is the failure with the longest half-life in this product."
--
-- So on the current data a billing cron that has fired every night for six weeks and one
-- that has never fired at all are INDISTINGUISHABLE. Six invoices exist on production and
-- every one was raised by hand at 11:35, 15:37, 19:39, 21:31 or 21:39 UTC; every charge
-- attempt likewise. Nothing unattended has ever been observed from that route.
--
-- That is the gap this closes. Not "add logging" — make the question answerable with one
-- query, for ever, by anyone, including after this session is gone.
--
-- WHAT IS DELIBERATE HERE
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The row is written when the pass STARTS, not when it finishes. A pass that crashes,
--    times out at Vercel's function limit, or is killed mid-charge is exactly the pass
--    worth knowing about, and a ledger of successes answers a question nobody asked. An
--    unfinished row — `finished_at is null` an hour later — is itself the finding.
--
-- 2. NOT farm-scoped. This is platform telemetry: which of OUR scheduled jobs ran, when,
--    and what each step said. It carries no farm data, no personal data and no money —
--    the step summary is engine names and counts, which is what makes it safe to keep.
--    RLS admits Rapid Rise only; the service role writes it.
--
-- 3. NO audit trigger, and that is a decision rather than an omission. `audit_log` exists
--    to record who changed a business record. This table IS a record of automated
--    activity; auditing it would write a second row for every first row and answer
--    nothing that the row itself does not already say.
--
-- 4. Bounded without anybody remembering. `cron_run_start` prunes rows older than 180
--    days on the way in, so an append-only operational table cannot grow for ever on a
--    schedule nobody revisits. 180 days is two SARS VAT cycles and far more history than
--    "is it running" needs.
--
-- 5. It must never be able to break a billing pass. Both functions are called inside a
--    try/catch in the route and the pass continues regardless: telemetry that can stop
--    the thing it watches is worse than no telemetry.

-- ── The ledger ──────────────────────────────────────────────────────────────

create table if not exists public.cron_runs (
  id           uuid primary key default gen_random_uuid(),
  -- The route path, exactly as `vercel.json` schedules it, so the two can be compared
  -- without translation: '/api/cron/nightly', '/api/cron/billing'.
  route        text        not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  -- Null until it finishes. Three states, not two: running, finished-ok, finished-bad.
  ok           boolean,
  -- What each step said, in the route's own words: {"generate_invoices":"ok", ...}.
  steps        jsonb       not null default '{}'::jsonb,
  -- How the run was triggered. 'schedule' is Vercel; 'manual' is somebody pressing it.
  -- Recorded because "it works when I run it by hand" is the answer that hides the fault.
  trigger      text        not null default 'schedule',
  created_at   timestamptz not null default now(),

  constraint cron_runs_route_ck   check (route = btrim(route) and route <> ''),
  constraint cron_runs_trigger_ck check (trigger in ('schedule', 'manual')),
  -- A finished run has both, or neither. Half a finish is a bug worth refusing.
  constraint cron_runs_finish_ck  check (
    (finished_at is null and ok is null) or (finished_at is not null and ok is not null)
  )
);

comment on table public.cron_runs is
  'One row per invocation of a scheduled route, written when it STARTS. The only durable '
  'answer to "did the cron run last night" — the billing pass writes nothing else when '
  'nothing is due, and its JSON response goes to Vercel''s scheduler and nobody else.';

create index if not exists cron_runs_route_started_idx
  on public.cron_runs (route, started_at desc);

-- The one that answers the real question fast: what is still running, or died running.
create index if not exists cron_runs_unfinished_idx
  on public.cron_runs (started_at desc) where finished_at is null;

-- ── Who may read it ─────────────────────────────────────────────────────────
-- Rapid Rise only. A farm has no business reading which of our jobs ran, and nothing here
-- is about any one farm. Writes come from the service role, which bypasses RLS.

alter table public.cron_runs enable row level security;
alter table public.cron_runs force row level security;

drop policy if exists cron_runs_sel on public.cron_runs;
create policy cron_runs_sel on public.cron_runs
  for select to authenticated
  using (app.is_rr_admin());

-- Explicit revoke BEFORE the grant. `0102_grants.sql` sets ALTER DEFAULT PRIVILEGES for
-- `authenticated`, so a new table arrives already granted and a migration that only says
-- "we do not grant this" is true of itself and false of the database — the lesson from
-- `billing_payment_methods.authorization_code`, written up in SECURITY.md §2b.
revoke all on public.cron_runs from anon, authenticated;
grant select on public.cron_runs to authenticated;
grant select, insert, update on public.cron_runs to service_role;

-- ── Starting a run ──────────────────────────────────────────────────────────

create or replace function app.cron_run_start(p_route text, p_trigger text default 'schedule')
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_route is null or btrim(p_route) = '' then
    raise exception 'cron_run_start: a route is required';
  end if;

  insert into public.cron_runs (route, trigger)
  values (btrim(p_route), case when p_trigger = 'manual' then 'manual' else 'schedule' end)
  returning id into v_id;

  -- Bounded on the way in, so nobody has to remember to prune a table that only ever
  -- grows. Deliberately after the insert: a failure to prune must not stop a pass being
  -- recorded, and this is inside the caller's transaction either way.
  delete from public.cron_runs where started_at < now() - interval '180 days';

  return v_id;
end $$;

comment on function app.cron_run_start(text, text) is
  'Open a cron-run row and return its id. Written at the START so a pass that dies leaves '
  'evidence it began — a ledger of successes answers the wrong question.';

-- ── Finishing one ───────────────────────────────────────────────────────────

create or replace function app.cron_run_finish(p_run uuid, p_ok boolean, p_steps jsonb)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_run is null then return; end if;

  -- `finished_at is null` in the predicate, so a retried or duplicated finish cannot
  -- rewrite a run that is already closed. The FIRST answer stands.
  update public.cron_runs
     set finished_at = now(),
         ok          = coalesce(p_ok, false),
         steps       = coalesce(p_steps, '{}'::jsonb)
   where id = p_run
     and finished_at is null;
end $$;

comment on function app.cron_run_finish(uuid, boolean, jsonb) is
  'Close a cron-run row. Only ever closes an OPEN one, so a retry cannot rewrite history.';

-- ── The wrappers PostgREST can reach ────────────────────────────────────────
-- Engines live in `app` and PostgREST exposes `public` only, so every one needs a thin
-- `public.*` wrapper or the call resolves to no function at all and fails silently. That
-- is precisely what happened to the whole charging path (suite section (m)).

create or replace function public.cron_run_start(p_route text, p_trigger text default 'schedule')
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.cron_run_start(p_route, p_trigger);
$$;

create or replace function public.cron_run_finish(p_run uuid, p_ok boolean, p_steps jsonb)
returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.cron_run_finish(p_run, p_ok, p_steps);
$$;

-- The engines grant to NOBODY; only the public wrappers grant, and only to `service_role`.
-- A browser being able to write this table would let anybody forge a clean run history for
-- a billing pass that never happened, which is the one lie this table exists to prevent.
revoke execute on function app.cron_run_start(text, text)            from public, anon, authenticated, service_role;
revoke execute on function app.cron_run_finish(uuid, boolean, jsonb) from public, anon, authenticated, service_role;

revoke execute on function public.cron_run_start(text, text)            from public, anon, authenticated;
revoke execute on function public.cron_run_finish(uuid, boolean, jsonb) from public, anon, authenticated;
grant  execute on function public.cron_run_start(text, text)            to service_role;
grant  execute on function public.cron_run_finish(uuid, boolean, jsonb) to service_role;

-- ── Reading it back ─────────────────────────────────────────────────────────
-- One row per scheduled route: when it last ran, whether it finished, and how long it has
-- been since. This is the query somebody actually wants, so it lives here rather than
-- being written out again on every screen that asks.

create or replace function app.cron_health()
returns table (
  route            text,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_ok          boolean,
  hours_since      numeric,
  runs_7d          integer,
  failures_7d      integer,
  unfinished_7d    integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with latest as (
    select distinct on (route) route, started_at, finished_at, ok
      from public.cron_runs
     order by route, started_at desc
  )
  select l.route,
         l.started_at,
         l.finished_at,
         l.ok,
         round(extract(epoch from (now() - l.started_at)) / 3600.0, 1),
         (select count(*)::integer from public.cron_runs r
           where r.route = l.route and r.started_at > now() - interval '7 days'),
         (select count(*)::integer from public.cron_runs r
           where r.route = l.route and r.started_at > now() - interval '7 days'
             and r.ok is false),
         (select count(*)::integer from public.cron_runs r
           where r.route = l.route and r.started_at > now() - interval '7 days'
             and r.finished_at is null
             -- Still within its own run is not "unfinished"; an hour later it is.
             and r.started_at < now() - interval '1 hour')
    from latest l
   order by l.route;
$$;

comment on function app.cron_health() is
  'One row per scheduled route: last run, whether it finished, hours since, and the last '
  'seven days of runs/failures/hangs. SECURITY INVOKER, so RLS answers who may see it.';

create or replace function public.cron_health()
returns table (
  route            text,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_ok          boolean,
  hours_since      numeric,
  runs_7d          integer,
  failures_7d      integer,
  unfinished_7d    integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.cron_health();
$$;

-- SECURITY INVOKER the whole way down, so `cron_runs_sel` decides. A farm owner calling
-- this gets zero rows because RLS says so, not because a check in a body said so — the
-- rule this codebase has settled on for every reporting function since 0460.
revoke execute on function app.cron_health()    from public, anon;
revoke execute on function public.cron_health() from public, anon;
grant  execute on function app.cron_health()    to authenticated, service_role;
grant  execute on function public.cron_health() to authenticated, service_role;
