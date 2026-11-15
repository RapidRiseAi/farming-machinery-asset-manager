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