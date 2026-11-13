-- 20261113090000_sign_in_rate_limits.sql
-- Rate limits for somebody who is not signed in yet: sign-in attempts.
--
-- The security audit of 12 November 2026 found that twelve wrong passwords in a row were not
-- slowed down. `rate_limit_take` (20261014090000) cannot do it: it keys every count on
-- auth.uid(), and a person signing in has no session yet. This is the same counter, in the
-- same table, keyed by a value the SERVER supplies instead:
--
--   * Service role only. The key comes from the caller, so a function anon could call would
--     let the limited party choose its own key, or a fresh one each time: not a limiter.
--   * The subject must be a SHA-256 hex digest. The sign-in action hashes the address and
--     the IP before they reach this, and the database refuses anything else, so the table
--     can never hold an email address or an IP in the clear.
--   * Keys start with `anon:`, so they can never meet a signed-in person's `<scope>:<uuid>`.
--
-- The app lets the attempt through on any error from this (src/lib/rate-limit.ts): an outage
-- of a counter must not lock every customer out of their account.

create or replace function public.rate_limit_take_key(
  p_scope          text,
  p_subject        text,
  p_window_seconds integer,
  p_max            integer
)
returns table (allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
  v_hits  integer;
begin
  if p_scope is null or p_scope !~ '^[a-z_]{1,40}$'
     or p_subject is null or p_subject !~ '^[0-9a-f]{64}$'
     or p_window_seconds is null or p_window_seconds not between 1 and 86400
     or p_max is null or p_max not between 1 and 100000 then
    raise exception 'A scope of lowercase letters, a SHA-256 hex subject, a window of 1 s to a day and a maximum are required.'
      using errcode = '22023';
  end if;

  v_start := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into app.rate_limit_windows as w (key, window_start, hits)
  values ('anon:' || p_scope || ':' || p_subject, v_start, 1)
  on conflict (key, window_start) do update set hits = w.hits + 1
  returning w.hits into v_hits;

  -- Now and then, old windows go, as in rate_limit_take.
  if random() < 0.01 then
    delete from app.rate_limit_windows where window_start < now() - interval '1 day';
  end if;

  allowed := v_hits <= p_max;
  retry_after := greatest(1, ceil(extract(epoch from (v_start + make_interval(secs => p_window_seconds) - now())))::integer);
  return next;
end;
$$;

comment on function public.rate_limit_take_key(text, text, integer, integer) is
  'Counts one request against p_scope for a hashed subject the server supplies (a sign-in '
  'address or IP, SHA-256 hex), p_max per p_window_seconds. Service role only.';

comment on table app.rate_limit_windows is
  'Fixed-window rate limit counters, one row per key and window: <scope>:<user id> written by '
  'public.rate_limit_take, anon:<scope>:<sha256> by public.rate_limit_take_key (both security '
  'definer). Windows older than a day are pruned.';

revoke execute on function public.rate_limit_take_key(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_take_key(text, text, integer, integer) to service_role;
