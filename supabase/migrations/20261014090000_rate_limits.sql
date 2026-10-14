-- 20261014090000_rate_limits.sql
-- Rate limits every server instance shares (H3).
--
-- The speech-token broker and the transcription route each kept their per-user limit in the
-- memory of one server instance. Serverless runs several, so a loop (or a person) spread over
-- them got the limit once per instance. This keeps the count in the database: one row per
-- user, scope and window, incremented atomically, so every instance sees the same number.
-- The routes keep their in-memory check in front as a free first line, and a database fault
-- lets a request through (the limit is a guard, not a gate: dictation must not stop because a
-- counter could not be written).
--
-- The key is built here from the caller's own session (auth.uid()), never from an argument,
-- so nobody can spend, or reset, another person's limit. The table sits in `app`, unexposed;
-- only this function writes it, and old windows are pruned as it goes.

create table if not exists app.rate_limit_windows (
  key          text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (key, window_start)
);

alter table app.rate_limit_windows enable row level security;
revoke all on app.rate_limit_windows from public, anon, authenticated;

comment on table app.rate_limit_windows is
  'Fixed-window rate limit counters, one row per user, scope and window; written only by '
  'public.rate_limit_take (security definer). Windows older than a day are pruned.';

create or replace function public.rate_limit_take(
  p_scope          text,
  p_window_seconds integer,
  p_max            integer
)
returns table (allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid := auth.uid();
  v_start timestamptz;
  v_hits  integer;
begin
  if v_uid is null then
    raise exception 'A rate limit belongs to a signed-in person.' using errcode = '42501';
  end if;
  if p_scope is null or p_scope !~ '^[a-z_]{1,40}$'
     or p_window_seconds is null or p_window_seconds not between 1 and 86400
     or p_max is null or p_max not between 1 and 100000 then
    raise exception 'A scope of lowercase letters, a window of 1 s to a day and a maximum are required.'
      using errcode = '22023';
  end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into app.rate_limit_windows as w (key, window_start, hits)
  values (p_scope || ':' || v_uid::text, v_start, 1)
  on conflict (key, window_start) do update set hits = w.hits + 1
  returning w.hits into v_hits;

  -- Now and then, old windows go, so the table stays about a day's worth of rows.
  if random() < 0.01 then
    delete from app.rate_limit_windows where window_start < now() - interval '1 day';
  end if;

  allowed := v_hits <= p_max;
  retry_after := greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::integer);
  return next;
end;
$$;

comment on function public.rate_limit_take(text, integer, integer) is
  'Counts one request against the caller''s own limit for p_scope (p_max per p_window_seconds) '
  'and says whether it is allowed and how many seconds until the window resets.';

revoke execute on function public.rate_limit_take(text, integer, integer) from public, anon;
grant execute on function public.rate_limit_take(text, integer, integer) to authenticated, service_role;
