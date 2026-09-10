-- 20260910120000_billing_period_advance.sql
-- Every farm was invoiced ONCE, ever, and the cron reported it as healthy.
--
-- THE DEFECT
-- ─────────────────────────────────────────────────────────────────────────────
-- `app.generate_billing_invoices` computed the period it was about to bill as
--
--     v_pstart := coalesce(s.current_period_start, s.next_billing_on);
--
-- and then, a few statements later, wrote `current_period_start = v_pstart` back onto the
-- subscription. So the SECOND time a farm came due, `coalesce` found the value the
-- function itself had written on the FIRST run, recomputed the identical period, lost to
-- `billing_invoices_farm_period_uq`, and hit the `continue` — which skips the block that
-- advances `next_billing_on`. The row is then permanently stuck: due today, forever,
-- producing nothing.
--
-- Driven rather than reasoned about (three consecutive billing dates, moving only
-- `next_billing_on`, which is the only thing that really changes when a month passes):
--
--     run 1  -> 1 invoice   period 10 Sep .. 09 Oct, next_billing_on 10 Oct
--     run 2  -> 0 invoices  period UNCHANGED, next_billing_on dragged back to today
--     run 3  -> 0 invoices  identical
--
-- Revenue stops after one period. There is no error and no alert: the function returns
-- 0, which the cron reports as `generate_invoices: ok`. It also burns a value off
-- `billing_invoice_ref_seq` on every failed attempt, so the invoice numbering acquires
-- permanent gaps — the sequence had reached 3 while exactly one invoice existed.
--
-- WHY NOTHING CAUGHT IT
-- ─────────────────────────────────────────────────────────────────────────────
-- Every test of this generator hand-advanced `current_period_start` before calling it —
-- the isolation suite at section (i2), and every staging script used to drive production
-- this week. That is exactly the column the bug fails to advance, so priming it made the
-- generator look correct while hiding the only thing worth testing. Section (f) runs the
-- generator twice on the same day, when the row is no longer selected at all.
--
-- THE FIX
-- ─────────────────────────────────────────────────────────────────────────────
-- The next period begins the day after the last one ENDED — a value the function reads
-- but never rewrites in a way that can feed back into itself:
--
--     v_pstart := coalesce(s.current_period_end + 1, s.next_billing_on);
--
-- On a brand-new subscription `current_period_end` is NULL, so the first period still
-- starts at `next_billing_on`. Nothing else about the function changes; the body below
-- was extracted programmatically from 20260903160200 rather than retyped, because
-- hand-transcribing a function body has gone wrong three times in this project.
--
-- Suite section (p) drives three consecutive billing dates and asserts a second invoice
-- for a second period, so this cannot regress silently again.

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

    -- THE FIX (see this file's header). Was:
    --   coalesce(s.current_period_start, s.next_billing_on)
    -- which recomputed the period this function had itself just written, so the second
    -- billing date produced the SAME period, lost to billing_invoices_farm_period_uq,
    -- and `continue`d without advancing next_billing_on. Every farm billed once, ever.
    v_pstart := coalesce(s.current_period_end + 1, s.next_billing_on);
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
