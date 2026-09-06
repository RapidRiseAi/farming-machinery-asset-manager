-- 20260906120000_billing_postgrest_wrappers.sql
-- The four `public.` wrappers the charging worker actually calls, plus the one thing
-- that brings a subscription into existence.
--
-- WHY THIS EXISTS, AND HOW IT WAS MISSED
-- ─────────────────────────────────────────────────────────────────────────────
-- 20260903160200 put every engine function in schema `app` and revoked it from
-- everyone but the owner. That is right: these move money. But PostgREST exposes
-- `public` and `graphql_public` ONLY — it answers PGRST106 for anything else — so
-- `supabase.rpc("billing_due_charges", …)` in src/lib/billing/service.ts resolved to
-- no function at all. Every call on the charging path failed at its first statement:
-- raising an invoice, claiming a charge, settling an attempt, listing what is due.
--
-- Nothing caught it. The TypeScript tests mock the Supabase client, so they assert the
-- ARGUMENTS are right and never that the function exists. `db:test` builds a database
-- from the migrations and never calls it the way the app does. The build compiles a
-- string. It was found by inventorying every `.rpc("…")` name in the app against
-- `pg_proc` on the live database — the same "count objects, not migrations" technique
-- docs/SCHEMA_DRIFT.md records, pointed at the calling side instead of the schema.
--
-- These are thin pass-throughs on purpose. No logic lives here: the rules stay in the
-- `app` functions, which are already asserted by supabase/tests/billing_subscription.sql.
-- The wrapper exists only to be reachable, and is granted to service_role ALONE — a
-- farmer's browser must never be able to raise an invoice or settle a payment.

-- ── The charging path ────────────────────────────────────────────────────────

create or replace function public.billing_due_charges(p_limit integer default 50)
returns table (
  invoice_id uuid, farm_id uuid, subscription_id uuid,
  payment_method_id uuid, amount_incl_cents bigint, invoice_ref text,
  attempt_number integer
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.due_billing_charges(p_limit);
$$;

create or replace function public.billing_claim_charge(
  p_invoice uuid, p_ref text, p_kind billing_attempt_kind, p_amount bigint
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.claim_billing_charge(p_invoice, p_ref, p_kind, p_amount);
$$;

create or replace function public.billing_settle_attempt(
  p_attempt          uuid,
  p_status           billing_attempt_status,
  p_transaction_id   bigint default null,
  p_provider_ref     text default null,
  p_gateway_response text default null,
  p_failure_reason   text default null,
  p_paid_cents       bigint default null,
  p_channel          text default null
) returns void
language sql security definer set search_path = public, pg_temp as $$
  select app.settle_billing_attempt(
    p_attempt, p_status, p_transaction_id, p_provider_ref,
    p_gateway_response, p_failure_reason, p_paid_cents, p_channel
  );
$$;

create or replace function public.billing_generate_invoices(p_only uuid default null)
returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.generate_billing_invoices(p_only);
$$;

-- ── Bringing a subscription into existence ───────────────────────────────────
--
-- Nothing in the product created one. `beginCheckout` refuses with
-- `billing-no-subscription`, so a farm could never start paying: the whole feature was
-- reachable only by hand-writing a row. The trial length, and therefore the first
-- billing date, is policy and so is read from `billing_settings` rather than typed at
-- the call site; an explicit `p_trial_days` overrides it for the case where a farm is
-- onboarded mid-cycle or is being tested.
--
-- `current_period_start` is deliberately left NULL. The generator computes the first
-- period as `coalesce(current_period_start, next_billing_on)`, so a null makes the
-- first BILLED period begin when billing begins — not on the day somebody happened to
-- press the button, which would bill a customer for their own trial.

create or replace function app.start_billing_subscription(
  p_farm uuid, p_plan farm_plan, p_period billing_period, p_trial_days integer default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v       public.billing_settings%rowtype;
  v_id    uuid;
  v_trial integer;
  v_end   date;
  v_start date := current_date;
begin
  if p_farm is null then
    raise exception 'BILLING: a subscription needs a farm';
  end if;
  if not exists (select 1 from public.farms where id = p_farm and deleted_at is null) then
    raise exception 'BILLING: no such farm %', p_farm;
  end if;

  select * into v from public.billing_settings where singleton;

  -- One live subscription per farm. `billing_subscriptions_farm_uq` enforces it; this
  -- turns the constraint into a sentence rather than a duplicate-key stack trace.
  if exists (
    select 1 from public.billing_subscriptions where farm_id = p_farm and deleted_at is null
  ) then
    raise exception 'BILLING: farm % already has a subscription', p_farm
      using errcode = 'unique_violation';
  end if;

  v_trial := greatest(coalesce(p_trial_days, v.trial_days, 0), 0);
  v_end   := case when v_trial > 0 then v_start + v_trial else null end;

  insert into public.billing_subscriptions (
    farm_id, plan, billing_period, status,
    trial_ends_on, anchor_day, current_period_start, next_billing_on, created_by
  ) values (
    p_farm, p_plan, p_period,
    -- Cast explicitly: a CASE over two bare literals resolves to `text`, and the
    -- insert then fails with "column status is of type billing_subscription_status".
    case when v_end is not null then 'trialing'::billing_subscription_status
         else 'active'::billing_subscription_status end,
    v_end,
    extract(day from v_start)::integer,
    null,
    coalesce(v_end + 1, v_start),
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end $$;

create or replace function public.billing_start_subscription(
  p_farm uuid, p_plan farm_plan, p_period billing_period, p_trial_days integer default null
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.start_billing_subscription(p_farm, p_plan, p_period, p_trial_days);
$$;

-- ── Grants: service_role and nothing else ────────────────────────────────────

do $do$
declare f text;
begin
  foreach f in array array[
    'public.billing_due_charges(integer)',
    'public.billing_claim_charge(uuid, text, billing_attempt_kind, bigint)',
    'public.billing_settle_attempt(uuid, billing_attempt_status, bigint, text, text, text, bigint, text)',
    'public.billing_generate_invoices(uuid)',
    'public.billing_start_subscription(uuid, farm_plan, billing_period, integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant  execute on function %s to service_role', f);
  end loop;
end $do$;

-- The engine function itself is reached ONLY through its wrapper, like every other
-- `app` function here. Granting it to service_role as well would make a second, direct
-- entry point that nothing else uses — which the suite's (j) lockdown rejects by design.
revoke execute on function app.start_billing_subscription(uuid, farm_plan, billing_period, integer)
  from public, anon, authenticated, service_role;
