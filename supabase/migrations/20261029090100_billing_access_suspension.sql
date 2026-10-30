-- Seven days' grace, then access stops until the farm pays (decision of 26 October 2026,
-- answered on 27 October: a suspended farm may only pay and download its records; paying
-- starts a fresh period from the payment date; nothing billed while suspended; never
-- deleted automatically).
--
-- What it replaces. Before this, dunning began only when a STORED CARD failed: a farm that
-- pays by EFT or invoice never entered past_due and kept access for ever. A card farm kept
-- full access through three retries and a seven-day grace (about five weeks after the due
-- date), was then DOWNGRADED to Essential rather than stopped, and closed about thirty
-- days later. A farm with no subscription at all was let in for good.
--
-- Now the gate reads INVOICES, the same for every way of paying:
--   * app.farm_overdue_since: the oldest due date of an open subscription, plan-change,
--     slot or AI invoice that is unpaid. Not one with a payment in flight (a pending or
--     unknown attempt: a webhook that has not settled must not lock out a farm that paid),
--     and not one that was refunded (a goodwill refund reopens an invoice; due_billing_charges
--     makes the same exclusion). Once-off service invoices never count.
--   * the farm is SUSPENDED from day 8 after that date (billing_settings.access_grace_days,
--     7), unless Rapid Rise extended access (access_extended_until, with who and why).
--   * a pending subscription is PENDING: access only after payment. Farms marked
--     billing_exempt (every test farm, set below) are always let in.
--
-- How it reaches every channel. Suspending also sets farms.status = 'suspended' with
-- suspended_for = 'billing'. About thirty database checks already treat a farm that is not
-- 'trial' or 'active' as stopped: public API tokens (api_token_resolve), WhatsApp
-- (whatsapp_member), QR and offline capture, the notification, reminder and scheduled-report
-- engines. So they all stop without each being rewritten. suspended_for tells a billing
-- suspension (the farm can pay its way back) from a Rapid Rise hold (status suspended,
-- suspended_for null), which stays 'closed'. Only Rapid Rise can update a farm row
-- (farms_upd, 0101), so a farm cannot lift its own suspension or exemption.
--
-- Coming back. app.billing_restore_after_payment, run after every settled payment, resumes
-- a suspended subscription once nothing overdue is left: status active, a fresh period
-- from today, the farm active again, and a 'billing_resumed' notice. The generator never
-- invoices a suspended subscription (its status list does not include it).

alter table public.billing_settings
  add column if not exists access_grace_days integer not null default 7;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_settings_access_grace_ck') then
    alter table public.billing_settings
      add constraint billing_settings_access_grace_ck check (access_grace_days between 0 and 60);
  end if;
end
$$;
comment on column public.billing_settings.access_grace_days is
  'Days after an invoice falls due that the farm keeps working unpaid; from the next day it is '
  'suspended until it pays (20261029090100). Decided 26 October 2026: 7.';

alter table public.billing_subscriptions
  add column if not exists suspended_at timestamptz,
  add column if not exists access_extended_until date,
  add column if not exists access_extended_by uuid references public.users(id),
  add column if not exists access_extension_reason text;
comment on column public.billing_subscriptions.access_extended_until is
  'Rapid Rise kept access open past the grace until this date (who and why beside it).';

alter table public.farms
  add column if not exists billing_exempt boolean not null default false,
  add column if not exists suspended_for text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'farms_suspended_for_ck') then
    alter table public.farms
      add constraint farms_suspended_for_ck check (suspended_for is null or suspended_for = 'billing');
  end if;
end
$$;
comment on column public.farms.billing_exempt is
  'Never asked to pay and never suspended: test farms and Rapid Rise''s own demos. Only Rapid '
  'Rise can set it (farms_upd).';
comment on column public.farms.suspended_for is
  '''billing'' when status is suspended because an invoice is more than the grace overdue '
  '(the farm can pay its way back); null for a Rapid Rise hold (20261029090100).';

-- Every test farm is exempt (all four production farms are test farms).
update public.farms set billing_exempt = true where is_test and not billing_exempt;

create or replace function app.farm_overdue_since(p_farm uuid) returns date
language sql stable security definer set search_path = public, pg_temp as $$
  select min(coalesce(i.due_on, i.issued_on))
    from public.billing_invoices i
   where i.farm_id = p_farm
     and i.deleted_at is null
     and i.status = 'open'
     and i.kind in ('period', 'proration', 'slots', 'ai_usage')
     and i.total_incl_cents > i.amount_paid_cents
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     );
$$;
revoke execute on function app.farm_overdue_since(uuid) from public, anon, authenticated;
comment on function app.farm_overdue_since(uuid) is
  'The oldest due date of an unpaid invoice that counts towards suspension, or null '
  '(20261029090100).';

-- The gate. ok | pending | suspended | closed. Same signature and grants as before.
create or replace function app.farm_billing_gate(p_farm uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  f public.farms%rowtype;
  s public.billing_subscriptions%rowtype;
  v_grace integer;
  v_since date;
begin
  select * into f from public.farms where id = p_farm;
  if not found then return 'ok'; end if;

  -- Rapid Rise ended the account, or holds it: closed. A billing suspension is its own state.
  if f.deleted_at is not null or f.status = 'cancelled' then return 'closed'; end if;
  if f.status = 'suspended' then
    return case when f.suspended_for = 'billing' then 'suspended' else 'closed' end;
  end if;

  if f.billing_exempt then return 'ok'; end if;

  select * into s
    from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null
   order by created_at desc
   limit 1;

  -- No subscription at all: still let in. Every self sign-up starts with a PENDING
  -- subscription, so "access only after payment" already holds for them; a farm Rapid Rise
  -- creates by hand gets its pending subscription and invoice from staff onboarding (the
  -- outside-payments work), and test farms are exempt above.
  if not found then return 'ok'; end if;
  if s.status = 'pending' then return 'pending'; end if;
  if s.status = 'suspended' then return 'suspended'; end if;

  if s.status = 'cancelled' then
    if coalesce(s.ended_on, s.cancelled_at::date) < current_date then return 'closed'; end if;
    return 'ok';
  end if;

  -- Every other state (active, trialing, past_due, grace, non_renewing, and the retired
  -- downgraded) is decided by what is unpaid, not by the card's ladder.
  select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
  v_grace := coalesce(v_grace, 7);
  v_since := app.farm_overdue_since(p_farm);
  if v_since is not null and (v_since + v_grace) < current_date
     and (s.access_extended_until is null or s.access_extended_until < current_date) then
    return 'suspended';
  end if;
  return 'ok';
end;
$fn$;
revoke execute on function app.farm_billing_gate(uuid) from public, anon, authenticated;
grant  execute on function app.farm_billing_gate(uuid) to service_role;

-- The engine: flips what the gate already answers into the stored state, once, and tells
-- the farm. Run nightly by the billing cron in place of the downgrades.
create or replace function app.billing_apply_suspensions() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_done integer := 0;
begin
  for r in
    select s.id, s.farm_id
      from public.billing_subscriptions s
      join public.farms f on f.id = s.farm_id
     where s.deleted_at is null
       and s.status not in ('pending', 'cancelled', 'suspended')
       and f.deleted_at is null
       and not f.billing_exempt
       and f.status in ('trial', 'active')
       and app.farm_billing_gate(s.farm_id) = 'suspended'
     for update of s skip locked
  loop
    update public.billing_subscriptions
       set status = 'suspended',
           suspended_at = now(),
           next_retry_on = current_date + 7,
           updated_at = now()
     where id = r.id;
    update public.farms
       set status = 'suspended', suspended_for = 'billing'
     where id = r.farm_id and status in ('trial', 'active');
    perform app.notify_farm(r.farm_id, 'billing_suspended',
      jsonb_build_object('overdue_since', app.farm_overdue_since(r.farm_id)));
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;
revoke execute on function app.billing_apply_suspensions() from public, anon, authenticated;

create or replace function public.cron_apply_billing_suspensions() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_apply_suspensions();
$$;
revoke execute on function public.cron_apply_billing_suspensions() from public, anon, authenticated;
grant  execute on function public.cron_apply_billing_suspensions() to service_role;

-- Rapid Rise keeps a farm open past the grace, with who and why (the admin billing page).
-- Service role only, like the discount setter (20260920150000): under the service client
-- auth.uid() is null, so the rr_admin check lives in the server action and the acting admin
-- is passed in, which is what makes the action the only way in.
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
  update public.billing_subscriptions
     set access_extended_until = p_until, access_extended_by = p_by,
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

create or replace function app.due_billing_charges(p_limit integer default 50)
returns table (
  invoice_id uuid, farm_id uuid, subscription_id uuid, payment_method_id uuid,
  amount_incl_cents bigint, invoice_ref text, attempt_number integer
)
language sql stable security definer set search_path = public, pg_temp as $$
  select i.id, i.farm_id, i.subscription_id, s.default_payment_method_id,
         i.total_incl_cents - i.amount_paid_cents,
         i.invoice_ref,
         (select count(*)::integer + 1 from public.billing_payment_attempts a
           where a.invoice_id = i.id)
    from public.billing_invoices i
    join public.billing_subscriptions s on s.id = i.subscription_id and s.deleted_at is null
    -- S7. A deleted farm is never charged, full stop. A CANCELLED one is not charged
    -- either: cancelling is our own act, and taking money afterwards reads as a mistake
    -- however correct the underlying debt is. A SUSPENDED farm still is, suspension
    -- withholds the service, it does not forgive what is already invoiced.
    join public.farms fm on fm.id = i.farm_id
     and fm.deleted_at is null and fm.status <> 'cancelled'
    join public.billing_payment_methods pm
      on pm.id = s.default_payment_method_id and pm.farm_id = s.farm_id
     and pm.deleted_at is null and pm.status = 'active'
     and pm.reusable and pm.authorization_code is not null
   where i.deleted_at is null
     and i.status = 'open'
     and i.total_incl_cents > i.amount_paid_cents
     and coalesce(i.due_on, i.issued_on, current_date) <= current_date
     -- GRACE IS NOW RETRIED (founder decision, 2026-09-10). Until this, exhausting the
     -- retry ladder set status='grace' with next_retry_on = null, and 'grace' was not in
     -- this list at all, so the stored card was never presented again by anything, and a
     -- farm whose money simply arrived late was downgraded without ever being asked twice.
     --
     -- The two arms are not the same test. For a live subscription a NULL retry date means
     -- "no reason to wait". In grace it means the weekly retry is switched OFF
     -- (grace_retry_days = 0), which must never read as "charge immediately".
     and (
       (s.status in ('active', 'past_due')
          and coalesce(s.next_retry_on, current_date) <= current_date)
       or
       (s.status = 'grace'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
       or
       -- SUSPENDED (20261029090100): access has stopped, the debt has not. The stored card
       -- is still presented weekly (app.billing_register_failure sets the date and stops
       -- after four weeks), so a farm whose money arrives late comes back by itself.
       (s.status = 'suspended'
          and s.next_retry_on is not null and s.next_retry_on <= current_date)
     )
     -- Nothing in flight. A row in `unknown` deliberately blocks this farm entirely
     -- until somebody has reconciled it.
     and not exists (
       select 1 from public.billing_payment_attempts a
        where a.invoice_id = i.id and a.status in ('pending', 'unknown')
     )
     -- REFUNDED (20260911210000). A refund makes this invoice unpaid again, which is true
     -- and which would otherwise put it straight back here. Charging somebody the morning
     -- after refunding them is not a recovery, it is the worst thing this system could do.
     -- A human decides what happens next; see docs/BILLING.md §11b.
     and not exists (
       select 1 from public.billing_payments p
        where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
     )
   order by i.due_on nulls last, i.created_at
   limit greatest(p_limit, 0);
$$;

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

  -- S10, and it got considerably worse when `pending` arrived.
  --
  -- This function moves a subscription to 'past_due' on any failure. For a farm that has
  -- been paying, that is the ladder working. For a PENDING sign-up, one whose very first
  -- payment just failed, it moved them out of 'pending', and `app.farm_billing_gate` reads
  -- anything other than 'pending' as "let them in".
  --
  -- So a DECLINED card opened the farm. Not a subtle one: fail the payment, get the
  -- product.
  --
  -- A pending sign-up has nothing to dun. They have no access, they owe nothing yet, and
  -- their invoice simply stays open until they pay it. The failure is still recorded -
  -- the count and the reason are evidence, and "their card was declined four times" is
  -- worth knowing when they ring, but the status does not move.
  if s.status = 'pending' then
    update public.billing_subscriptions
       set failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           updated_at = now()
     where id = p_sub;
    return;
  end if;

  -- SUSPENDED (20261029090100). A failed weekly retry of a suspended farm keeps it
  -- suspended: moving it to past_due would read as a live subscription again. The card is
  -- tried once a week for four weeks after the suspension, then left for a person.
  if s.status = 'suspended' then
    update public.billing_subscriptions
       set failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = case when s.suspended_at is not null
                                 and s.suspended_at > now() - interval '28 days'
                                then current_date + 7 else null end,
           updated_at = now()
     where id = p_sub;
    return;
  end if;

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
    -- Retries exhausted. Access continues for the grace period, and, since 20260910160000,
    -- so does asking. The card is presented again every `grace_retry_days`, because the
    -- commonest reason one fails here is that the money arrives next week.
    --
    -- `grace_ends_on` is still coalesced, so a farm that fails three grace retries does not
    -- earn itself three extra weeks: the downgrade lands on the day grace began + grace_days.
    update public.billing_subscriptions
       set status = 'grace',
           failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = case when v.grace_retry_days > 0
                                then current_date + v.grace_retry_days
                                else null end,
           grace_ends_on = coalesce(grace_ends_on, current_date + v.grace_days),
           updated_at = now()
     where id = p_sub;
  end if;
end $$;

create or replace function app.billing_restore_after_payment(p_sub uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.billing_subscriptions%rowtype;
        v_today date := current_date;
        v_next date;
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

  -- SUSPENDED for non-payment (20261029090100). Access comes back only when nothing that
  -- counts is still overdue; one invoice paid of two leaves the farm suspended. Coming back
  -- starts a fresh period from the payment date, so the weeks without access are never
  -- billed (decision of 27 October 2026): the paid invoice buys the period from today.
  if s.status = 'suspended' then
    if app.farm_overdue_since(s.farm_id) is not null then
      update public.billing_subscriptions
         set last_failure_code = null, updated_at = now()
       where id = p_sub;
      return;
    end if;
    v_next := app.billing_advance_period(v_today, s.billing_period,
                                         extract(day from v_today)::integer);
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
           anchor_day = extract(day from v_today)::integer,
           current_period_start = v_today,
           current_period_end = v_next - 1,
           next_billing_on = v_next,
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
