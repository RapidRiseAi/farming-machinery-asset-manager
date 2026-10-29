-- Second corrections, from verifying 20261029120000 (all redefinitions):
-- 1. app.sweep_dormant_signups treated a sign-up whose only payment was reversed (and so put
--    back to pending) as dormant, and after seven days voided its invoice and deleted the
--    farm and its people. Reversed payments now count as money having been recorded.
-- 2. The day-shift (restore after payment, and the extension) moved the period end and the
--    next billing date but not anchor_day, so the generator snapped the next period back to
--    the old date and the compensation vanished. The anchor moves with them.
-- 3. A reversal now returns a sign-up to pending whenever no invoice of it is paid any more,
--    not only when no money at all is left.

create or replace function app.sweep_dormant_signups(p_days integer default 7)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype; v_done integer := 0;
begin
  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       and status = 'pending'
       and created_at < now() - make_interval(days => greatest(coalesce(p_days, 7), 1))
       -- Never touch one that has taken money. A part-paid sign-up is a conversation,
       -- not a dormant row.
       --
       -- `billing_subscriptions.id`, NOT `s.id`. `s` is this loop's own record variable and
       -- is unbound while the query that FEEDS the loop is planned, so plpgsql substitutes
       -- NULL, `i.subscription_id = NULL` is never true, and the whole guard silently
       -- passes for everybody. Suite section (y) caught it by sweeping a sign-up that had
       -- paid.
       and not exists (
         select 1 from public.billing_payments p
           join public.billing_invoices i on i.id = p.invoice_id
          -- Reversed payments count too (20261029130000). A sign-up whose EFT bounced is
          -- put back to pending by the reversal, and is a conversation with somebody who
          -- tried to pay, not a dormant row: sweeping it voided the debt and deleted the farm.
          where i.subscription_id = billing_subscriptions.id
       )
     for update skip locked
  loop
    -- Void, never delete. The same promise the non-payment downgrade makes: nothing in
    -- this product is destroyed because somebody stopped paying attention.
    update public.billing_invoices
       set status = 'void', updated_at = now()
     where subscription_id = s.id and status in ('draft', 'open');

    update public.billing_subscriptions
       set status = 'cancelled', ended_on = current_date,
           cancellation_reason = 'dormant sign-up swept', cancelled_at = now(),
           deleted_at = now(), updated_at = now()
     where id = s.id;

    update public.users set active = false, deleted_at = now() where farm_id = s.farm_id;
    update public.farms set status = 'cancelled', deleted_at = now() where id = s.farm_id;

    v_done := v_done + 1;
  end loop;

  return v_done;
end $$;
revoke execute on function app.sweep_dormant_signups(integer) from public, anon, authenticated;

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
      -- The anchor moves too (20261029130000): the generator ends each period on
      -- billing_advance_period(start, period, anchor_day), so with the old anchor the next
      -- period snapped back to the old date and the compensation vanished.
      update public.billing_subscriptions
         set current_period_end = current_period_end + v_days,
             next_billing_on = next_billing_on + v_days,
             anchor_day = coalesce(extract(day from next_billing_on + v_days)::integer, anchor_day)
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
         -- With the anchor, or the next period snaps back (20261029130000).
         anchor_day = case when status = 'suspended' and suspended_at is not null and next_billing_on is not null
                           then extract(day from next_billing_on + greatest(0, current_date - suspended_at::date))::integer
                           else anchor_day end,
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
  -- Decided by what activation requires, payment in full, not by whether any money is
  -- left (20261029130000): a sign-up that paid in two transfers, one of which bounced, has
  -- no invoice paid any more and goes back to pending too.
  if v_sub is not null and not exists (
       select 1 from public.billing_invoices bi
        where bi.subscription_id = v_sub and bi.deleted_at is null and bi.status = 'paid'
     ) then
    update public.billing_subscriptions
       set status = 'pending', updated_at = now()
     where id = v_sub and status in ('active', 'non_renewing', 'trialing');
  end if;
end;
$fn$;
revoke execute on function app.billing_reverse_manual_payment(uuid, text, uuid) from public, anon, authenticated, service_role;
