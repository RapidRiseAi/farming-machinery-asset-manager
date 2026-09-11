-- 20260911180000_billing_access_lifecycle.sql
-- Not paying has to end somewhere. Until now it did not.
--
-- WHAT WAS ACTUALLY HAPPENING
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.farm_billing_gate` blocked exactly one state — a subscription that exists and is
-- 'pending' — and answered 'ok' to everything else. The lifecycle engines around it are
-- complete and correct: `app.billing_close_cancellations` moves 'non_renewing' to
-- 'cancelled' at period end, and `app.billing_apply_downgrades` moves 'grace' to
-- 'downgraded' and drops `farms.plan` to the downgrade target. Both terminal states then
-- answered 'ok'.
--
--     stops paying  -> past_due -> grace -> downgraded -> Essential, free, for ever
--     cancels       -> non_renewing -> cancelled      -> full access, for ever
--
-- So the only customer the product ever refused was one who had never paid at all. Every
-- other outcome was permanent free use, and `farms.status` ('suspended'/'cancelled') was
-- read by no policy, no helper and no layout — it gated nothing anywhere.
--
-- THE SHAPE OF THE FIX, AND WHY IT IS NOT A READ-ONLY MODE
-- ─────────────────────────────────────────────────────────────────────────────
-- The obvious answer is "let them look but not write". That means every one of the
-- product's ~200 server actions has to check, and a single missed one is a write path into
-- an account that is not being paid for. F7 exists in this codebase precisely because
-- UI-only enforcement is not enforcement, and a half-applied read-only mode is the same
-- mistake wearing a friendlier face.
--
-- So a lapsed farm gets ONE more gate state instead: 'closed'. Every app route bounces to a
-- single screen that says what happened, offers to reopen, and hands over their data. One
-- screen is provable; two hundred guards are not. Nothing is deleted, which is the promise
-- the downgrade design has made since it shipped — this keeps it and stops it meaning
-- "free for ever".
--
-- THE WINDOW IS A SETTING, NOT A NUMBER IN A FUNCTION
-- ─────────────────────────────────────────────────────────────────────────────
-- `lapsed_grace_days` (default 30) is how long a farm keeps working after it lapses, on
-- whatever plan it has been left on. It is on `billing_settings` beside the retry offsets
-- and the grace days, so the commercial policy can be changed without a migration —
-- including setting it very high, which restores exactly today's behaviour if this turns
-- out to be too sharp.
--
-- WHAT 'CLOSED' IS MEASURED FROM
-- ─────────────────────────────────────────────────────────────────────────────
--     cancelled   -> ended_on          (set by app.billing_close_cancellations)
--     downgraded  -> downgraded_at     (set by app.billing_apply_downgrades)
-- with `updated_at` as a last resort, so a row written by hand before these engines
-- existed cannot produce a null date and fall through to 'ok' for ever.
--
-- THE TRAP THIS MIGRATION HAD TO AVOID, AGAIN
-- ─────────────────────────────────────────────────────────────────────────────
-- The same one the original gate documents: a farm with NO subscription row is still 'ok'.
-- Weltevrede Boerdery is on production with twelve vehicles and no subscription, as is
-- every farm onboarded before billing existed. Both farms on production are `status =
-- 'active'`, checked before writing this, so the new `farms.status` clause locks nobody out
-- today; 'trial' stays open too, because a trial is something we granted.

begin;

-- ── How long a lapsed farm keeps working ─────────────────────────────────────
alter table public.billing_settings
  add column if not exists lapsed_grace_days integer not null default 30;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'billing_settings_lapsed_grace_ck'
  ) then
    alter table public.billing_settings
      add constraint billing_settings_lapsed_grace_ck
      check (lapsed_grace_days between 0 and 3650);
  end if;
end
$$;

comment on column public.billing_settings.lapsed_grace_days is
  'Days a farm keeps working after its subscription reaches a terminal state (cancelled or '
  'downgraded) before app.farm_billing_gate answers ''closed''. 0 closes the next day; a '
  'very large value restores the pre-2026-09-11 behaviour of never closing.';

-- ── The gate ─────────────────────────────────────────────────────────────────
-- Still SECURITY DEFINER, and still for the reason the original gate spells out: the SELECT
-- policy on every billing table is `app.is_farm_billing_admin(farm_id)`, so an OPERATOR
-- reading the subscription through their own client sees nothing, and "nothing" would be
-- read as "no subscription, therefore fine". A gate that is right for owners and wrong for
-- drivers is worse than no gate.
create or replace function app.farm_billing_gate(p_farm uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  f public.farms%rowtype;
  s public.billing_subscriptions%rowtype;
  v_grace integer;
  v_since date;
begin
  select * into f from public.farms where id = p_farm;
  -- No such farm is not this function's problem to report; every caller already has a
  -- profile with a farm_id, and answering 'closed' here would turn a lookup miss into a
  -- lockout.
  if not found then return 'ok'; end if;

  -- Rapid Rise has ended or suspended the account. Independent of the billing engine, and
  -- deliberately checked first: a suspended farm should not be let in merely because its
  -- subscription happens to look healthy.
  if f.deleted_at is not null or f.status in ('suspended', 'cancelled') then
    return 'closed';
  end if;

  select * into s
    from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null
   order by created_at desc
   limit 1;

  -- Grandfathered: no subscription row at all. See the header — this is the branch that
  -- keeps the existing customer base in the product.
  if not found then return 'ok'; end if;

  if s.status = 'pending' then return 'pending'; end if;

  if s.status = 'cancelled' then
    v_since := coalesce(s.ended_on, s.cancelled_at::date, s.updated_at::date);
  elsif s.status = 'downgraded' then
    v_since := coalesce(s.downgraded_at::date, s.updated_at::date);
  else
    -- active, trialing, past_due, grace, non_renewing. Every one of these is a farm that is
    -- either paying or inside the dunning ladder, and the ladder's own steps are the
    -- pressure. Closing here would shut the door on somebody whose card failed yesterday.
    return 'ok';
  end if;

  select coalesce(lapsed_grace_days, 30) into v_grace
    from public.billing_settings where singleton;
  v_grace := coalesce(v_grace, 30);

  if v_since is not null and (v_since + v_grace) < current_date then
    return 'closed';
  end if;

  return 'ok';
end;
$fn$;

revoke execute on function app.farm_billing_gate(uuid) from public, anon, authenticated;
grant  execute on function app.farm_billing_gate(uuid) to service_role;

-- The public wrapper is unchanged in shape and still scoped by `app.has_farm_access`; it is
-- restated only so the grant set is stated in one place with the function it wraps.
create or replace function public.farm_billing_gate(p_farm uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when app.has_farm_access(p_farm) then app.farm_billing_gate(p_farm) else null end;
$$;
revoke execute on function public.farm_billing_gate(uuid) from public, anon;
grant  execute on function public.farm_billing_gate(uuid) to authenticated, service_role;

-- ── Coming back ──────────────────────────────────────────────────────────────
-- Reopening deliberately produces a PENDING subscription and an open invoice, which is the
-- exact state a fresh sign-up is in. That is the whole point: the payment is then taken by
-- `/activate` and `app.settle_billing_attempt`, the path that has been driven end to end on
-- production, rather than by a second payment route written for this case that could drift
-- away from it.
--
-- `ended_on` and the cancellation fields MUST be cleared here. `app.billing_restore_after_
-- payment` refuses to revive a subscription with `status = 'cancelled' or ended_on is not
-- null` — that is S5, and it is right: an in-flight charge completing after somebody
-- cancelled must not resubscribe them. But it means a reopen that left those fields set
-- would take the money and leave the farm shut, which is the one outcome worse than not
-- offering a reopen at all. An explicit reopen by the farm's billing admin is a different
-- act from a stray charge landing, and this is where that difference is expressed.
--
-- `plan_before_downgrade` is deliberately KEPT, so paying restores the plan they had.
create or replace function app.billing_reopen_subscription(p_farm uuid, p_by uuid default null)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  s public.billing_subscriptions%rowtype;
  v_open integer;
begin
  select * into s
    from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null
   order by created_at desc
   limit 1
   for update;

  if not found then
    raise exception 'BILLING: no subscription to reopen for this farm'
      using errcode = 'check_violation';
  end if;

  if s.status not in ('cancelled', 'downgraded') then
    raise exception 'BILLING: subscription is % and does not need reopening', s.status
      using errcode = 'check_violation';
  end if;

  update public.billing_subscriptions
     set status                = 'pending',
         ended_on              = null,
         cancelled_at          = null,
         cancel_at_period_end  = false,
         cancellation_reason   = null,
         -- Cleared so the generator computes a fresh period rather than reusing the one
         -- the farm lapsed in. It writes both back immediately, because reopening raises
         -- the bill there and then — the same shape a sign-up has, and deliberately not
         -- `app.start_billing_subscription`'s "leave it null until billing begins", which
         -- suits a subscription created ahead of any invoice.
         current_period_start  = null,
         current_period_end    = null,
         next_billing_on       = current_date,
         failed_attempt_count  = 0,
         next_retry_on         = null,
         grace_ends_on         = null,
         last_failure_code     = null,
         updated_at            = now()
   where id = s.id;

  -- If the unpaid invoice that caused the lapse is still open, that is what they owe and
  -- what `/activate` will present. Raising a second one would bill the same period twice.
  select count(*)::integer into v_open
    from public.billing_invoices
   where farm_id = p_farm and status = 'open' and deleted_at is null;

  if v_open = 0 then
    perform app.generate_billing_invoices(s.id);
  end if;

  return s.id;
end;
$fn$;

revoke execute on function app.billing_reopen_subscription(uuid, uuid) from public, anon, authenticated;
grant  execute on function app.billing_reopen_subscription(uuid, uuid) to service_role;

-- PostgREST exposes `public` only, so the engine needs a thin wrapper to be callable at
-- all. Service-role only: it is reached from a server action that has already established
-- the caller is this farm's billing admin, and a grant to `authenticated` would let any
-- signed-in user reopen somebody else's subscription.
create or replace function public.billing_reopen_subscription(p_farm uuid, p_by uuid default null)
returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_reopen_subscription(p_farm, p_by);
$$;
revoke execute on function public.billing_reopen_subscription(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.billing_reopen_subscription(uuid, uuid) to service_role;

commit;
