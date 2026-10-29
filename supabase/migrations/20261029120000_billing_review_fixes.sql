-- Corrections from the review of the suspension, manual-payment and service-invoice work
-- (20261029090100 is already applied on production, so these are redefinitions).
--
-- 1. app.billing_restore_after_payment re-anchored a resumed farm's period to the payment
--    date whatever the debt was, so an annual farm suspended over a small AI invoice was
--    handed most of a year free. Now it re-anchors only when the current period's own
--    invoice was the debt, and otherwise moves the period on by the days suspended. It also
--    stays suspended only on the gate's own test (past the grace), not on any unpaid invoice.
-- 2. public.admin_extend_billing_access lifted a suspension without compensating the
--    period, so the generator invoiced the suspended weeks. It moves the period on too.
-- 3. app.billing_reverse_manual_payment left a sign-up active after its only payment
--    bounced; it goes back to pending.
-- 4. app.billing_raise_service_invoice split line VAT at the settings rate (15%) inside an
--    invoice the VAT guard had forced to 0; lines now read the invoice's rate.

create or replace function app.billing_restore_after_payment(p_sub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype;
        v_today date := current_date;
        v_next date;
        v_grace integer;
        v_since date;
        v_days integer;
        v_reanchor boolean;
begin
  select * into s from public.billing_subscriptions where id = p_sub for update;
  if not found then return; end if;

  -- ENDED. The money is still recorded and the invoice is still marked paid, that all
  -- happened in app.settle_billing_attempt before this was called, and a debt they owed
  -- being settled is correct. What must NOT happen is the subscription coming back:
  -- somebody who cancelled and then had an in-flight charge complete would otherwise
  -- find themselves subscribed again, and billed again next month, having done nothing.
  --
  -- The dunning fields are still cleared, so the row does not sit there claiming a farm
  -- that has left is three payments behind.
  if s.status = 'cancelled' or s.ended_on is not null then
    update public.billing_subscriptions
       set failed_attempt_count = 0,
           next_retry_on = null,
           grace_ends_on = null,
           last_failure_code = null,
           updated_at = now()
     where id = p_sub;
    return;
  end if;

  -- SUSPENDED for non-payment (20261029090100, corrected by 20261029120000).
  --
  -- Comes back only when nothing that counts is still past its grace: the same test
  -- app.farm_billing_gate makes, so the gate and this never disagree (an invoice that is
  -- not yet due, or still inside its seven days, does not keep a farm locked).
  --
  -- How the period moves depends on what the debt was:
  --   * the CURRENT period's own invoice, paid since the suspension (a payment row created
  --     after suspended_at, so a backdated EFT received date cannot fool it): a fresh
  --     period from today, the founder's "paying starts a fresh period from the payment
  --     date", because that period's access is what was withheld;
  --   * anything else (an AI-only, slots or proration invoice, or an older period's), with
  --     the current period already paid: the period end and the next billing date move on
  --     by exactly the days spent suspended. Re-anchoring here handed an annual farm that
  --     owed R50 of AI use most of a year free.
  -- Either way nothing is billed for the weeks without access.
  if s.status = 'suspended' then
    select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
    v_grace := coalesce(v_grace, 7);
    v_since := app.farm_overdue_since(s.farm_id);
    if v_since is not null and (v_since + v_grace) < v_today then
      update public.billing_subscriptions
         set last_failure_code = null, updated_at = now()
       where id = p_sub;
      return;
    end if;

    v_days := greatest(0, v_today - coalesce(s.suspended_at::date, v_today));
    v_reanchor := s.suspended_at is not null and exists (
      select 1 from public.billing_invoices i
       where i.subscription_id = p_sub and i.kind = 'period' and i.deleted_at is null
         and i.status = 'paid' and i.period_start = s.current_period_start
         and exists (select 1 from public.billing_payments p
                      where p.invoice_id = i.id and p.deleted_at is null
                        and p.amount_incl_cents > 0 and p.created_at >= s.suspended_at)
    );

    if v_reanchor then
      v_next := app.billing_advance_period(v_today, s.billing_period, extract(day from v_today)::integer);
      update public.billing_subscriptions
         set anchor_day = extract(day from v_today)::integer,
             current_period_start = v_today,
             current_period_end = v_next - 1,
             next_billing_on = v_next
       where id = p_sub;
    elsif v_days > 0 then
      update public.billing_subscriptions
         set current_period_end = current_period_end + v_days,
             next_billing_on = next_billing_on + v_days
       where id = p_sub;
    end if;

    update public.billing_subscriptions
       set status = case
                      when cancel_at_period_end then 'non_renewing'::billing_subscription_status
                      else 'active'::billing_subscription_status
                    end,
           suspended_at = null,
           failed_attempt_count = 0,
           next_retry_on = null,
           grace_ends_on = null,
           last_failure_code = null,
           updated_at = now()
     where id = p_sub;
    update public.farms
       set status = 'active', suspended_for = null
     where id = s.farm_id and status = 'suspended' and suspended_for = 'billing';
    perform app.notify_farm(s.farm_id, 'billing_resumed', '{}'::jsonb);
    return;
  end if;

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
revoke execute on function app.billing_restore_after_payment(uuid) from public, anon, authenticated, service_role;

create or replace function public.admin_extend_billing_access(p_farm uuid, p_until date, p_reason text, p_by uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sub uuid;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin') then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  if p_until is null or p_until < current_date or p_until > current_date + 60 then
    raise exception 'BILLING: extend access by up to 60 days' using errcode = '22023';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'BILLING: say why access is extended' using errcode = '22023';
  end if;
  select id into v_sub from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null order by created_at desc limit 1;
  if v_sub is null then raise exception 'BILLING: no subscription' using errcode = '22023'; end if;
  -- Lifting a suspension moves the period on by the days it lasted (20261029120000): the
  -- generator skipped the farm while it was suspended, and without this it would catch up
  -- and invoice the weeks it had no access, one period a night.
  update public.billing_subscriptions
     set current_period_end = case when status = 'suspended' and suspended_at is not null
                                   then current_period_end + greatest(0, current_date - suspended_at::date)
                                   else current_period_end end,
         next_billing_on = case when status = 'suspended' and suspended_at is not null
                                then next_billing_on + greatest(0, current_date - suspended_at::date)
                                else next_billing_on end,
         access_extended_until = p_until, access_extended_by = p_by,
         access_extension_reason = left(btrim(p_reason), 500),
         status = case when status = 'suspended' then 'active'::billing_subscription_status else status end,
         suspended_at = case when status = 'suspended' then null else suspended_at end,
         updated_at = now()
   where id = v_sub;
  update public.farms set status = 'active', suspended_for = null
   where id = p_farm and status = 'suspended' and suspended_for = 'billing';
end $$;
revoke execute on function public.admin_extend_billing_access(uuid, date, text, uuid) from public, anon, authenticated;
grant  execute on function public.admin_extend_billing_access(uuid, date, text, uuid) to service_role;

create or replace function app.billing_reverse_manual_payment(p_payment uuid, p_reason text, p_by uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare p public.billing_payments%rowtype; v_sub uuid;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin' and u.active) then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'BILLING: say why the payment is reversed' using errcode = '22023';
  end if;
  select * into p from public.billing_payments where id = p_payment for update;
  if not found or p.provider <> 'manual' or p.amount_incl_cents <= 0 then
    raise exception 'BILLING: only a payment recorded by hand can be reversed here' using errcode = '22023';
  end if;
  if p.deleted_at is not null then
    raise exception 'BILLING: that payment is already reversed' using errcode = '22023';
  end if;
  update public.billing_payments
     set deleted_at = now(), deleted_by = p_by, reversal_reason = left(btrim(p_reason), 500)
   where id = p_payment;

  -- A sign-up activated only by this payment goes back to PENDING (20261029120000): access
  -- starts only once payment is received, and a bounced EFT is no payment. A subscription
  -- with any other money in keeps its state, and the grace runs from the invoice's due date.
  select subscription_id into v_sub from public.billing_invoices where id = p.invoice_id;
  if v_sub is not null and not exists (
       select 1 from public.billing_payments bp
         join public.billing_invoices bi on bi.id = bp.invoice_id
        where bi.subscription_id = v_sub and bp.deleted_at is null and bp.amount_incl_cents > 0
     ) then
    update public.billing_subscriptions
       set status = 'pending', updated_at = now()
     where id = v_sub and status in ('active', 'non_renewing', 'trialing');
  end if;
end;
$fn$;
revoke execute on function app.billing_reverse_manual_payment(uuid, text, uuid) from public, anon, authenticated, service_role;

create or replace function app.billing_raise_service_invoice(
  p_farm uuid, p_lines jsonb, p_due_on date, p_by uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  f public.farms%rowtype;
  v_set public.billing_settings%rowtype;
  v_invoice uuid;
  v_line jsonb;
  v_n integer := 0;
  v_qty integer;
  v_unit bigint;
  v_total bigint;
  v_desc text;
  v_rate integer;
begin
  if p_by is null or not exists (select 1 from public.users u where u.id = p_by and u.role = 'rr_admin' and u.active) then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  select * into f from public.farms where id = p_farm and deleted_at is null;
  if not found then raise exception 'BILLING: no such farm' using errcode = '22023'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 20 then
    raise exception 'BILLING: add between one and twenty lines' using errcode = '22023';
  end if;
  if p_due_on is not null and (p_due_on < current_date or p_due_on > current_date + 120) then
    raise exception 'BILLING: the due date must be within the next 120 days' using errcode = '22023';
  end if;
  select * into v_set from public.billing_settings where singleton;
  -- Not VAT-registered today: the VAT guard forces this, as on every invoice.
  v_rate := coalesce(v_set.vat_rate_bps, 0);

  insert into public.billing_invoices (
    farm_id, subscription_id, invoice_ref, status, kind,
    period_start, period_end, issued_on, due_on,
    plan, billing_period, asset_count, unit_price_incl_cents, months_charged,
    price_version_id, price_version_label, vat_rate_bps,
    seller_vat_number, seller_snapshot, bill_to_snapshot
  ) values (
    f.id, null, app.next_billing_invoice_ref(), 'draft', 'service',
    current_date, current_date, current_date,
    coalesce(p_due_on, current_date + coalesce(v_set.payment_terms_days, 0)),
    f.plan, coalesce(f.billing_period, 'monthly'), 0, 0, 1,
    null, 'Services', v_rate,
    v_set.vat_number,
    jsonb_build_object(
      'legal_name', v_set.legal_name, 'trading_name', v_set.trading_name,
      'reg_number', v_set.reg_number, 'vat_registered', v_set.vat_registered,
      'billing_address', v_set.billing_address, 'billing_email', v_set.billing_email),
    jsonb_build_object(
      'name', f.name, 'trading_name', f.trading_name, 'reg_number', f.reg_number,
      'vat_number', f.vat_number, 'billing_address', f.billing_address, 'billing_email', f.billing_email)
  ) returning id into v_invoice;

  -- The rate the VAT guard settled on the header (0 while Rapid Rise is not registered),
  -- read back so a line never states VAT its invoice does not charge (20261029120000), as
  -- the period generator does.
  select vat_rate_bps into v_rate from public.billing_invoices where id = v_invoice;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_desc := btrim(coalesce(v_line ->> 'description', ''));
    v_qty := (v_line ->> 'qty')::integer;
    v_unit := (v_line ->> 'unit_price_cents')::bigint;
    if v_desc = '' or length(v_desc) > 200 then
      raise exception 'BILLING: every line needs a description' using errcode = '22023';
    end if;
    if v_qty is null or v_qty < 1 or v_qty > 10000 then
      raise exception 'BILLING: a quantity must be from 1 to 10000' using errcode = '22023';
    end if;
    if v_unit is null or v_unit < 0 or v_unit > 100000000 then
      raise exception 'BILLING: a price must be from R0 to R1 000 000' using errcode = '22023';
    end if;
    v_total := v_qty * v_unit;
    insert into public.billing_invoice_lines (invoice_id, farm_id, sort_order, description, qty,
      months_charged, unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents)
    values (v_invoice, f.id, v_n, v_desc, v_qty, 1, v_unit, v_total,
      app.ex_vat_cents(v_total, v_rate), v_total - app.ex_vat_cents(v_total, v_rate));
    v_n := v_n + 1;
  end loop;

  update public.billing_invoices set status = 'open' where id = v_invoice;
  if (select total_incl_cents from public.billing_invoices where id = v_invoice) <= 0 then
    raise exception 'BILLING: an invoice for nothing is not sent' using errcode = '22023';
  end if;
  return v_invoice;
end;
$fn$;
revoke execute on function app.billing_raise_service_invoice(uuid, jsonb, date, uuid) from public, anon, authenticated, service_role;
