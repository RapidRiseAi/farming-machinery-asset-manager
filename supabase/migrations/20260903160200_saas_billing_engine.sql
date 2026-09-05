-- 20260903160200_saas_billing_engine.sql
-- FleetWise SaaS subscription billing — the engine.
--
-- Counting, invoicing, claiming a charge, settling it, and chasing a farm that has not
-- paid. Follows the 0205 engine pattern used by every other scheduled job in this
-- product: SECURITY DEFINER with a pinned search_path, execute revoked from
-- public/anon/authenticated, and a thin `public.cron_*` wrapper the nightly route calls.
--
-- WHY THE NETWORK CALL IS NOT IN HERE
-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing in this file talks to Paystack. Charging is split deliberately into three
-- short database transactions with the HTTP request BETWEEN them:
--
--     1. claim   — mint a reference and take the lock          (fast, transactional)
--     2. charge  — POST to Paystack                            (slow, no transaction)
--     3. settle  — record what happened                        (fast, transactional)
--
-- Holding a transaction open across a payment API call is how a connection pool dies at
-- 03:00 and how a row stays locked long after the process that locked it has gone. It
-- also means a timeout in step 2 leaves a durable, visible `pending`/`unknown` row —
-- which is precisely what makes recovery possible instead of guesswork.
--
-- THE DOUBLE-CHARGE PROBLEM, AND HOW IT IS ACTUALLY PREVENTED
-- ─────────────────────────────────────────────────────────────────────────────
-- Not by "checking first". Two workers both check, both see nothing in flight, and both
-- charge. It is prevented by a UNIQUE INDEX
-- (`billing_payment_attempts_inflight_uq`, migration ...160100): at most one attempt per
-- invoice may be `pending` or `unknown`. Claiming IS inserting that row, so the second
-- worker loses on a duplicate key and is told so, in the same instant, by the database.
--
-- A lost HTTP response therefore never justifies a second charge. The attempt sits in
-- `unknown`, it blocks the index, and the only way forward is to ask Paystack what
-- happened to that exact reference.


-- ══════════════════════════════════════════════════════════════════════════════
-- What is billable
-- ══════════════════════════════════════════════════════════════════════════════
-- Non-deleted machines, excluding `retired` and `sold`. `out_of_service` STILL COUNTS —
-- a broken tractor is still a tractor on the system, still holding its history, still
-- costing us to host.
--
-- This is character-for-character the definition `app.recount_farm_assets` (0251) already
-- uses to maintain `farms.asset_count`, and the isolation suite asserts the two agree.
-- It exists separately only so the billing engine reads a live count rather than a
-- denormalised one at the moment it matters: an invoice must be defensible.
create or replace function app.billable_asset_count(p_farm uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer
    from public.machines m
   where m.farm_id = p_farm
     and m.deleted_at is null
     and m.status not in ('retired', 'sold');
$$;
revoke execute on function app.billable_asset_count(uuid) from public, anon, authenticated;
grant  execute on function app.billable_asset_count(uuid) to service_role;

comment on function app.billable_asset_count(uuid) is
  'Billable vehicles: non-deleted, not retired, not sold. out_of_service still counts. '
  'Identical to the rule app.recount_farm_assets uses for farms.asset_count (0251).';


-- Nightly evidence of the count, one row per farm per day.
create or replace function app.capture_billing_asset_snapshots(p_source text default 'nightly')
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_rows integer;
begin
  insert into public.billing_asset_snapshots (farm_id, subscription_id, captured_on, asset_count, source)
  select f.id, s.id, current_date, app.billable_asset_count(f.id), p_source
    from public.farms f
    left join public.billing_subscriptions s
           on s.farm_id = f.id and s.deleted_at is null
   where f.deleted_at is null
  on conflict (farm_id, captured_on, source) do update
     set asset_count = excluded.asset_count;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;
revoke execute on function app.capture_billing_asset_snapshots(text) from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- The invoice reference
-- ══════════════════════════════════════════════════════════════════════════════
-- FW-2026-000001. A sequence rather than a counter column, because there is exactly one
-- issuer here and a sequence is the one allocator that cannot hand the same number to
-- two concurrent callers.
--
-- The loop is not paranoia: 0384 had to be written on the partner side after a counter
-- and its rows drifted apart (as they do after a restore or an import) and "Start it"
-- began failing with a raw unique-violation while creating nothing. A sequence makes
-- that far less likely, and skipping a taken number makes it impossible.
create sequence if not exists billing_invoice_ref_seq;

create or replace function app.next_billing_invoice_ref() returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ref text; v_n bigint; v_guard integer := 0;
begin
  loop
    v_n := nextval('public.billing_invoice_ref_seq');
    v_ref := 'FW-' || to_char(current_date, 'YYYY') || '-' || lpad(v_n::text, 6, '0');
    exit when not exists (select 1 from public.billing_invoices where invoice_ref = v_ref);
    v_guard := v_guard + 1;
    if v_guard > 1000 then
      raise exception 'BILLING: could not allocate an unused invoice reference after 1000 tries';
    end if;
  end loop;
  return v_ref;
end $$;
revoke execute on function app.next_billing_invoice_ref() from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Which price applies
-- ══════════════════════════════════════════════════════════════════════════════
-- Returns nothing when there is no active version, which is the state this system ships
-- in and the reason it cannot bill anybody by accident.
create or replace function app.billing_active_price(p_plan farm_plan, p_period billing_period)
returns billing_price_versions
language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.billing_price_versions
   where plan = p_plan and billing_period = p_period
     and status = 'active' and deleted_at is null
     and (effective_from is null or effective_from <= current_date)
     and (effective_to   is null or effective_to   >= current_date)
   limit 1;
$$;
revoke execute on function app.billing_active_price(farm_plan, billing_period) from public, anon;
grant  execute on function app.billing_active_price(farm_plan, billing_period) to authenticated, service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- Raising the invoices that are due
-- ══════════════════════════════════════════════════════════════════════════════
-- Idempotent on TWO independent mechanisms, because one of them is a race and the other
-- is a repeat:
--
--   * `billing_invoices_farm_period_uq` makes a second invoice for the same farm and
--     period a duplicate-key error. That covers two workers at the same instant.
--   * advancing `next_billing_on` past the period covers a cron that fires twice an hour
--     apart, and a human pressing "raise it now".
--
-- Skipped, with the reason recorded in the return count rather than raised: a farm with
-- no active price, a bespoke (price-on-application) plan, zero billable vehicles, a
-- cancelled subscription, or a farm still inside its trial. A zero-rand invoice is not a
-- kindness — Paystack will not process a zero charge, and it would sit "open" forever.
create or replace function app.generate_billing_invoices(p_only uuid default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s          public.billing_subscriptions%rowtype;
  v_price    public.billing_price_versions%rowtype;
  v_settings public.billing_settings%rowtype;
  v_farm     public.farms%rowtype;
  v_count    integer;
  v_ref      text;
  v_invoice  uuid;
  v_made     integer := 0;
  v_pstart   date;
  v_pend     date;
begin
  select * into v_settings from public.billing_settings where singleton;

  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       and (p_only is null or id = p_only)
       and status in ('active', 'past_due', 'trialing', 'non_renewing')
       and next_billing_on is not null
       and next_billing_on <= current_date
     order by next_billing_on
     -- Two workers must not both raise this farm's invoice. The one that loses the lock
     -- simply skips the row rather than waiting for a transaction it has no interest in.
     for update skip locked
  loop
    -- Still in the trial: nothing is owed yet.
    if s.status = 'trialing' and s.trial_ends_on is not null and s.trial_ends_on >= current_date then
      continue;
    end if;

    select * into v_price from app.billing_active_price(s.plan, s.billing_period);
    if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
      continue;   -- no confirmed price, or price-on-application: never auto-bill
    end if;

    v_count := app.billable_asset_count(s.farm_id);
    if v_count <= 0 then
      -- Nothing to bill for. Move the date on so we do not reconsider it every night.
      update public.billing_subscriptions
         set next_billing_on = app.billing_advance_period(coalesce(next_billing_on, current_date), billing_period, anchor_day),
             updated_at = now()
       where id = s.id;
      continue;
    end if;

    v_pstart := coalesce(s.current_period_start, s.next_billing_on);
    v_pend   := app.billing_advance_period(v_pstart, s.billing_period, s.anchor_day) - 1;

    select * into v_farm from public.farms where id = s.farm_id;

    v_ref := app.next_billing_invoice_ref();

    begin
      insert into public.billing_invoices (
        farm_id, subscription_id, invoice_ref, status,
        period_start, period_end, issued_on, due_on,
        plan, billing_period, asset_count,
        unit_price_incl_cents, months_charged,
        price_version_id, price_version_label, vat_rate_bps,
        seller_vat_number, seller_snapshot, bill_to_snapshot
      ) values (
        -- DRAFT, deliberately, and not 'open'.
        --
        -- An invoice is a draft while it is being assembled — that is what the word
        -- means, and `app.billing_freeze_invoice_line` enforces it: no line may be
        -- written to an invoice that has already been issued. Creating this row as
        -- 'open' and then adding its own lines made the generator raise
        -- "invoice lines are immutable once the invoice is issued" on EVERY invoice.
        -- It is issued a few statements below, once it is complete.
        s.farm_id, s.id, v_ref, 'draft',
        v_pstart, v_pend, current_date, current_date + coalesce(v_settings.payment_terms_days, 0),
        s.plan, s.billing_period, v_count,
        v_price.per_vehicle_monthly_incl_cents, v_price.months_charged,
        v_price.id, v_price.version_label, v_price.vat_rate_bps,
        v_settings.vat_number,
        jsonb_build_object(
          'legal_name', v_settings.legal_name,
          'trading_name', v_settings.trading_name,
          'reg_number', v_settings.reg_number,
          'vat_registered', v_settings.vat_registered,
          'billing_address', v_settings.billing_address,
          'billing_email', v_settings.billing_email
        ),
        jsonb_build_object(
          'name', v_farm.name,
          'trading_name', v_farm.trading_name,
          'reg_number', v_farm.reg_number,
          'vat_number', v_farm.vat_number,
          'billing_address', v_farm.billing_address,
          'billing_email', v_farm.billing_email
        )
      )
      returning id into v_invoice;
    exception when unique_violation then
      -- Another worker got there first, or this period was already billed. Correct
      -- outcome either way: there is exactly one invoice, and it is not ours to make.
      continue;
    end;

    insert into public.billing_invoice_lines (
      invoice_id, farm_id, sort_order, description, qty, months_charged,
      unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
    )
    select
      v_invoice, s.farm_id, 0,
      'FleetWise ' || s.plan::text || ' — ' || v_count::text || ' vehicle(s)',
      v_count, v_price.months_charged,
      v_price.per_vehicle_monthly_incl_cents,
      i.total,
      app.ex_vat_cents(i.total, i.rate),
      i.total - app.ex_vat_cents(i.total, i.rate)
    from (
      select
        (v_price.per_vehicle_monthly_incl_cents * v_count * v_price.months_charged)::bigint as total,
        -- Read the rate BACK off the invoice: the VAT guard may have forced it to zero,
        -- and a line that disagreed with its own invoice would be the worst of both.
        (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate
    ) i;

    -- ISSUE IT. The lines are written, the totals are derived, and from this moment the
    -- pricing snapshot is frozen: `app.billing_freeze_invoice` refuses any further change
    -- to what was supplied or what it cost, while still permitting payment, void and
    -- write-off. Assembling as a draft and issuing in one transaction means nobody ever
    -- sees a half-built invoice.
    update public.billing_invoices set status = 'open' where id = v_invoice;

    insert into public.billing_asset_snapshots (farm_id, subscription_id, captured_on, asset_count, source)
    values (s.farm_id, s.id, current_date, v_count, 'period_close')
    on conflict (farm_id, captured_on, source) do update set asset_count = excluded.asset_count;

    update public.billing_subscriptions
       set current_period_start = v_pstart,
           current_period_end   = v_pend,
           next_billing_on      = v_pend + 1,
           price_version_label  = coalesce(price_version_label, v_price.version_label),
           status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
           updated_at = now()
     where id = s.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;
revoke execute on function app.generate_billing_invoices(uuid) from public, anon, authenticated;


-- Moving a billing date on by one period, with the anchor honoured.
-- The 31st plus one month is the 28th of February in Postgres, which is what a business
-- expects — but the NEXT month must go back to the 31st, not stay on the 28th. That is
-- what `anchor_day` is for, and why this is a function rather than `+ interval`.
create or replace function app.billing_advance_period(
  p_from date, p_period billing_period, p_anchor integer default null
) returns date
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_next date; v_month_start date; v_days integer;
begin
  v_next := case p_period
              when 'monthly' then (p_from + interval '1 month')::date
              when 'annual'  then (p_from + interval '1 year')::date
            end;
  if p_anchor is null then
    return v_next;
  end if;
  -- Re-seat on the anchor, clamped to the length of the month it lands in.
  v_month_start := date_trunc('month', v_next)::date;
  v_days := extract(day from (v_month_start + interval '1 month' - interval '1 day'))::integer;
  return v_month_start + (least(p_anchor, v_days) - 1);
end $$;
revoke execute on function app.billing_advance_period(date, billing_period, integer) from public, anon;
grant  execute on function app.billing_advance_period(date, billing_period, integer) to authenticated, service_role;


-- ══════════════════════════════════════════════════════════════════════════════
-- Claiming a charge
-- ══════════════════════════════════════════════════════════════════════════════
-- Returns the invoices a worker MAY attempt: open, unpaid, past due, on a subscription
-- with a reusable stored card, and — critically — with no attempt already in flight.
create or replace function app.due_billing_charges(p_limit integer default 50)
returns table (
  invoice_id uuid, farm_id uuid, subscription_id uuid,
  payment_method_id uuid, amount_incl_cents bigint, invoice_ref text,
  attempt_number integer
)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.farm_id, i.subscription_id, s.default_payment_method_id,
         i.total_incl_cents - i.amount_paid_cents,
         i.invoice_ref,
         (select count(*)::integer + 1 from public.billing_payment_attempts a
           where a.invoice_id = i.id)
    from public.billing_invoices i
    join public.billing_subscriptions s on s.id = i.subscription_id and s.deleted_at is null
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     and coalesce(i.due_on, i.issued_on, current_date) <= current_date
     and s.status in ('active', 'past_due')
     and coalesce(s.next_retry_on, current_date) <= current_date
     -- Nothing in flight. A row in `unknown` deliberately blocks this farm entirely
     -- until somebody has reconciled it.
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
   order by i.due_on nulls last, i.created_at
   limit greatest(p_limit, 0);
$$;
revoke execute on function app.due_billing_charges(integer) from public, anon, authenticated;


-- Mint the reference and take the lock, in one statement. Returns null when another
-- worker already holds the claim — the caller treats that as "not mine", not as an error.
create or replace function app.claim_billing_charge(
  p_invoice uuid, p_ref text, p_kind billing_attempt_kind, p_amount bigint
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_farm uuid; v_sub uuid; v_pm uuid; v_n integer;
begin
  select i.farm_id, i.subscription_id, s.default_payment_method_id
    into v_farm, v_sub, v_pm
    from public.billing_invoices i
    left join public.billing_subscriptions s on s.id = i.subscription_id
   where i.id = p_invoice and i.deleted_at is null
   for update of i;

  if v_farm is null then
    return null;
  end if;

  select count(*)::integer + 1 into v_n
    from public.billing_payment_attempts where invoice_id = p_invoice;

  begin
    insert into public.billing_payment_attempts (
      farm_id, invoice_id, subscription_id, payment_method_id,
      attempt_ref, kind, status, attempt_number, amount_incl_cents
    ) values (
      v_farm, p_invoice, v_sub, v_pm,
      p_ref, p_kind, 'pending', v_n, p_amount
    ) returning id into v_id;
  exception when unique_violation then
    -- Either another worker is mid-charge on this invoice, or this exact reference has
    -- been used. Both mean: not ours.
    return null;
  end;

  return v_id;
end $$;
revoke execute on function app.claim_billing_charge(uuid, text, billing_attempt_kind, bigint)
  from public, anon, authenticated;


-- Record what the provider said. The ONLY place a payment row is created, so "money
-- received" has exactly one origin and it is always tied to an attempt we minted.
create or replace function app.settle_billing_attempt(
  p_attempt          uuid,
  p_status           billing_attempt_status,
  p_transaction_id   bigint default null,
  p_provider_ref     text default null,
  p_gateway_response text default null,
  p_failure_reason   text default null,
  p_paid_cents       bigint default null,
  p_channel          text default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.billing_payment_attempts%rowtype;
begin
  select * into a from public.billing_payment_attempts where id = p_attempt for update;
  if not found then
    raise exception 'BILLING: no such payment attempt %', p_attempt;
  end if;

  update public.billing_payment_attempts
     set status = p_status,
         provider_transaction_id = coalesce(p_transaction_id, provider_transaction_id),
         provider_reference      = coalesce(p_provider_ref, provider_reference, attempt_ref),
         gateway_response        = coalesce(p_gateway_response, gateway_response),
         failure_reason          = coalesce(p_failure_reason, failure_reason),
         resolved_at             = case when p_status in ('succeeded','failed','abandoned')
                                        then now() else resolved_at end,
         updated_at              = now()
   where id = p_attempt;

  if p_status = 'succeeded' then
    -- `on conflict do nothing` on the transaction id is what makes a webhook and a
    -- verify call racing to record the same success harmless: whichever arrives second
    -- writes nothing, and the rollup trigger has already moved the invoice.
    insert into public.billing_payments (
      farm_id, invoice_id, attempt_id, amount_incl_cents,
      provider, provider_reference, provider_transaction_id, channel, paid_at
    ) values (
      a.farm_id, a.invoice_id, a.id, coalesce(p_paid_cents, a.amount_incl_cents),
      a.provider, coalesce(p_provider_ref, a.attempt_ref), p_transaction_id, p_channel, now()
    )
    on conflict do nothing;

    -- Payment clears the dunning state and, if they were downgraded, gives the plan back.
    if a.subscription_id is not null then
      perform app.billing_restore_after_payment(a.subscription_id);
    end if;

    update public.billing_payment_methods
       set last_used_at = now() where id = a.payment_method_id;

  elsif p_status = 'failed' and a.subscription_id is not null then
    perform app.billing_register_failure(a.subscription_id, p_failure_reason);
  end if;
end $$;
revoke execute on function app.settle_billing_attempt(uuid, billing_attempt_status, bigint, text, text, text, bigint, text)
  from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Dunning
-- ══════════════════════════════════════════════════════════════════════════════
-- A failure schedules the next retry from the policy in `billing_settings`. When the
-- retries run out the farm enters GRACE — still fully entitled, because the most common
-- reason a card fails in farming is that the money arrives next week, and locking
-- somebody out of their maintenance records over a timing problem is both wrong and bad
-- business.
create or replace function app.billing_register_failure(p_sub uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v public.billing_settings%rowtype;
        v_n integer; v_offset integer;
begin
  select * into v from public.billing_settings where singleton;
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  v_n := s.failed_attempt_count + 1;

  if v_n <= array_length(v.retry_offsets_days, 1) then
    v_offset := v.retry_offsets_days[v_n];
    update public.billing_subscriptions
       set status = 'past_due',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = current_date + v_offset,
           grace_ends_on = null,
           updated_at = now()
     where id = p_sub;
  else
    -- Retries exhausted. Access continues for the grace period.
    update public.billing_subscriptions
       set status = 'grace',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = null,
           grace_ends_on = coalesce(grace_ends_on, current_date + v.grace_days),
           updated_at = now()
     where id = p_sub;
  end if;
end $$;
revoke execute on function app.billing_register_failure(uuid, text) from public, anon, authenticated;


-- Grace has run out. Reduce the EFFECTIVE plan and nothing else.
--
-- Nothing is deleted, nothing is exported away, no machine is touched. The commercial
-- plan is kept on the subscription, and what `farms.plan` held is kept beside it, so
-- recovery restores the exact prior state rather than inferring it.
create or replace function app.billing_apply_downgrades() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v public.billing_settings%rowtype;
        v_prev farm_plan; v_done integer := 0;
begin
  select * into v from public.billing_settings where singleton;

  for s in
    select * from public.billing_subscriptions
     where deleted_at is null and status = 'grace'
       and grace_ends_on is not null and grace_ends_on < current_date
     for update skip locked
  loop
    select plan into v_prev from public.farms where id = s.farm_id;

    -- Already at or below the downgrade target: record the state, change nothing.
    if app.plan_rank(v_prev) > app.plan_rank(v.downgrade_to_plan) then
      update public.farms set plan = v.downgrade_to_plan where id = s.farm_id;
    end if;

    update public.billing_subscriptions
       set status = 'downgraded',
           plan_before_downgrade = coalesce(plan_before_downgrade, v_prev),
           downgraded_at = now(),
           updated_at = now()
     where id = s.id;

    -- `app.notify_farm` already targets the farm's owners and managers and honours each
    -- person's in-app preference and quiet hours (0205/0261). It is not passed a role list
    -- because it does not take one: the audience is part of the function's definition.
    perform app.notify_farm(
      s.farm_id,
      'billing_downgraded',
      jsonb_build_object('plan', v.downgrade_to_plan::text, 'previous_plan', v_prev::text)
    );

    v_done := v_done + 1;
  end loop;

  return v_done;
end $$;
revoke execute on function app.billing_apply_downgrades() from public, anon, authenticated;


-- A payment arrived. Clear the dunning state and hand back exactly what was taken.
create or replace function app.billing_restore_after_payment(p_sub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype;
begin
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  if s.plan_before_downgrade is not null then
    update public.farms set plan = s.plan_before_downgrade where id = s.farm_id;
  end if;

  update public.billing_subscriptions
     set status = case
                    when cancel_at_period_end then 'non_renewing'::billing_subscription_status
                    else 'active'::billing_subscription_status
                  end,
         failed_attempt_count = 0,
         next_retry_on = null,
         grace_ends_on = null,
         plan_before_downgrade = null,
         downgraded_at = null,
         last_failure_code = null,
         updated_at = now()
   where id = p_sub;
end $$;
revoke execute on function app.billing_restore_after_payment(uuid) from public, anon, authenticated;


-- Reminders for a farm whose payment has failed. In-app and (through the existing
-- delivery layer) email and push. Billing must work with no WhatsApp anywhere near it.
-- Weekly dedupe read from the notification queue itself, the same way F13's reminders do
-- it, so no new column is needed to remember what has been said.
create or replace function app.enqueue_billing_reminders() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_tpl text; v_sent integer := 0;
begin
  for s in
    select * from public.billing_subscriptions
     where deleted_at is null and status in ('past_due', 'grace', 'downgraded')
  loop
    v_tpl := case s.status
               when 'past_due'   then 'billing_payment_failed'
               when 'grace'      then 'billing_grace_ending'
               when 'downgraded' then 'billing_downgraded'
             end;

    if exists (
      select 1 from public.notifications n
       where n.farm_id = s.farm_id
         and n.template = v_tpl
         and n.created_at > now() - interval '7 days'
    ) then
      continue;
    end if;

    perform app.notify_farm(
      s.farm_id,
      v_tpl,
      jsonb_build_object(
        'failed_attempts', s.failed_attempt_count,
        'next_retry_on',   s.next_retry_on,
        'grace_ends_on',   s.grace_ends_on,
        'last_failure',    s.last_failure_code
      )
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;
revoke execute on function app.enqueue_billing_reminders() from public, anon, authenticated;


-- Cancellations that have reached their period end.
create or replace function app.billing_close_cancellations() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_done integer;
begin
  with closed as (
    update public.billing_subscriptions
       set status = 'cancelled', ended_on = current_date, updated_at = now()
     where deleted_at is null
       and status = 'non_renewing'
       and current_period_end is not null
       and current_period_end < current_date
    returning id
  )
  select count(*)::integer into v_done from closed;
  return v_done;
end $$;
revoke execute on function app.billing_close_cancellations() from public, anon, authenticated;


-- ══════════════════════════════════════════════════════════════════════════════
-- Cron wrappers
-- ══════════════════════════════════════════════════════════════════════════════
-- Thin `public.*` wrappers so the authenticated cron route can call them by name,
-- exactly as the other fourteen nightly engines are called. Execute is granted to
-- service_role only: the route holds the service key and nothing else may run these.
create or replace function public.cron_capture_billing_snapshots() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.capture_billing_asset_snapshots('nightly');
$$;

create or replace function public.cron_generate_billing_invoices() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.generate_billing_invoices(null);
$$;

create or replace function public.cron_apply_billing_downgrades() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_apply_downgrades();
$$;

create or replace function public.cron_enqueue_billing_reminders() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.enqueue_billing_reminders();
$$;

create or replace function public.cron_close_billing_cancellations() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_close_cancellations();
$$;

do $do$
declare f text;
begin
  foreach f in array array[
    'public.cron_capture_billing_snapshots()',
    'public.cron_generate_billing_invoices()',
    'public.cron_apply_billing_downgrades()',
    'public.cron_enqueue_billing_reminders()',
    'public.cron_close_billing_cancellations()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant  execute on function %s to service_role', f);
  end loop;
end $do$;
