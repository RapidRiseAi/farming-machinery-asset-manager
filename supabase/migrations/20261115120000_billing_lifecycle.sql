-- 20261115120000_billing_lifecycle.sql
-- What happens when a renewal is not paid, and after a cancellation (BRIEF sections 15 and 16;
-- decisions 26, 38 and 41; scenarios 11 and 40).
--
-- == The lifecycle, mapped onto the gate's four answers =====================================
-- app.farm_billing_gate keeps its four values (ok, pending, suspended, closed), so the pay gate
-- in the tables (20261112090000), the definer functions (20261112100000), the layout and every
-- caller keep working. What each value now means:
--
--   ok, and nothing late        active: everything works.
--   ok, a payment late          GRACE (decision 41), from the first day an owed invoice is past
--                               its due date, or a card renewal was declined, for seven days.
--                               Ordinary record keeping goes on (writes are allowed); nothing
--                               new that costs money is sold (app.farm_paid_extras_allowed is
--                               false: no change quotes that charge, no paid AI or voice, no
--                               WhatsApp). The owner is told the first day.
--   suspended                   RETRIEVAL after an unpaid renewal: from day eight, for 90 days.
--                               Automatic renewals and card retries stop. Only the OWNER may
--                               read (and export); nobody writes, through any path.
--   closed, within 90 days      RETRIEVAL after a cancellation: the paid-through date passed.
--                               The same owner-only reading (decision 38).
--   closed, after the 90 days   nothing is readable; paying (unpaid) or reopening (cancelled)
--                               brings the account back. Deleting records after the window is
--                               a separate future policy (decision 40, task A4): nothing here
--                               deletes anything.
--   pending                     never paid: unchanged.
--
-- "Owner-only" is enforced where reading is enforced: app.stopped_farm_ids(false) (the
-- restrictive pay_gate_select policies on every table with a farm_id, and Storage) and
-- app.require_open_farm(farm, false) (the definer functions that read). A Rapid Rise hold, a
-- deleted business and an ended account are owner-only too.
--
-- == Every channel stops, not only the screen ===============================================
-- The ~30 checks that treat a business whose farms.status is not 'trial' or 'active' as stopped
-- (API tokens, WhatsApp, QR and offline capture, the notification, reminder and report engines)
-- already stop a suspended one. A CANCELLED one kept farms.status 'active' after its period, so
-- those engines carried on for an account that had left: closing a cancellation now sets
-- farms.status 'suspended' with suspended_for 'billing' as well, and a trigger lifts it again
-- whenever a subscription comes back (paid, reopened inside a paid period, kept open by Rapid
-- Rise), whichever path does it.
--
-- == Dates are South African ================================================================
-- Every lifecycle date is decided on app.billing_today() (Africa/Johannesburg). The gate used
-- current_date, which on Supabase is UTC, so between 00:00 and 02:00 SAST a business's day
-- eight began two hours late. app.farm_billing_gate_on(farm, day) answers for any day, which is
-- how the boundaries are tested.
--
-- == Safe on live data ======================================================================
-- New nullable columns; an account already suspended or cancelled is given at least 90 days of
-- owner reading from today (never fewer than it would have had), so nobody loses access on the
-- night this ships. Same signatures throughout.

alter table public.billing_subscriptions add column if not exists retrieval_ends_on date;
comment on column public.billing_subscriptions.retrieval_ends_on is
  'The last day the owner may read and export after an unpaid renewal (90 days from day eight) '
  'or after a cancelled period ended (90 days from the paid-through date). Null while the '
  'subscription runs (20261115120000).';

-- == The retrieval window ===================================================================
-- The last day of owner-only reading, from the subscription: stored when the window opens,
-- worked out from the dates for one that predates the column.
create or replace function app.billing_retrieval_ends_on(s public.billing_subscriptions) returns date
language sql stable set search_path = public, pg_temp as $$
  select case
    when s.id is null then null
    when s.retrieval_ends_on is not null then s.retrieval_ends_on
    when s.status = 'suspended' then coalesce(app.billing_date_of(s.suspended_at), app.billing_today()) + 89
    when s.status = 'cancelled' or s.ended_on is not null
      then coalesce(s.ended_on, app.billing_date_of(s.cancelled_at), app.billing_today()) + 90
  end;
$$;
revoke all on function app.billing_retrieval_ends_on(public.billing_subscriptions) from public, anon, authenticated, service_role;

-- Every account already stopped gets at least 90 days from today.
update public.billing_subscriptions s
   set retrieval_ends_on = greatest(app.billing_retrieval_ends_on(s), app.billing_today() + 89)
 where s.deleted_at is null
   and s.retrieval_ends_on is null
   and (s.status in ('suspended', 'cancelled') or s.ended_on is not null);

-- == The gate, for any day ==================================================================
create or replace function app.farm_billing_gate_on(p_farm uuid, p_today date) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $fn$
declare
  f public.farms%rowtype;
  s public.billing_subscriptions%rowtype;
  v_grace integer;
  v_since date;
  v_paused boolean;
begin
  select * into f from public.farms where id = p_farm;
  if not found then return 'ok'; end if;

  -- Rapid Rise ended the account, or holds it: closed.
  if f.deleted_at is not null or f.status = 'cancelled' then return 'closed'; end if;
  if f.status = 'suspended' and f.suspended_for is distinct from 'billing' then return 'closed'; end if;
  v_paused := f.status = 'suspended';

  if f.billing_exempt and not v_paused then return 'ok'; end if;

  -- A site billed through another has no bill of its own: it follows that site (one level).
  if f.billed_through is not null then return app.farm_billing_gate_on(f.billed_through, p_today); end if;

  select * into s
    from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null
   order by created_at desc
   limit 1;
  if not found then
    return case when v_paused then 'suspended' else 'ok' end;
  end if;

  if s.status = 'pending' then return 'pending'; end if;

  -- Cancelled: everything until the day after the paid-through date, then closed.
  if s.status = 'cancelled' or s.ended_on is not null then
    if coalesce(s.ended_on, app.billing_date_of(s.cancelled_at)) < p_today then return 'closed'; end if;
    return case when v_paused then 'suspended' else 'ok' end;
  end if;

  -- Unpaid: the retrieval window, and closed once it has passed.
  if s.status = 'suspended' or v_paused then
    if app.billing_retrieval_ends_on(s) < p_today then return 'closed'; end if;
    return 'suspended';
  end if;

  -- Every other state is decided by what is unpaid, not by the card's ladder.
  select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
  v_grace := coalesce(v_grace, 7);
  v_since := app.farm_overdue_since(p_farm);
  if v_since is not null and (v_since + v_grace) < p_today
     and (s.access_extended_until is null or s.access_extended_until < p_today) then
    return 'suspended';
  end if;
  return 'ok';
end;
$fn$;
revoke all on function app.farm_billing_gate_on(uuid, date) from public, anon, authenticated, service_role;
comment on function app.farm_billing_gate_on(uuid, date) is
  'ok | pending | suspended | closed for a business on a given South African day '
  '(20261115120000). app.farm_billing_gate asks it for today.';

create or replace function app.farm_billing_gate(p_farm uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select app.farm_billing_gate_on(p_farm, app.billing_today());
$$;
revoke execute on function app.farm_billing_gate(uuid) from public, anon, authenticated;
grant  execute on function app.farm_billing_gate(uuid) to service_role;

-- == Who may still read a stopped business =================================================
-- The caller. A business that is not stopped: everyone the policies allow. Pending: nobody.
-- Suspended or closed: its owner, until the retrieval window ends (no end known: a Rapid Rise
-- hold or a deleted business, the owner).
create or replace function app.farm_read_allowed(p_farm uuid, p_today date) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_gate text := app.farm_billing_gate_on(p_farm, p_today);
  v_end date;
begin
  if v_gate = 'ok' then return true; end if;
  if v_gate = 'pending' then return false; end if;
  if app.effective_farm_role(auth.uid(), p_farm) is distinct from 'owner' then return false; end if;
  select app.billing_retrieval_ends_on(s) into v_end
    from public.billing_subscriptions s where s.id = app.billing_subscription_for(p_farm);
  return v_end is null or p_today <= v_end;
end $$;
revoke all on function app.farm_read_allowed(uuid, date) from public, anon, authenticated, service_role;

-- 20261112090000's helper: for reading, the businesses the caller may not read (pending, and a
-- stopped one for anybody but its owner, or after its window); for writing, every one whose
-- gate is not ok, as before. Once per statement, never per row.
create or replace function app.stopped_farm_ids(p_writing boolean)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := app.billing_today();
begin
  if auth.uid() is null or app.is_rr_admin() then
    return;
  end if;
  if p_writing then
    return query
      select a.farm_id
        from app.accessible_farm_ids() as a(farm_id)
       where a.farm_id is not null
         and app.farm_billing_gate_on(a.farm_id, v_today) = any (array['pending', 'suspended', 'closed']);
  else
    return query
      select a.farm_id
        from app.accessible_farm_ids() as a(farm_id)
       where a.farm_id is not null
         and not app.farm_read_allowed(a.farm_id, v_today);
  end if;
end
$$;
revoke all on function app.stopped_farm_ids(boolean) from public, anon;
grant execute on function app.stopped_farm_ids(boolean) to authenticated;

-- 20261112100000's check inside the definer functions, with the same reading rule.
create or replace function app.require_open_farm(p_farm uuid, p_writing boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate text;
begin
  if p_farm is null or auth.uid() is null or app.is_rr_admin() or not app.has_farm_access(p_farm) then
    return true;
  end if;
  v_gate := app.farm_billing_gate(p_farm);
  if (p_writing and v_gate <> 'ok') or (not p_writing and not app.farm_read_allowed(p_farm, app.billing_today())) then
    raise exception 'farm-not-active'
      using errcode = '42501',
            detail = format('This business is %s, so its records cannot be %s by this person.',
                            v_gate, case when p_writing then 'changed' else 'read' end),
            hint = 'Pay on /activate or /suspended; the owner can read and export on /suspended or /closed.';
  end if;
  return true;
end
$$;
revoke all on function app.require_open_farm(uuid, boolean) from public, anon, authenticated, service_role;

-- == No new paid extras in the grace ========================================================
-- True only for a business that is fully paid up: the gate is ok and nothing is late. Asked
-- before anything that costs money is started: a change quote that charges, a paid AI or voice
-- hold, a WhatsApp send (decision 41). An exempt business is never late.
create or replace function app.farm_paid_extras_allowed(p_farm uuid, p_today date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.farm_billing_gate_on(p_farm, p_today) = 'ok'
     and (coalesce((select f.billing_exempt from public.farms f where f.id = app.billing_root(p_farm)), false)
          or not app.farm_payment_late(p_farm, p_today));
$$;
revoke all on function app.farm_paid_extras_allowed(uuid, date) from public, anon, authenticated;
grant execute on function app.farm_paid_extras_allowed(uuid, date) to service_role;

-- == A subscription that comes back lifts the pause =========================================
-- Whatever brought it back (a payment, a reopen inside a paid period, Rapid Rise keeping it
-- open), the farm row follows, so the engines that read farms.status start again.
create or replace function app.billing_lift_farm_pause() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.farms
     set status = 'active', suspended_for = null
   where id = new.farm_id and status = 'suspended' and suspended_for = 'billing';
  update public.billing_subscriptions
     set retrieval_ends_on = null
   where id = new.id and retrieval_ends_on is not null;
  return null;
end $$;
revoke all on function app.billing_lift_farm_pause() from public, anon, authenticated;
drop trigger if exists billing_subscriptions_lift_pause on public.billing_subscriptions;
create trigger billing_subscriptions_lift_pause
  after update of status on public.billing_subscriptions
  for each row
  when (old.status in ('pending', 'suspended', 'cancelled')
        and new.status in ('active', 'trialing', 'non_renewing', 'past_due', 'grace'))
  execute function app.billing_lift_farm_pause();

-- == Telling the owner =====================================================================
-- Billing news goes to the owners only (home site and owner memberships): staff are not told
-- what the business owes. In the person's inbox, which delivery carries by push and email.
create or replace function app.billing_notify_owners(p_farm uuid, p_template text, p_payload jsonb) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_n integer;
begin
  insert into public.notifications (farm_id, user_id, channel, template, payload, status, deliver_after)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued', null
    from public.users u
   where u.active and u.deleted_at is null
     and ((u.role = 'owner' and u.farm_id = p_farm)
          or exists (select 1 from public.user_farm_memberships m
                      where m.user_id = u.id and m.farm_id = p_farm and m.role = 'owner'
                        and m.active and m.deleted_at is null));
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function app.billing_notify_owners(uuid, text, jsonb) from public, anon, authenticated, service_role;
-- == A cancellation closes: 20261029160000's close, plus the retrieval window ================
-- The night after the paid-through date (the same matching as before), the subscription ends,
-- the owner's 90 days of reading begin, and the farm row is paused so every engine that reads
-- farms.status stops too. A cancellation made immediate by Rapid Rise (after a refund) is
-- picked up the same night by the second statement.
create or replace function app.billing_close_cancellations() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_done integer := 0;
  r record;
  v_today date := app.billing_today();
begin
  for r in
    with closed as (
      update public.billing_subscriptions
         set status = 'cancelled', ended_on = current_date,
             failed_attempt_count = 0, next_retry_on = null, grace_ends_on = null,
             retrieval_ends_on = current_date + 90,
             updated_at = now()
       where deleted_at is null
         and (status = 'non_renewing' or (cancel_at_period_end and status in ('past_due', 'grace')))
         and coalesce(current_period_end, trial_ends_on) is not null
         and coalesce(current_period_end, trial_ends_on) < current_date
      returning id, farm_id, retrieval_ends_on
    )
    select * from closed
  loop
    update public.farms set status = 'suspended', suspended_for = 'billing'
     where id = r.farm_id and status in ('trial', 'active');
    perform app.billing_notify_owners(r.farm_id, 'billing_access_ended',
      jsonb_build_object('reason', 'cancelled', 'retrieval_ends_on', r.retrieval_ends_on));
    v_done := v_done + 1;
  end loop;

  -- Ended already (cancelled immediately) and past its last day: the same pause and window.
  for r in
    select s.id, s.farm_id, coalesce(s.retrieval_ends_on, coalesce(s.ended_on, app.billing_date_of(s.cancelled_at)) + 90) as ends
      from public.billing_subscriptions s
      join public.farms f on f.id = s.farm_id
     where s.deleted_at is null
       and s.status = 'cancelled'
       and coalesce(s.ended_on, app.billing_date_of(s.cancelled_at)) < v_today
       and f.deleted_at is null and f.status in ('trial', 'active') and not f.billing_exempt
     for update of s skip locked
  loop
    update public.billing_subscriptions set retrieval_ends_on = r.ends, updated_at = now()
     where id = r.id and retrieval_ends_on is null;
    update public.farms set status = 'suspended', suspended_for = 'billing'
     where id = r.farm_id and status in ('trial', 'active');
    perform app.billing_notify_owners(r.farm_id, 'billing_access_ended',
      jsonb_build_object('reason', 'cancelled', 'retrieval_ends_on', r.ends));
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;
revoke execute on function app.billing_close_cancellations() from public, anon, authenticated;

-- == Day eight: retrieval begins (20261029090100's engine) ==================================
-- Automatic renewals stop: no weekly card retry (next_retry_on stays null, which the nightly
-- shortlist reads as "do not charge"); the owner can still pay from /suspended. The window's
-- last day is stored, and the owner is told it.
create or replace function app.billing_apply_suspensions() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_done integer := 0;
  v_today date := app.billing_today();
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
       and app.farm_billing_gate_on(s.farm_id, v_today) = 'suspended'
     for update of s skip locked
  loop
    update public.billing_subscriptions
       set status = 'suspended',
           suspended_at = now(),
           next_retry_on = null,
           retrieval_ends_on = v_today + 89,
           updated_at = now()
     where id = r.id;
    update public.farms
       set status = 'suspended', suspended_for = 'billing'
     where id = r.farm_id and status in ('trial', 'active');
    perform app.notify_farm(r.farm_id, 'billing_suspended',
      jsonb_build_object('overdue_since', app.farm_overdue_since(r.farm_id),
                         'retrieval_ends_on', v_today + 89));
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;
revoke execute on function app.billing_apply_suspensions() from public, anon, authenticated;

-- == The failure ladder (20261029090100), with no automatic retry once retrieval began ======
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

  -- A pending sign-up has nothing to dun: recorded, and the status does not move.
  if s.status = 'pending' then
    update public.billing_subscriptions
       set failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           updated_at = now()
     where id = p_sub;
    return;
  end if;

  -- Retrieval (20261115120000): renewals have stopped, so a failed payment the owner tried
  -- schedules no automatic retry. It is recorded; paying again is the owner's to do.
  if s.status = 'suspended' then
    update public.billing_subscriptions
       set failed_attempt_count = v_n,
           last_failure_code = p_reason,
           last_failure_at = now(),
           next_retry_on = null,
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

-- == What is owed, for the screens ==========================================================
create or replace function app.farm_outstanding_cents(p_farm uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(i.total_incl_cents - i.amount_paid_cents), 0)::bigint
    from public.billing_invoices i
   where i.farm_id = app.billing_root(p_farm)
     and i.deleted_at is null
     and i.status = 'open'
     and i.kind in ('period', 'proration', 'slots', 'ai_usage')
     and i.total_incl_cents > i.amount_paid_cents
     and not exists (select 1 from public.billing_payments p
                      where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0);
$$;
revoke all on function app.farm_outstanding_cents(uuid) from public, anon, authenticated, service_role;

-- == Where a business stands, in words a screen can say =====================================
-- state: active | grace | pending | retrieval | closed. reason: unpaid | cancelled |
-- rapid_rise (a hold or an ended account). With the dates that matter: when the payment was
-- due, the last day of grace, the paid-through date, the last day of owner reading.
create or replace function app.farm_lifecycle(p_farm uuid, p_today date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  f public.farms%rowtype;
  s public.billing_subscriptions%rowtype;
  v_gate text := app.farm_billing_gate_on(p_farm, p_today);
  v_root uuid := app.billing_root(p_farm);
  v_since date;
  v_grace integer;
  v_end date;
  v_state text;
  v_reason text;
begin
  select * into f from public.farms where id = v_root;
  select * into s from public.billing_subscriptions where id = app.billing_subscription_for(p_farm);
  select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
  v_grace := coalesce(v_grace, 7);
  v_since := app.farm_overdue_since(v_root);
  v_end := app.billing_retrieval_ends_on(s);

  if f.deleted_at is not null or f.status = 'cancelled'
     or (f.status = 'suspended' and f.suspended_for is distinct from 'billing') then
    v_reason := 'rapid_rise';
  elsif s.status = 'cancelled' or s.ended_on is not null then
    v_reason := 'cancelled';
  elsif s.status = 'suspended' or v_gate = 'suspended' then
    v_reason := 'unpaid';
  end if;

  v_state := case
    when v_gate = 'pending' then 'pending'
    when v_gate = 'ok' then case when app.farm_payment_late(p_farm, p_today) and not coalesce(f.billing_exempt, false)
                                 then 'grace' else 'active' end
    when v_reason = 'rapid_rise' then 'closed'
    when v_end is null or p_today <= v_end then 'retrieval'
    else 'closed' end;

  return jsonb_build_object(
    'state', v_state,
    'gate', v_gate,
    'reason', v_reason,
    'today', p_today,
    'overdue_since', v_since,
    'grace_ends_on', case when v_since is not null then v_since + v_grace end,
    'paid_through', s.current_period_end,
    'ended_on', s.ended_on,
    'retrieval_ends_on', case when v_state in ('retrieval', 'closed') then v_end end,
    'outstanding_cents', app.farm_outstanding_cents(p_farm));
end $$;
revoke all on function app.farm_lifecycle(uuid, date) from public, anon, authenticated, service_role;

-- The screens' question, from the person's own session. Any member of the business may ask
-- where it stands (a manager sees "only the owner can read now"); the amount owed is the
-- payer's business and is left out for everybody else (BILLING.md section 10).
create or replace function public.farm_lifecycle(p_farm uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  if auth.uid() is null or not (app.is_rr_admin() or app.has_farm_access(p_farm)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v := app.farm_lifecycle(p_farm, app.billing_today());
  if not app.is_farm_billing_admin(app.billing_root(p_farm)) then
    v := v - 'outstanding_cents';
  end if;
  return v;
end $$;
revoke all on function public.farm_lifecycle(uuid) from public, anon;
grant execute on function public.farm_lifecycle(uuid) to authenticated, service_role;

-- == The owner hears of it: the first day of grace, and before reading closes ==============
-- Once per overdue date (grace) and once per stage (30, 7 and 1 days before the window
-- closes), deduped on the notice already written, so a re-run sends nothing twice.
create or replace function app.billing_enqueue_lifecycle_notices(p_today date) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_n integer := 0;
  v_since date;
  v_grace integer;
  v_stage integer;
  v_end date;
begin
  select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
  v_grace := coalesce(v_grace, 7);

  -- Grace began.
  for r in
    select s.farm_id
      from public.billing_subscriptions s
      join public.farms f on f.id = s.farm_id
     where s.deleted_at is null
       and s.status not in ('pending', 'cancelled', 'suspended')
       and f.deleted_at is null and f.status in ('trial', 'active') and not f.billing_exempt
       and app.farm_billing_gate_on(s.farm_id, p_today) = 'ok'
       and app.farm_payment_late(s.farm_id, p_today)
  loop
    v_since := app.farm_overdue_since(r.farm_id);
    continue when exists (
      select 1 from public.notifications n
       where n.farm_id = r.farm_id and n.template = 'billing_grace_started'
         and n.payload ->> 'overdue_since' is not distinct from v_since::text);
    perform app.billing_notify_owners(r.farm_id, 'billing_grace_started', jsonb_build_object(
      'overdue_since', v_since,
      'grace_ends_on', coalesce(v_since, p_today) + v_grace,
      'outstanding_cents', app.farm_outstanding_cents(r.farm_id)));
    v_n := v_n + 1;
  end loop;

  -- Reading is about to close.
  for r in
    select s.*
      from public.billing_subscriptions s
      join public.farms f on f.id = s.farm_id
     where s.deleted_at is null
       and f.deleted_at is null and not f.billing_exempt
       and (s.status in ('suspended', 'cancelled') or s.ended_on is not null)
       and app.farm_billing_gate_on(s.farm_id, p_today) in ('suspended', 'closed')
  loop
    v_end := app.billing_retrieval_ends_on(r);
    continue when v_end is null or v_end < p_today or v_end - p_today > 30;
    v_stage := case when v_end - p_today <= 1 then 1 when v_end - p_today <= 7 then 7 else 30 end;
    continue when exists (
      select 1 from public.notifications n
       where n.farm_id = r.farm_id and n.template = 'billing_retrieval_ending'
         and n.payload ->> 'retrieval_ends_on' = v_end::text
         and (n.payload ->> 'stage')::integer <= v_stage);
    perform app.billing_notify_owners(r.farm_id, 'billing_retrieval_ending', jsonb_build_object(
      'retrieval_ends_on', v_end, 'stage', v_stage,
      'reason', case when r.status = 'suspended' then 'unpaid' else 'cancelled' end));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;
revoke all on function app.billing_enqueue_lifecycle_notices(date) from public, anon, authenticated, service_role;

create or replace function public.cron_enqueue_billing_lifecycle_notices() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.billing_enqueue_lifecycle_notices(app.billing_today());
$$;
revoke all on function public.cron_enqueue_billing_lifecycle_notices() from public, anon, authenticated;
grant execute on function public.cron_enqueue_billing_lifecycle_notices() to service_role;
-- == Paid AI, voice and WhatsApp pause (decision 41) ========================================
-- The service-role wrappers the app calls (20261004100000) ask first. In the grace, the
-- platform's paid AI and voice are refused with 'billing_paused' (the app says so and the
-- free paths, typing and the forms, carry on); a business's own OpenAI key is its own money and
-- still works. In retrieval and after, nothing runs. Rapid Rise's own support use is never the
-- business's to pay and is left to app.ai_reserve, which records it as internal.
create or replace function public.ai_reserve(
  p_farm uuid, p_user uuid, p_feature text, p_model text, p_units jsonb, p_credential text default 'platform'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.users u where u.id = p_user and u.role = 'rr_admin') then
    if app.farm_billing_gate(p_farm) <> 'ok'
       or (coalesce(p_credential, 'platform') = 'platform'
           and not app.farm_paid_extras_allowed(p_farm, app.billing_today())) then
      return jsonb_build_object('ok', false, 'reason', 'billing_paused');
    end if;
  end if;
  return app.ai_reserve(p_farm, p_user, p_feature, p_model, p_units, p_credential);
end $$;

create or replace function public.ai_open_voice_session(
  p_farm uuid, p_user uuid, p_max_audio_ms integer, p_max_characters integer, p_client_version text,
  p_source text default 'meter'
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.users u where u.id = p_user and u.role = 'rr_admin')
     and not app.farm_paid_extras_allowed(p_farm, app.billing_today()) then
    return jsonb_build_object('ok', false, 'reason', 'billing_paused');
  end if;
  return app.ai_open_voice_session(p_farm, p_user, p_max_audio_ms, p_max_characters, p_client_version, p_source);
end $$;

-- WhatsApp: a member is reachable on WhatsApp only while the business is fully paid up. In
-- the grace that pauses notifications sent there and the assistant behind it; in retrieval the
-- farm row already stopped it (20261015175415's body otherwise unchanged).
create or replace function app.whatsapp_member(p_user uuid, p_farm uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u join public.farms f on f.id = p_farm
    where u.id=p_user and u.active and u.deleted_at is null
      and u.role in ('owner','manager','mechanic','operator')
      and f.deleted_at is null and f.status in ('active','trial')
      and u.is_test = f.is_test
      and app.plan_rank(f.plan) >= app.feature_min_rank('whatsapp')
      and app.farm_paid_extras_allowed(p_farm, app.billing_today())
      and (exists(select 1 from public.user_farm_memberships m where m.user_id=u.id
             and m.farm_id=p_farm and m.active and m.deleted_at is null)
        or (u.farm_id=p_farm and not exists(select 1 from public.user_farm_memberships m
             where m.user_id=u.id and m.farm_id=p_farm)))
  );
$$;