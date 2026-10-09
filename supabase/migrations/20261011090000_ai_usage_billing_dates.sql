-- 20261011090000_ai_usage_billing_dates.sql
-- AI and voice use is billed on the farm's own billing date (founder decision, 2026-10-09).
--
-- 20261010090000 billed completed CALENDAR months, so a farm renewing on the 15th paid for
-- October's use on 15 November, six weeks after the first call, and an annual farm got an
-- AI-only invoice on whatever night its use crossed the minimum. The founder's rule is
-- simpler: AI use is charged on the same date as the subscription.
--
--   * A period invoice carries ALL unbilled use up to the end of the day before it is
--     raised (Africa/Johannesburg). A monthly farm's invoice on the 15th is the plan for the
--     month ahead plus the AI use of the month behind.
--   * A farm whose period invoice is not raised that month (an annual plan; a price on
--     application; grace) gets an AI-only invoice on the same day of the month as its
--     subscription (its anchor day, or the day it renews), once the use reaches the minimum.
--   * A billing date the nightly run missed is caught up: use older than 35 days is billed
--     on the next run whatever the day, so a skipped night never becomes a skipped month.
--   * At most one invoice carrying AI per farm per day: a hold settled after the morning
--     run waits for the next billing date instead of becoming a second charge that day.
--
-- The limit and the owner's page stay on calendar months: a limit is about how much may be
-- spent in a month, an invoice about when it is collected, and they need not share a clock.

drop function if exists app.ai_unbilled_cents(uuid, date);

-- The end of the billable window: midnight at the start of today in Johannesburg. Use from
-- today is billed on the next billing date, never on the invoice raised this morning.
create or replace function app.ai_billing_cutoff() returns timestamptz
language sql stable set search_path = public, pg_temp as $$
  select date_trunc('day', now() at time zone 'Africa/Johannesburg') at time zone 'Africa/Johannesburg'
$$;

-- A farm's unbilled use, ex VAT, from before p_before. The same rows
-- app.billing_attach_ai_usage stamps; 0 while invoicing is off (a NULL start matches none).
create or replace function app.ai_unbilled_cents(p_farm uuid, p_before timestamptz) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(u.billed_cents), 0)
    from public.ai_usage u
   where u.farm_id = p_farm
     and u.invoice_id is null
     and u.billed_cents > 0
     and u.credential = 'platform'
     and u.occurred_at >= app.ai_billing_from()
     and u.occurred_at < p_before
$$;

revoke execute on function app.ai_billing_cutoff() from public, anon, authenticated, service_role;
revoke execute on function app.ai_unbilled_cents(uuid, timestamptz) from public, anon, authenticated, service_role;

-- == Putting it on an invoice ===================================================
-- Stamps the farm's unbilled use from before today onto a DRAFT invoice, sets the header
-- and writes a line. Returns the ex-VAT cents added, 0 when there was nothing (or
-- invoicing is off), in which case nothing is touched.
create or replace function app.billing_attach_ai_usage(p_invoice uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  inv      public.billing_invoices%rowtype;
  v_from   timestamptz := app.ai_billing_from();
  v_cutoff timestamptz := app.ai_billing_cutoff();
  v_ex     numeric;
  v_first  date;
  v_people jsonb;
begin
  select * into inv from public.billing_invoices where id = p_invoice for update;
  if not found or inv.status <> 'draft' then
    raise exception 'BILLING: AI use can only be added to an invoice that is still a draft'
      using errcode = 'check_violation';
  end if;
  if v_from is null then
    return 0;
  end if;
  -- Under half a cent stays on the ledger for next time rather than being stamped onto an
  -- invoice as nothing.
  if round(app.ai_unbilled_cents(inv.farm_id, v_cutoff)) < 1 then
    return 0;
  end if;

  -- The predicate is app.ai_unbilled_cents', written out because an UPDATE needs it inline.
  with stamped as (
    update public.ai_usage u
       set invoice_id = p_invoice
     where u.farm_id = inv.farm_id
       and u.invoice_id is null
       and u.billed_cents > 0
       and u.credential = 'platform'
       and u.occurred_at >= v_from
       and u.occurred_at < v_cutoff
    returning u.user_id, u.occurred_at, u.feature, u.outcome, u.billed_cents, u.audio_ms, u.audio_fixed_ms
  ), people as (
    -- The owner's page counts the same way (public.ai_farm_usage): voice in seconds of
    -- audio, AI help in requests that answered.
    select s.user_id,
           sum(s.billed_cents) as billed,
           sum(case when s.feature = 'voice'
                    then coalesce(s.audio_ms, 0) + coalesce(s.audio_fixed_ms, 0) else 0 end) / 1000
             as voice_seconds,
           count(*) filter (where s.feature <> 'voice' and s.outcome in ('ok', 'fallback'))
             as ai_requests
      from stamped s
     group by s.user_id
  )
  select (select coalesce(sum(billed_cents), 0) from stamped),
         (select min((occurred_at at time zone 'Africa/Johannesburg')::date) from stamped),
         (select jsonb_agg(jsonb_build_object(
                   'user_id', p.user_id,
                   'name', coalesce(nullif(btrim(u.name), ''), u.email, ''),
                   'voice_seconds', p.voice_seconds,
                   'ai_requests', p.ai_requests,
                   'billed_cents', round(p.billed, 4))
                 order by p.billed desc, u.name)
            from people p
            left join public.users u on u.id = p.user_id)
    into v_ex, v_first, v_people;

  if coalesce(v_ex, 0) <= 0 then
    return 0;   -- another invoice stamped them in the meantime
  end if;

  -- The span is the first day with use to yesterday: what the farm reads as "the use since
  -- the last bill".
  update public.billing_invoices
     set ai_usage_ex_vat_cents = round(v_ex)::bigint,
         ai_usage_from         = v_first,
         ai_usage_to           = ((v_cutoff at time zone 'Africa/Johannesburg')::date - 1),
         ai_usage_people       = coalesce(v_people, '[]'::jsonb)
   where id = p_invoice;

  -- Shown on the statement; the money is on the header (the derive trigger has just added
  -- VAT to it), so the line copies the header rather than doing its own arithmetic.
  insert into public.billing_invoice_lines (
    invoice_id, farm_id, sort_order, description, qty, months_charged,
    unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
  )
  select i.id, i.farm_id, 10,
         'AI and voice use, ' || to_char(i.ai_usage_from, 'YYYY-MM-DD')
           || ' to ' || to_char(i.ai_usage_to, 'YYYY-MM-DD'),
         1, 1,
         i.ai_usage_incl_cents, i.ai_usage_incl_cents, i.ai_usage_ex_vat_cents,
         i.ai_usage_incl_cents - i.ai_usage_ex_vat_cents
    from public.billing_invoices i
   where i.id = p_invoice;

  return round(v_ex)::bigint;
end $$;

revoke execute on function app.billing_attach_ai_usage(uuid) from public, anon, authenticated, service_role;

-- == On the farm's billing date, for a farm no period invoice reached ============
create or replace function app.generate_ai_usage_invoices() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_set       public.billing_settings%rowtype;
  v_from      timestamptz := app.ai_billing_from();
  v_cutoff    timestamptz := app.ai_billing_cutoff();
  v_today     date := (now() at time zone 'Africa/Johannesburg')::date;
  v_month_len integer;
  v_day       integer;
  r           record;
  s           public.billing_subscriptions%rowtype;
  v_farm      public.farms%rowtype;
  v_invoice   uuid;
  v_made      integer := 0;
begin
  if v_from is null then
    return 0;
  end if;
  select * into v_set from public.billing_settings where singleton;
  v_month_len := extract(day from (date_trunc('month', v_today) + interval '1 month' - interval '1 day'))::integer;

  for r in
    select u.farm_id, min(u.occurred_at) as first_at
      from public.ai_usage u
      join public.farms f on f.id = u.farm_id and f.deleted_at is null
     where u.invoice_id is null
       and u.billed_cents > 0
       and u.credential = 'platform'
       and u.occurred_at >= v_from
       and u.occurred_at < v_cutoff
     group by u.farm_id
    having round(sum(u.billed_cents)) >= greatest(coalesce(v_set.ai_min_invoice_cents, 0), 1)
  loop
    -- The card is charged through the subscription. A farm without one (made by Rapid Rise,
    -- never signed up) has no card and no terms to bill on: its use stays on the ledger,
    -- by farm on /admin/ai, for Rapid Rise to settle by hand.
    select * into s from public.billing_subscriptions
     where farm_id = r.farm_id and deleted_at is null
     order by created_at desc
     limit 1
     for update skip locked;
    continue when not found;

    -- Not yet agreed to be billed: its use goes on its first invoice.
    continue when s.status in ('trialing', 'pending');

    -- One invoice carrying AI per farm per day. A period invoice raised this morning took
    -- every row before today; anything left is a hold settled since, and it waits.
    continue when exists (
      select 1 from public.billing_invoices i
       where i.farm_id = r.farm_id
         and i.kind in ('period', 'ai_usage')
         and i.issued_on = current_date
         and i.deleted_at is null
         and i.status <> 'void'
    );

    -- The farm's billing day of the month, clamped to a short month the way
    -- app.billing_advance_period seats a renewal: the anchor, or the day it renews.
    v_day := least(
      coalesce(s.anchor_day,
               extract(day from coalesce(s.next_billing_on, s.current_period_start, s.created_at::date))::integer),
      v_month_len);
    -- Not its day, unless a billing date was missed and the use has waited over 35 days.
    continue when extract(day from v_today)::integer <> v_day
              and r.first_at >= v_cutoff - interval '35 days';

    select * into v_farm from public.farms where id = r.farm_id;

    begin
      insert into public.billing_invoices (
        farm_id, subscription_id, invoice_ref, status, kind,
        period_start, period_end, issued_on, due_on,
        plan, billing_period, asset_count,
        unit_price_incl_cents, months_charged,
        price_version_id, price_version_label, vat_rate_bps,
        seller_vat_number, seller_snapshot, bill_to_snapshot
      ) values (
        -- A draft while it is assembled, as the generator does: lines may only be written
        -- to a draft. No vehicles and no unit price: the whole amount is the AI use. The
        -- period is the use's own span, the first day with use to yesterday.
        r.farm_id, s.id, app.next_billing_invoice_ref(), 'draft', 'ai_usage',
        (r.first_at at time zone 'Africa/Johannesburg')::date, v_today - 1,
        current_date, current_date + coalesce(v_set.payment_terms_days, 0),
        s.plan, s.billing_period, 0,
        0, 1,
        null, 'AI and voice use', v_set.vat_rate_bps,
        v_set.vat_number,
        jsonb_build_object(
          'legal_name', v_set.legal_name,
          'trading_name', v_set.trading_name,
          'reg_number', v_set.reg_number,
          'vat_registered', v_set.vat_registered,
          'billing_address', v_set.billing_address,
          'billing_email', v_set.billing_email
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
      continue;   -- raised already, by a run at the same instant
    end;

    if app.billing_attach_ai_usage(v_invoice) <= 0 then
      -- Another invoice took the rows between the sum above and the stamp. A draft may be
      -- deleted; an empty invoice must not be issued.
      delete from public.billing_invoices where id = v_invoice;
      continue;
    end if;

    update public.billing_invoices set status = 'open' where id = v_invoice;
    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

revoke execute on function app.generate_ai_usage_invoices() from public, anon, authenticated, service_role;

-- == The renewal notice: the use so far ==========================================
-- 20261010090000's notice; the AI use is now everything unbilled to date, which is what
-- the invoice will carry (plus whatever is used before then).
create or replace function app.enqueue_billing_renewal_notices() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s        public.billing_subscriptions%rowtype;
  v_set    public.billing_settings%rowtype;
  v_days   integer;
  v_due    date;
  v_units  integer;
  v_price  public.billing_price_versions%rowtype;
  v_amount bigint;
  v_ai_on  boolean := app.ai_billing_from() is not null;
  v_ai     bigint;
  v_rate   integer;
  v_sent   integer := 0;
begin
  select * into v_set from public.billing_settings where singleton limit 1;

  for s in
    select * from public.billing_subscriptions
     where deleted_at is null
       -- ACTIVE only. A farm in `past_due` or `grace` is already being told about a
       -- payment that failed; adding "and another one is coming" to that is noise on top
       -- of a problem. `pending` has never paid and `non_renewing` is not renewing.
       and status = 'active'
       and not cancel_at_period_end
  loop
    v_days := case s.billing_period
                when 'annual' then coalesce(v_set.renewal_notice_days_annual, 14)
                else coalesce(v_set.renewal_notice_days_monthly, 3)
              end;
    continue when v_days <= 0;

    v_due := coalesce(s.next_billing_on, s.current_period_end);
    continue when v_due is null;
    -- The window is the single day the notice is due, not "any time before". Anything
    -- wider re-sends every night until the charge lands.
    continue when v_due - v_days <> current_date;

    -- SILENT if there is no price: quoting a figure the generator will not produce would
    -- be worse than saying nothing, this message exists to make the deduction recognisable.
    select * into v_price from app.billing_price_for_subscription(s.id);
    continue when v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null;

    -- `coalesce(quota, counted)`, the same rule app.billing_billable_units applies, so
    -- the warned amount and the invoiced amount agree.
    v_units  := app.billing_billable_units(s.id);
    v_amount := v_price.per_vehicle_monthly_incl_cents::bigint
                  * greatest(v_units, 0) * v_price.months_charged;
    v_amount := v_amount - coalesce(app.billing_discount_cents(s.id, v_amount, v_due), 0);

    v_ai := 0;
    if v_ai_on then
      v_rate := case when v_set.vat_registered then coalesce(v_price.vat_rate_bps, 0) else 0 end;
      v_ai := round(app.ai_unbilled_cents(s.farm_id, now()) * (10000 + v_rate) / 10000)::bigint;
    end if;
    continue when v_amount <= 0 and v_ai <= 0;

    -- One per farm per period. Keyed off the DUE DATE in the payload rather than a time
    -- window, so a re-run, a double-fired schedule and a manual pass all land on the row
    -- that is already there.
    if exists (
      select 1 from public.notifications n
       where n.farm_id = s.farm_id
         and n.template = 'billing_renewal_due'
         and n.payload->>'due_on' = v_due::text
    ) then
      continue;
    end if;

    perform app.notify_farm(
      s.farm_id,
      'billing_renewal_due',
      jsonb_build_object(
        'due_on',         v_due,
        'amount_cents',   greatest(v_amount, 0),
        'plan',           s.plan,
        'billing_period', s.billing_period,
        'units',          v_units,
        'ai_billed',      v_ai_on,
        'ai_cents',       v_ai
      )
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;

revoke execute on function app.enqueue_billing_renewal_notices() from public, anon, authenticated;
