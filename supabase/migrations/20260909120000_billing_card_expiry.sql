-- 20260909120000_billing_card_expiry.sql
-- The card expires, and until now nothing noticed.
--
-- WHY
-- ─────────────────────────────────────────────────────────────────────────────
-- `billing_payment_methods` has stored `exp_month` and `exp_year` since the day it was
-- created, and NOTHING has ever read them. A card lasts about three years. On the day it
-- expires the stored authorization simply stops working, so the next renewal is declined
-- and the farm is walked down the whole dunning ladder — past_due, three retries, seven
-- days of grace, then a reduced plan — as though they had refused to pay.
--
-- They did not refuse. Nobody told them. Expired cards are the largest single cause of
-- involuntary churn in every subscription business, and the fix is a sentence sent before
-- the card stops rather than a ladder after it.
--
-- WHAT THIS DOES NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
-- It does NOT stop the charge. A card past its printed expiry often still works — issuers
-- reissue on the same PAN and networks run account-updater services — so refusing to try
-- would turn a probable success into a certain failure. Warn, never block: the same rule
-- the stock shortfall engine (0451/0503) and the receipt-missing warning (§4.6) follow.
--
-- The expiry date is the LAST DAY OF THE MONTH shown on the card, which is what "12/28"
-- means to a card network. Getting that wrong by a month would nag a farmer about a card
-- that is still perfectly good.

create or replace function app.billing_card_expiry_on(p_month text, p_year text)
returns date
language plpgsql immutable set search_path = public, pg_temp as $$
declare v_m integer; v_y integer;
begin
  -- Provider data, so it is text and may be anything. A card we cannot read the date of
  -- is not an error to raise at 3am; it is simply a card this engine says nothing about.
  if p_month is null or p_year is null then return null; end if;
  if p_month !~ '^[0-9]{1,2}$' or p_year !~ '^[0-9]{2}$|^[0-9]{4}$' then return null; end if;

  v_m := p_month::integer;
  v_y := p_year::integer;
  if v_m < 1 or v_m > 12 then return null; end if;
  -- Paystack sends four digits; two-digit years are read as this century, which is the
  -- only reading that is not absurd for a payment card.
  if v_y < 100 then v_y := 2000 + v_y; end if;

  return (make_date(v_y, v_m, 1) + interval '1 month' - interval '1 day')::date;
exception when others then
  return null;
end $$;

comment on function app.billing_card_expiry_on(text, text) is
  'The last day of the month printed on the card — what "12/28" means to a network. '
  'Null for anything unparseable, because a card whose date we cannot read is a card this '
  'engine stays quiet about rather than one it raises an error over.';

-- ── What is about to stop working ───────────────────────────────────────────

create or replace function app.billing_cards_expiring(p_within_days integer default 45)
returns table (
  farm_id uuid, payment_method_id uuid, card_brand text, last4 text,
  expires_on date, days_left integer, subscription_status billing_subscription_status
)
language sql stable security definer set search_path = public, pg_temp as $$
  select pm.farm_id, pm.id, pm.card_brand, pm.last4,
         app.billing_card_expiry_on(pm.exp_month, pm.exp_year),
         (app.billing_card_expiry_on(pm.exp_month, pm.exp_year) - current_date)::integer,
         s.status
    from public.billing_payment_methods pm
    join public.billing_subscriptions s
      on s.farm_id = pm.farm_id and s.deleted_at is null
   where pm.deleted_at is null
     and pm.status = 'active'
     and pm.reusable
     -- The card that will actually be charged. A farm may have an old one on file; only
     -- the default one stopping is news.
     and s.default_payment_method_id = pm.id
     -- A cancelled subscription is not going to be charged again, so its card expiring is
     -- not a problem anybody needs to hear about.
     and s.status in ('trialing', 'active', 'past_due', 'grace', 'non_renewing')
     and app.billing_card_expiry_on(pm.exp_month, pm.exp_year) is not null
     and app.billing_card_expiry_on(pm.exp_month, pm.exp_year)
           <= current_date + greatest(coalesce(p_within_days, 45), 0)
   order by 5;
$$;

-- ── Telling them, once a month rather than every night ──────────────────────
--
-- Dedupe reads the notification QUEUE itself, exactly as `app.enqueue_billing_reminders`
-- and the F13 work reminders do — no new column, and a re-run of the nightly pass cannot
-- produce a second alert. Thirty days rather than the reminders' seven: a card expiry is a
-- monthly-scale fact, and a farmer told weekly for six weeks stops reading them.

create or replace function app.enqueue_billing_card_expiry(p_within_days integer default 45)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_sent integer := 0;
begin
  for r in select * from app.billing_cards_expiring(p_within_days) loop
    if exists (
      select 1 from public.notifications n
       where n.farm_id = r.farm_id
         and n.template = 'billing_card_expiring'
         and n.created_at > now() - interval '30 days'
    ) then
      continue;
    end if;

    perform app.notify_farm(
      r.farm_id,
      'billing_card_expiring',
      jsonb_build_object(
        'card_brand', r.card_brand,
        'last4',      r.last4,
        'expires_on', r.expires_on,
        'days_left',  r.days_left
      )
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;

revoke execute on function app.billing_card_expiry_on(text, text) from public, anon;
grant  execute on function app.billing_card_expiry_on(text, text) to authenticated, service_role;
revoke execute on function app.billing_cards_expiring(integer) from public, anon, authenticated, service_role;
revoke execute on function app.enqueue_billing_card_expiry(integer) from public, anon, authenticated, service_role;

-- ── The wrappers PostgREST can reach ────────────────────────────────────────

create or replace function public.cron_enqueue_billing_card_expiry() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.enqueue_billing_card_expiry(45);
$$;

create or replace function public.billing_cards_expiring(p_within_days integer default 45)
returns table (
  farm_id uuid, payment_method_id uuid, card_brand text, last4 text,
  expires_on date, days_left integer, subscription_status billing_subscription_status
)
language sql security definer set search_path = public, pg_temp as $$
  select * from app.billing_cards_expiring(p_within_days);
$$;

do $do$
declare f text;
begin
  foreach f in array array[
    'public.cron_enqueue_billing_card_expiry()',
    'public.billing_cards_expiring(integer)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant  execute on function %s to service_role', f);
  end loop;
end $do$;
