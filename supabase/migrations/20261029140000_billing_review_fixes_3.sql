-- Third corrections, from verifying 20261029130000 (all redefinitions):
-- 1. public.admin_extend_billing_access moved anchor_day even when no days had been spent
--    suspended, which shortened every month of a month-end anchor after a same-day extension.
-- 2. It also set a farm that had cancelled back to active, so billing_close_cancellations
--    never closed it and the generator invoiced it again; it goes back to non_renewing.
-- 3. app.generate_billing_invoices invoiced a pending subscription only if it had never had
--    an invoice, so a paid-up farm that cancelled and reopened had nothing to pay and could
--    not come back; now: no live unpaid invoice.
-- 4. public.team_invite_existing's "never paid" ignored reversed payments while the dormant
--    sweep counts them.

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
         -- Only when days were spent suspended (20261029140000): a same-day extension of a
         -- month-end anchor (31, with next_billing_on clamped to the 28th) moved the anchor
         -- down to 28 and shortened every month after.
         anchor_day = case when status = 'suspended' and suspended_at is not null and next_billing_on is not null
                                and current_date > suspended_at::date
                           then extract(day from next_billing_on + (current_date - suspended_at::date))::integer
                           else anchor_day end,
         access_extended_until = p_until, access_extended_by = p_by,
         access_extension_reason = left(btrim(p_reason), 500),
         -- A farm that cancelled goes back to non_renewing, as the restore does, or it was
         -- never closed and was invoiced again (20261029140000).
         status = case when status = 'suspended'
                       then case when cancel_at_period_end then 'non_renewing'::billing_subscription_status
                                 else 'active'::billing_subscription_status end
                       else status end,
         suspended_at = case when status = 'suspended' then null else suspended_at end,
         updated_at = now()
   where id = v_sub;
  update public.farms set status = 'active', suspended_for = null
   where id = p_farm and status = 'suspended' and suspended_for = 'billing';
end $$;
revoke execute on function public.admin_extend_billing_access(uuid, date, text, uuid) from public, anon, authenticated;
grant  execute on function public.admin_extend_billing_access(uuid, date, text, uuid) to service_role;

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
       -- S7. Nothing here ever looked at the FARM. A farm that had been soft-deleted, or
       -- suspended, or cancelled by Rapid Rise, went on being invoiced every month and
       -- charged against its stored card, because every condition in this query is about
       -- the SUBSCRIPTION row. Selling another month to somebody who has left is the one
       -- billing mistake a customer will certainly notice and certainly tell people about.
       --
       -- 'trial' and 'active' are the states in which a farm is a going concern. A
       -- SUSPENDED farm stops being sold anything new here but stays chargeable in
       -- app.due_billing_charges, because they still owe for the months they had.
       and exists (
         select 1 from public.farms f
          where f.id = billing_subscriptions.farm_id
            and f.deleted_at is null
            and f.status in ('trial', 'active')
       )
       and (p_only is null or id = p_only)
       -- `pending` is here so a brand-new sign-up gets the invoice it is about to pay,
       -- and the clause below is what stops that becoming a monthly habit: a pending
       -- subscription is invoiced ONCE, ever. Without it, every abandoned sign-up would
       -- quietly accumulate an invoice a month for a farm nobody can even log into.
       and status in ('active', 'past_due', 'trialing', 'non_renewing', 'pending')
       -- No live UNPAID invoice (20261029140000), not "no invoice ever": a farm that paid
       -- for years, cancelled and reopened is pending with only paid invoices behind it, and
       -- was raised nothing to pay, so it could not come back at all. An abandoned sign-up
       -- still keeps its one open invoice, so it is still invoiced once.
       and (status <> 'pending' or not exists (
             select 1 from public.billing_invoices i
              where i.subscription_id = billing_subscriptions.id
                and i.deleted_at is null and i.status in ('draft', 'open')
           ))
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

    -- S8. Was app.billing_active_price(s.plan, s.billing_period), which resolves the
    -- CURRENTLY active version, so activating a new price silently moved every existing
    -- customer onto it at their next invoice, with no notice and no decision. Founder
    -- decision: a farm keeps the price it signed up at until somebody deliberately moves
    -- it. app.billing_price_for_subscription honours the pin and falls back to the active
    -- version when there is none, or when the pin no longer fits the plan they are on.
    select * into v_price from app.billing_price_for_subscription(s.id);
    if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
      continue;   -- no confirmed price, or price-on-application: never auto-bill
    end if;

    -- THE QUOTA, or the count when there is no quota.
    --
    -- Until now this was purely metered: count the machines, bill that many. Add a bakkie
    -- in March and March's invoice is R73 bigger, and nobody ever chose anything. Under
    -- the quota model the farm BUYS a number of slots at sign-up and that is what is
    -- billed, so the amount is fixed until they change it.
    --
    -- A NULL quota keeps the old behaviour exactly, and that is not an accident: every
    -- subscription that existed before this migration has one, and repricing them all on
    -- the night it shipped would be the same class of mistake as the price rise S8 fixed.
    v_count := app.billing_billable_units(s.id);
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
        -- An invoice is a draft while it is being assembled, that is what the word
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
      'FleetWise ' || s.plan::text || ', ' || v_count::text || ' vehicle(s)',
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

    -- AI USE (20261010090000). Every unbilled completed month of AI and voice use rides
    -- on the period invoice, while it is still a draft. Nothing at all while invoicing is
    -- off; on a proration or a slot purchase, never (those are not raised here).
    perform app.billing_attach_ai_usage(v_invoice);

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
           -- Record what was actually charged, rather than coalescing onto whatever was
           -- recorded first. With the pin above, the value is stable across renewals by
           -- construction; when a plan change makes the pin unusable the fallback is
           -- written here, so the row never claims a price it did not bill.
           price_version_id     = v_price.id,
           price_version_label  = v_price.version_label,
           status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
           updated_at = now()
     where id = s.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;
revoke execute on function app.generate_billing_invoices(uuid) from public, anon, authenticated;

create or replace function public.team_invite_existing(
  p_farm     uuid,
  p_actor    uuid,
  p_email    text,
  p_role     text,
  p_name     text,
  p_language text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email       text := lower(trim(coalesce(p_email, '')));
  v_actor_role  text;
  v_auth_id     uuid;
  v_blocked     boolean;
  v_user        public.users%rowtype;
  v_member      public.user_farm_memberships%rowtype;
  v_has_member  boolean;
  v_home_gone   boolean;
  v_gate        text;
  v_never_paid  boolean;
  v_move        boolean;
  v_lang        text := case when p_language = 'af' then 'af' else 'en' end;
begin
  if p_farm is null or p_actor is null or position('@' in v_email) < 2 then
    raise exception 'A farm, an inviter and an email address are required.'
      using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('owner', 'manager', 'mechanic', 'operator') then
    raise exception 'A farm invite is for a manager, a mechanic or an operator.'
      using errcode = '22023';
  end if;

  -- The server action checks this first. It is repeated because this runs as the service
  -- role, and a function that trusts whoever calls it is one bug away from a hole. Worked
  -- out the way lib/auth.ts effectiveFarmRole does (an active membership is authoritative
  -- for its farm, the profile role is the fallback for the home farm), plus a real Rapid
  -- Rise admin (20261028101200).
  v_actor_role := app.team_invite_actor_role(p_actor, p_farm);
  if v_actor_role is null or v_actor_role not in ('owner', 'manager', 'rr_admin')
     or not exists (select 1 from public.farms f where f.id = p_farm and f.deleted_at is null) then
    raise exception 'Only an owner or manager of this farm can invite people to it.'
      using errcode = '42501';
  end if;
  -- Only Rapid Rise makes somebody an owner: an owner holds the account and the card.
  if p_role = 'owner' and v_actor_role <> 'rr_admin' then
    raise exception 'A farm invite is for a manager, a mechanic or an operator.'
      using errcode = '22023';
  end if;

  -- Two invites for one address at once must not both decide. The second waits, then
  -- finds what the first one did.
  perform pg_advisory_xact_lock(hashtextextended('team-invite:' || v_email, 0));

  select u.id,
         (u.deleted_at is not null or coalesce(u.banned_until > now(), false))
    into v_auth_id, v_blocked
    from auth.users u
   where lower(u.email) = v_email
   limit 1;
  if v_auth_id is null then
    return jsonb_build_object('outcome', 'none');
  end if;
  if v_blocked then
    return jsonb_build_object('outcome', 'refused');
  end if;

  select * into v_user from public.users where id = v_auth_id for update;
  if not found then
    insert into public.users (id, farm_id, workshop_id, role, name, email, language, active)
    values (
      v_auth_id, p_farm, null, p_role::user_role,
      coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)),
      v_email, v_lang::app_language, true
    );
    insert into public.user_farm_memberships (user_id, farm_id, role, active)
    values (v_auth_id, p_farm, p_role::user_role, true)
    on conflict (user_id, farm_id) do update
       set role = excluded.role, active = true, deleted_at = null, deleted_by = null;
    return jsonb_build_object(
      'outcome', 'created', 'user_id', v_auth_id,
      'name', coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)),
      'language', v_lang);
  end if;

  if v_user.role in ('rr_admin', 'workshop') or v_user.workshop_id is not null then
    return jsonb_build_object('outcome', 'refused');
  end if;
  -- erase_personal_data blanks the address and soft-deletes the profile. A person who
  -- asked to be forgotten is not brought back by somebody else typing their email.
  if v_user.deleted_at is not null and v_user.email is null then
    return jsonb_build_object('outcome', 'refused');
  end if;

  select * into v_member
    from public.user_farm_memberships
   where user_id = v_user.id and farm_id = p_farm and deleted_at is null;
  v_has_member := found;

  if v_user.deleted_at is null and v_user.active then
    if v_user.farm_id = p_farm or (v_has_member and v_member.active) then
      return jsonb_build_object(
        'outcome', 'already', 'user_id', v_user.id,
        'name', v_user.name, 'language', v_user.language::text);
    end if;
  end if;

  if v_user.deleted_at is null and not v_user.active and v_user.farm_id = p_farm then
    return jsonb_build_object('outcome', 'switched_off', 'user_id', v_user.id);
  end if;

  select f.id is null or f.deleted_at is not null
    into v_home_gone
    from (select 1) one
    left join public.farms f on f.id = v_user.farm_id;
  v_gate := case when v_home_gone then 'closed' else app.farm_billing_gate(v_user.farm_id) end;
  -- The sweep's own test for a dormant sign-up: no payment row, ever.
  -- Reversed payments count too (20261029140000), as in app.sweep_dormant_signups: a
  -- sign-up whose EFT bounced is somebody who tried to pay, not a dormant row to move off.
  v_never_paid := not exists (
    select 1 from public.billing_payments p
     where p.farm_id = v_user.farm_id
  );

  v_move := v_user.deleted_at is not null
         or not v_user.active
         or v_home_gone
         or (v_gate = 'pending' and v_never_paid)
         or (v_gate <> 'ok' and v_user.role <> 'owner');

  if v_move then
    if v_user.deleted_at is null and not v_user.active then
      -- Their home farm switched them off. They stay off there.
      insert into public.user_farm_memberships (user_id, farm_id, role, active)
      values (v_user.id, v_user.farm_id, v_user.role, false)
      on conflict (user_id, farm_id) do update set active = false;
    end if;

    update public.users
       set farm_id = p_farm,
           workshop_id = null,
           role = p_role::user_role,
           active = true,
           deleted_at = null,
           deleted_by = null,
           email = coalesce(nullif(trim(email), ''), v_email)
     where id = v_user.id;
  end if;

  insert into public.user_farm_memberships (user_id, farm_id, role, active)
  values (v_user.id, p_farm, p_role::user_role, true)
  on conflict (user_id, farm_id) do update
     set role = excluded.role, active = true, deleted_at = null, deleted_by = null;

  return jsonb_build_object(
    'outcome', case when v_move then 'moved' else 'added' end,
    'user_id', v_user.id,
    'name', v_user.name,
    'language', v_user.language::text);
end $$;
revoke execute on function public.team_invite_existing(uuid, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.team_invite_existing(uuid, uuid, text, text, text, text)
  to service_role;
