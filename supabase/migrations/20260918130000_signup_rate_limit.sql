-- 20260918130000_signup_rate_limit.sql
-- A ceiling on how fast one source can create accounts.
--
-- `/signup` is the only anonymous endpoint in this product that WRITES, and what it writes
-- is an auth user, a farm, an owner, a subscription and an invoice. Everything else a
-- visitor can reach either reads nothing or goes through a service-role route holding an
-- unguessable token. There was no limit on it of any kind.
--
-- The damage is not a breach — a pending farm has no access and no data, and the dormant
-- sweep already tidies them after a week. It is:
--
--   * `auth.users` rows that permanently burn an email address each, because the address
--     is unique and a squatted one cannot be signed up again by its real owner;
--   * invoice reference numbers consumed from a shared sequence, so a real customer's
--     first invoice is FW-2026-004871;
--   * a bill from Supabase Auth, which prices on monthly active users;
--   * and enough noise in the ledger to hide a real problem in.
--
-- WHY A BUCKET AND NOT A CAPTCHA
-- ─────────────────────────────────────────────────────────────────────────────
-- A captcha is a third-party script on the one page that has to work for a farmer on a
-- bad connection, and it is the wrong tool for a form whose real cost only lands when
-- somebody pays. This costs nothing to a human being — the limit is far above what one
-- person does — and turns scripted abuse into a slow trickle.
--
-- It follows the shape `app.assistant_turn_buckets` already established (20260813200621),
-- deliberately, so this codebase has one idea about rate limiting rather than two: a
-- coarse time bucket, an upsert whose WHERE clause is the limit, and the ON CONFLICT row
-- lock doing the serialisation. Two requests in the same instant cannot both pass, because
-- neither is reading a count and then deciding — the conditional update IS the decision.

create table if not exists app.signup_attempt_buckets (
  -- Whatever the route can establish about the source. An IP from a forwarded header is
  -- attacker-influenced and is NOT a security boundary — see the note in the route. It is
  -- a cost multiplier, which is all a limiter of this kind ever is.
  source_key   text        not null,
  bucket_start timestamptz not null,
  attempts     smallint    not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (source_key, bucket_start)
);

comment on table app.signup_attempt_buckets is
  'Rate-limit buckets for the anonymous /signup action. Not a security boundary — the '
  'source key comes from a forwarded header — but it turns scripted account creation from '
  'free into slow. Same shape as app.assistant_turn_buckets.';

create index if not exists signup_attempt_buckets_expiry_idx
  on app.signup_attempt_buckets (bucket_start);

-- No RLS policy and no grants: nothing but the service role ever touches this, and the
-- table lives in `app`, which PostgREST does not expose at all.
alter table app.signup_attempt_buckets enable row level security;
revoke all on app.signup_attempt_buckets from public, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- Take one
-- ══════════════════════════════════════════════════════════════════════════════
-- Returns TRUE when the caller may proceed.
--
-- The window is an hour and the ceiling is 10. One person signing up one farm does this
-- once; a person who mistypes their password four times has still not reached it, because
-- the action only counts an attempt once it is about to CREATE something. Ten farms from
-- one connection in one hour is a script or a demo, and both can wait.
create or replace function public.billing_take_signup_slot(
  p_source text,
  p_limit  integer default 10
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, app, pg_temp
as $$
declare
  v_bucket timestamptz := date_trunc('hour', now());
  v_key    text        := coalesce(nullif(trim(p_source), ''), 'unknown');
  v_count  smallint;
begin
  -- Bounded housekeeping on the expiry index: at most 100 rows per call, so tidying can
  -- never grow into the cost of the request it is riding on.
  with expired as (
    select b.ctid
      from app.signup_attempt_buckets b
     where b.bucket_start < v_bucket - interval '24 hours'
     order by b.bucket_start
     limit 100
  )
  delete from app.signup_attempt_buckets b
   using expired e
   where b.ctid = e.ctid;

  insert into app.signup_attempt_buckets as bucket(source_key, bucket_start, attempts)
  values (v_key, v_bucket, 1)
  on conflict (source_key, bucket_start) do update
     set attempts   = bucket.attempts + 1,
         updated_at = now()
   -- THE LIMIT IS THIS WHERE CLAUSE. Once the stored count reaches p_limit the update
   -- matches no row, RETURNING yields nothing, and v_count stays null — which is the
   -- refusal. Nothing reads a count and then decides, so two simultaneous requests cannot
   -- both be told yes.
   where bucket.attempts < greatest(p_limit, 1)
  returning attempts into v_count;

  return v_count is not null;
end $$;

comment on function public.billing_take_signup_slot(text, integer) is
  'Claim one sign-up slot for a source key in the current hour. TRUE = proceed. '
  'Service-role only: the sign-up action runs with the service key, and a wrapper anon '
  'could call would let the limiter be drained by the thing it limits.';

revoke execute on function public.billing_take_signup_slot(text, integer)
  from public, anon, authenticated;
grant  execute on function public.billing_take_signup_slot(text, integer) to service_role;
