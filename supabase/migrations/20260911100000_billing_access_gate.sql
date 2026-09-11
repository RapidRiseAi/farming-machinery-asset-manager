-- 20260911100000_billing_access_gate.sql
-- A farm that has not paid yet gets no access. Everybody else is untouched.
--
-- THE RULE, AND THE ONE WAY TO GET IT WRONG
-- ─────────────────────────────────────────────────────────────────────────────
-- The gate is "a subscription EXISTS and it is pending". It is NOT "there is no active
-- subscription", and the difference is the whole migration:
--
--     no subscription row     -> ok        grandfathered, and every admin-created farm
--     subscription = pending  -> pending   signed up, has not paid
--     anything else           -> ok        today's rules, unchanged
--
-- Weltevrede Boerdery is on production right now with twelve vehicles and no subscription
-- row at all, and so is every farm onboarded before billing existed. If absence of a
-- subscription meant no access, this would lock out the entire customer base on the day it
-- shipped. That is the same trap the quota migration had to avoid a day earlier, wearing
-- different clothes.
--
-- WHY IT IS A FUNCTION AND NOT A SELECT
-- ─────────────────────────────────────────────────────────────────────────────
-- The obvious implementation is for the app layout to read `billing_subscriptions` through
-- the caller's own RLS client. That works for an owner and silently fails open for
-- everybody else: the SELECT policy on every billing table is
-- `using (app.is_farm_billing_admin(farm_id))`, so an OPERATOR on a pending farm reads no
-- row, the layout concludes "no subscription, therefore fine", and a farm that has paid
-- nothing is fully usable by its drivers.
--
-- A gate that is correct for one role and wrong for the rest is worse than no gate,
-- because it looks like it works.
--
-- So the gate must see the subscription regardless of who is asking. TWO functions carry
-- that, and it is worth being exact about which one does the work: the PUBLIC wrapper is
-- SECURITY DEFINER, and a definer function's callee runs as the definer as well — so the
-- wrapper alone is already enough to make the answer role-independent. The inner function
-- is definer too, as a second lock for any future caller that reaches it directly.
--
-- Mutation-testing shows exactly that: flipping the inner function to SECURITY INVOKER on
-- its own changes nothing, and only breaking BOTH makes the assertion fire. That is
-- double-enforcement, not an assertion that cannot fail, and the suite carries a mutant
-- for each so the distinction stays visible.
--
-- The wrapper is scoped by `app.has_farm_access`, which is the same shape and the same four
-- arguments as `public.farm_vehicle_allowance` in 20260910230000: it only READS, it answers
-- only about a farm the caller can already reach, it returns no money and no credential,
-- and the screen genuinely needs it.
--
-- WHAT IT DELIBERATELY DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- It does not look at `farms.status`. Suspending a farm is an administrator's act with its
-- own meaning, and folding it in here would make one switch do two jobs. It does not look
-- at `cancelled` either: a farm that cancelled keeps its records, and locking them out of
-- their own maintenance history the moment they stop paying is not what any part of this
-- product does — the dunning ladder reduces the PLAN and deletes nothing.
--
-- Suite section (w) covers it, mutation-tested.

create or replace function app.farm_billing_gate(p_farm uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
           when exists (
             select 1 from public.billing_subscriptions s
              where s.farm_id = p_farm
                and s.deleted_at is null
                and s.status = 'pending'
           ) then 'pending'
           -- Everything else, including no row at all. See the header: this branch is what
           -- grandfathers every farm that existed before self-serve sign-up.
           else 'ok'
         end;
$$;
revoke execute on function app.farm_billing_gate(uuid) from public, anon;
grant  execute on function app.farm_billing_gate(uuid) to authenticated, service_role;

comment on function app.farm_billing_gate(uuid) is
  'Whether a farm may be used: ''pending'' only when a subscription row exists and is '
  'pending. SECURITY DEFINER because the billing SELECT policy admits only a farm''s '
  'billing admin, and a gate that is correct for owners and fails open for operators is '
  'worse than no gate.';

create or replace function public.farm_billing_gate(p_farm uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when app.has_farm_access(p_farm) then app.farm_billing_gate(p_farm) else null end;
$$;
revoke execute on function public.farm_billing_gate(uuid) from public, anon;
grant  execute on function public.farm_billing_gate(uuid) to authenticated, service_role;
