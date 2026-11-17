-- 20261118120200_assistance_budget.sql
-- One monthly rand limit per customer for paid AI, voice and paid WhatsApp, chosen by the owner
-- (BRIEF section 12; decisions 22, 23 and 24; scenarios 30, 31 and 32). Extends the AI ledger of
-- 20261004100000 rather than replacing it: holds before paid work, settlement after, one lock.
--
-- == What changes ==========================================================================
-- * THE LIMIT IS THE CUSTOMER'S, NOT A SITE'S. assistance_budgets holds one chosen amount per
--   billing site (app.billing_root); every site billed through it spends from it. Spend is
--   summed over the customer's sites (app.customer_site_ids), so two sites never get two caps.
-- * NO DEFAULT. A customer with no row has no paid assistance: a hold is refused
--   'budget_unset' and the person gets the free paths (typing, forms, in-app alerts). Zero is a
--   valid choice that means "no paid help". The R200 platform default is no longer read. The
--   guards stay: a customer that has never paid us is held to the trial amount (R50), and an
--   owner may not set more than the owner maximum (Rapid Rise may).
-- * EXISTING CUSTOMERS KEEP WORKING. Every live billing site gets its current effective limit
--   as its chosen amount (source 'migrated') and its owners are told so, with where to change it.
-- * STAFF SUBLIMITS hold across the customer: a person's limit is the lowest set for them on any
--   of its sites, against what they spent on all of them; never more than the customer's cap.
-- * THE MONTH is the calendar month in Africa/Johannesburg for every plan, monthly or annual
--   (AI_USAGE.md: a billing period would make an annual customer's "monthly" limit yearly). The
--   owner's page states the zone and the next reset.
-- * WHATSAPP ON THE SAME LEDGER. A message is a hold (feature whatsapp_message) taken before it
--   is sent and settled from Meta's delivery status: Meta charges per DELIVERED message and says
--   on the status whether it was billable (pricing.type 'regular') or free (free_customer_service,
--   free_entry_point); a free one settles at R0 and a failed one at R0. A hold never answered in
--   72 hours settles at R0 with its estimated cost kept for reconciliation. Source:
--   developers.facebook.com/docs/whatsapp/pricing and the messages status webhook reference,
--   read 17 Nov 2026. Rapid Rise switches WhatsApp billing on with a start date and per-category
--   rates (ai_prices, model whatsapp/<category>, USD per message, read from the account's rate
--   card); until then nothing about sending changes. Once on, a paid send needs the owner's
--   acceptance of the charges and the cap (timestamp, terms version, the cap at the time).
-- * THE EVENT RECORD. Each ledger row now also keeps the customer it was billed to, the rate
--   version used, the supplier's currency and tax treatment (as Rapid Rise recorded it; nothing
--   is assumed) and the provider's pricing category, beside what it already kept: provider
--   request id (generation_id), exchange rate, margin, provider cost and the amount billed.
--
-- == Safe on live data =======================================================================
-- New table, new nullable columns or columns with constant defaults, widened checks added NOT
-- VALID and validated after (no long lock), replaced functions with the same signatures. The
-- migrated limits change no customer's spending room on the day.

-- == Settings ===============================================================================
alter table public.billing_settings add column if not exists whatsapp_billing_starts_on date;
alter table public.billing_settings add column if not exists supplier_tax_treatment text not null default 'unconfirmed';
alter table public.billing_settings drop constraint if exists billing_settings_supplier_tax_ck;
alter table public.billing_settings add constraint billing_settings_supplier_tax_ck check (
  supplier_tax_treatment in ('unconfirmed', 'no_vat_charged', 'vat_charged_claimable', 'vat_charged_not_claimable'));
comment on column public.billing_settings.whatsapp_billing_starts_on is
  'From this South African date paid WhatsApp messages are held, capped and billed (20261118120200). '
  'Null: not billed, sending unchanged. Set by Rapid Rise once the per-category rates are entered.';
comment on column public.billing_settings.supplier_tax_treatment is
  'How the AI, voice and WhatsApp suppliers'' invoices are taxed for Rapid Rise, as an accountant '
  'confirmed it; snapshotted on every usage row. unconfirmed until somebody records it.';

-- == The ledger takes WhatsApp messages and records more =====================================
alter table public.ai_reservations drop constraint if exists ai_reservations_feature_check;
alter table public.ai_reservations add constraint ai_reservations_feature_check
  check (feature in ('voice', 'ai_hearing', 'ai_answer', 'whatsapp_message')) not valid;
alter table public.ai_reservations validate constraint ai_reservations_feature_check;
alter table public.ai_usage drop constraint if exists ai_usage_feature_check;
alter table public.ai_usage add constraint ai_usage_feature_check
  check (feature in ('voice', 'ai_hearing', 'ai_answer', 'whatsapp_message')) not valid;
alter table public.ai_usage validate constraint ai_usage_feature_check;
alter table public.ai_usage drop constraint if exists ai_usage_provider_check;
alter table public.ai_usage add constraint ai_usage_provider_check
  check (provider in ('azure_speech', 'ai_gateway', 'whatsapp_cloud')) not valid;
alter table public.ai_usage validate constraint ai_usage_provider_check;
alter table public.ai_usage drop constraint if exists ai_usage_measured_check;
alter table public.ai_usage add constraint ai_usage_measured_check
  check (measured in ('server', 'gateway', 'client_bounded', 'estimated', 'provider')) not valid;
alter table public.ai_usage validate constraint ai_usage_measured_check;
alter table public.ai_prices drop constraint if exists ai_prices_unit_check;
alter table public.ai_prices add constraint ai_prices_unit_check
  check (unit in ('audio_second', 'audio_second_fixed', 'character', 'input_token', 'output_token',
                  'audio_input_token', 'message')) not valid;
alter table public.ai_prices validate constraint ai_prices_unit_check;

alter table public.ai_usage add column if not exists billing_root uuid references public.farms(id);
alter table public.ai_usage add column if not exists rate_version text;
alter table public.ai_usage add column if not exists supplier_currency text not null default 'USD';
alter table public.ai_usage add column if not exists supplier_tax text;
alter table public.ai_usage add column if not exists pricing_category text;
alter table public.ai_usage drop constraint if exists ai_usage_record_ck;
alter table public.ai_usage add constraint ai_usage_record_ck check (
  (rate_version is null or length(rate_version) <= 60)
  and supplier_currency ~ '^[A-Z]{3}$'
  and (supplier_tax is null or supplier_tax in ('unconfirmed', 'no_vat_charged', 'vat_charged_claimable', 'vat_charged_not_claimable'))
  and (pricing_category is null or pricing_category ~ '^[a-z_-]{1,40}$')) not valid;
alter table public.ai_usage validate constraint ai_usage_record_ck;
comment on column public.ai_usage.billing_root is
  'The customer (billing site) this row was billed to, as it was when settled (20261118120200).';
comment on column public.ai_usage.rate_version is
  'The price row used (its effective_from), or provider_reported when the provider''s own cost was used.';

-- == The customer's budget ==================================================================
create table if not exists public.assistance_budgets (
  -- The billing site: one row per customer.
  farm_id                        uuid primary key references public.farms(id),
  monthly_limit_cents            bigint not null check (monthly_limit_cents >= 0),
  source                         text not null check (source in ('owner', 'migrated', 'rapid_rise')),
  chosen_by                      uuid references public.users(id) on delete set null,
  chosen_at                      timestamptz not null default now(),
  -- Paid WhatsApp: the owner accepted the charge method and this cap (decision 24).
  whatsapp_accepted_by           uuid references public.users(id) on delete set null,
  whatsapp_accepted_at           timestamptz,
  whatsapp_terms_version         text check (whatsapp_terms_version is null or whatsapp_terms_version ~ '^[a-z0-9.-]{1,40}$'),
  whatsapp_accepted_limit_cents  bigint,
  -- "YYYY-MM:<limit>" a warning was last sent for, once per month and limit.
  warned_80                      text,
  warned_100                     text,
  updated_by                     uuid references public.users(id) on delete set null,
  updated_at                     timestamptz not null default now(),
  constraint assistance_budgets_whatsapp_ck check (
    (whatsapp_accepted_at is null) = (whatsapp_terms_version is null)
    and (whatsapp_accepted_at is null) = (whatsapp_accepted_limit_cents is null))
);
comment on table public.assistance_budgets is
  'One monthly rand limit per customer for paid AI, voice and WhatsApp, chosen by the owner (no '
  'default: no row means no paid assistance), and the owner''s acceptance of paid WhatsApp '
  '(20261118120200).';
alter table public.assistance_budgets enable row level security;
alter table public.assistance_budgets force row level security;
revoke all on public.assistance_budgets from public, anon, authenticated;
grant select on public.assistance_budgets to authenticated;
grant all on public.assistance_budgets to service_role;
drop policy if exists assistance_budgets_sel on public.assistance_budgets;
create policy assistance_budgets_sel on public.assistance_budgets for select to authenticated
  using ((select app.is_farm_billing_admin(farm_id)));
drop trigger if exists assistance_budgets_audit on public.assistance_budgets;
create trigger assistance_budgets_audit after insert or update or delete on public.assistance_budgets
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('assistance_budgets', 'rapid_rise', 'billing: the spending limit is the owner''s')
on conflict (table_name) do nothing;
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('assistance_budgets', 'open', 'paying: the owner reads the spending limit while stopped')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('assistance_budgets');

-- Existing customers keep their current limit as their choice (BEFORE the limit function below
-- starts reading this table), and their owners are told.
insert into public.assistance_budgets (farm_id, monthly_limit_cents, source, chosen_at)
select f.id, app.ai_effective_limit(f.id), 'migrated', now()
  from public.farms f
 where f.deleted_at is null and f.billed_through is null
on conflict (farm_id) do nothing;
do $migrated$
declare r record;
begin
  for r in select b.farm_id, b.monthly_limit_cents from public.assistance_budgets b where b.source = 'migrated' loop
    perform app.billing_notify_owners(r.farm_id, 'assistance_budget_migrated',
      jsonb_build_object('limit_cents', r.monthly_limit_cents));
  end loop;
end $migrated$;

-- A message's hold, found again by Meta's message id when its delivery status arrives.
create table if not exists public.whatsapp_usage_holds (
  reservation_id       uuid primary key references public.ai_reservations(id),
  provider_message_id  text not null unique check (char_length(provider_message_id) between 1 and 200),
  created_at           timestamptz not null default now()
);
comment on table public.whatsapp_usage_holds is
  'Which AI-ledger hold a sent WhatsApp message belongs to, by Meta''s message id, so the delivery '
  'status settles it once (20261118120200). Service role only.';
alter table public.whatsapp_usage_holds enable row level security;
alter table public.whatsapp_usage_holds force row level security;
revoke all on public.whatsapp_usage_holds from public, anon, authenticated;
grant all on public.whatsapp_usage_holds to service_role;

-- == Arithmetic =============================================================================
-- The customer's chosen limit with the trial guard, or null when nobody has chosen one.
create or replace function app.assistance_cap(p_farm uuid) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_root   uuid := app.billing_root(p_farm);
  v_chosen bigint;
  v_trial  bigint;
begin
  select b.monthly_limit_cents into v_chosen from public.assistance_budgets b where b.farm_id = v_root;
  if v_chosen is null then
    return null;
  end if;
  select ai_trial_limit_cents into v_trial from public.billing_settings where singleton limit 1;
  v_trial := coalesce(v_trial, 5000);
  -- The platform does not front a stranger's bill: until the customer has paid us, the trial
  -- amount caps the choice (and a test account always).
  if app.farm_is_test(v_root) or not app.ai_farm_has_paid(v_root) then
    return least(v_chosen, v_trial);
  end if;
  return v_chosen;
end $$;
revoke all on function app.assistance_cap(uuid) from public, anon, authenticated, service_role;

-- Never null (a null limit would make "spent + estimate > limit" pass): an unchosen budget
-- reads as nothing allowed. app.ai_reserve tells "not chosen" apart and says so.
create or replace function app.ai_effective_limit(p_farm uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(app.assistance_cap(p_farm), 0);
$$;

create or replace function app.ai_max_owner_limit(p_farm uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when app.ai_farm_has_paid(app.billing_root(p_farm)) and not app.farm_is_test(app.billing_root(p_farm))
                 then ai_max_owner_limit_cents else ai_trial_limit_cents end
       from public.billing_settings where singleton limit 1),
    5000)
$$;

-- Committed spend this month across the customer's sites: settled billed amounts plus every
-- unsettled hold; for one person, theirs on every site.
create or replace function app.ai_month_spend(p_farm uuid, p_month date, p_user uuid default null)
returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(billed_cents) from public.ai_usage
                    where farm_id = any (app.customer_site_ids(p_farm)) and month = p_month and credential = 'platform'
                      and (p_user is null or user_id = p_user)), 0)
       + coalesce((select sum(estimate_cents) from public.ai_reservations
                    where farm_id = any (app.customer_site_ids(p_farm)) and month = p_month and settled_at is null
                      and credential = 'platform' and (p_user is null or user_id = p_user)), 0)
$$;

-- A person's own limit inside the customer's: the lowest set for them on any of its sites.
create or replace function app.assistance_member_limit(p_farm uuid, p_user uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select min(l.monthly_limit_cents) from public.farm_member_ai_limits l
   where l.farm_id = any (app.customer_site_ids(p_farm)) and l.user_id = p_user;
$$;
revoke all on function app.assistance_member_limit(uuid, uuid) from public, anon, authenticated, service_role;

-- Is WhatsApp use billed today (Rapid Rise set the start date)?
create or replace function app.whatsapp_billing_on(p_today date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.whatsapp_billing_starts_on <= p_today from public.billing_settings s where s.singleton limit 1), false);
$$;
revoke all on function app.whatsapp_billing_on(date) from public, anon, authenticated, service_role;

-- 20261004100000's pricing, plus WhatsApp messages (unit 'message'). An unpriced message is priced
-- high, as every unpriced unit is; app.whatsapp_usage_reserve refuses an unpriced category before
-- it ever gets here.
create or replace function app.ai_price_units(p_model text, p_units jsonb, p_at timestamptz default now())
returns numeric
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_total numeric := 0;
  v_key text;
  v_raw text;
  v_qty numeric;
  v_unit text;
  v_price numeric;
begin
  for v_key, v_raw in select key, value from jsonb_each_text(coalesce(p_units, '{}'::jsonb)) loop
    v_unit := case v_key
      when 'audio_ms' then 'audio_second'
      when 'audio_fixed_ms' then 'audio_second_fixed'
      when 'characters' then 'character'
      when 'input_tokens' then 'input_token'
      when 'output_tokens' then 'output_token'
      when 'audio_input_tokens' then 'audio_input_token'
      when 'messages' then 'message'
    end;
    continue when v_unit is null or v_raw is null or v_raw !~ '^\d+(\.\d+)?([eE][-+]?\d+)?$';
    v_qty := v_raw::numeric;
    continue when v_qty <= 0;
    select usd_per_unit into v_price from public.ai_prices
     where model = p_model and unit = v_unit and effective_from <= p_at
     order by effective_from desc limit 1;
    if v_price is null then
      v_price := case v_unit
        when 'audio_second' then 0.0004 when 'audio_second_fixed' then 0.0004
        when 'character' then 0.00003 when 'output_token' then 0.00004
        when 'message' then 0.25
        else 0.00001 end;
    end if;
    v_total := v_total + (case when v_unit like 'audio_second%' then v_qty / 1000 else v_qty end) * v_price;
  end loop;
  return v_total;
end $$;

-- == Holding ================================================================================
-- 20261004100000's hold, for the customer: one lock per customer (its budget row) serialises
-- every hold any of its sites takes, the cap and the spend are the customer's, a person's
-- sublimit holds across its sites, and an unchosen budget is refused 'budget_unset'. WhatsApp
-- messages (feature whatsapp_message) are held like any other paid work. The rest is unchanged.
create or replace function app.ai_reserve(
  p_farm uuid, p_user uuid, p_feature text, p_model text, p_units jsonb, p_credential text default 'platform'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_settings public.farm_ai_settings;
  v_budget public.assistance_budgets;
  v_root uuid := app.billing_root(p_farm);
  v_role user_role;
  v_home uuid;
  v_credential text := p_credential;
  v_month date := app.ai_month(now());
  v_limit bigint;
  v_member_limit bigint;
  v_margin integer;
  v_estimate numeric := 0;
  v_spent numeric := 0;
  v_member_spent numeric;
  v_key text;
  v_notify boolean;
  v_notice timestamptz;
  v_opt_in boolean;
  v_withdrawn timestamptz;
  v_id uuid;
begin
  if p_feature not in ('voice', 'ai_hearing', 'ai_answer', 'whatsapp_message') then
    raise exception 'unknown AI feature %', p_feature using errcode = '22023';
  end if;
  if p_credential not in ('platform', 'farm_openai') then
    raise exception 'unknown AI credential %', p_credential using errcode = '22023';
  end if;

  -- One lock per CUSTOMER: two people at two sites cannot both pass the last of the budget.
  select * into v_budget from public.assistance_budgets where farm_id = v_root for update;
  insert into public.farm_ai_settings (farm_id) values (p_farm) on conflict (farm_id) do nothing;
  select * into v_settings from public.farm_ai_settings where farm_id = p_farm;

  v_role := app.ai_member_role(p_user, p_farm);
  if v_role is null then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  select farm_id into v_home from public.users where id = p_user;
  if v_role = 'rr_admin' and v_home is distinct from p_farm then
    -- Rapid Rise support on a customer's farm: recorded for the admin page, never billed to
    -- the farm, never counted against its limits.
    v_credential := 'internal';
  end if;

  if p_feature = 'voice' and not v_settings.voice_enabled then
    return jsonb_build_object('ok', false, 'reason', 'voice_off');
  end if;
  if p_feature in ('ai_hearing', 'ai_answer') then
    if not v_settings.ai_enabled then
      return jsonb_build_object('ok', false, 'reason', 'ai_off');
    end if;
    select ai_notice_seen_at, ai_processing_opt_in, ai_processing_withdrawn_at
      into v_notice, v_opt_in, v_withdrawn
      from public.users where id = p_user;
    -- POPIA s18: told at or before collection. Nothing leaves the country until the
    -- person has seen the notice, whatever the app shows.
    if v_notice is null then
      return jsonb_build_object('ok', false, 'reason', 'notice_required');
    end if;
    if not coalesce(v_opt_in, false) or v_withdrawn is not null then
      return jsonb_build_object('ok', false, 'reason', 'ai_off_for_you');
    end if;
  end if;

  -- No limit chosen: no paid work on our account (decision 23). Blank is never unlimited.
  if v_credential = 'platform' and v_budget.farm_id is null then
    return jsonb_build_object('ok', false, 'reason', 'budget_unset');
  end if;

  -- Priced for every credential, so a hold left unsettled can still be costed by the
  -- nightly sweep; only the platform's counts against a limit or is billed. The estimate is
  -- the customer charge: provider cost at the day's rate plus the margin.
  select ai_margin_bps into v_margin from public.billing_settings where singleton limit 1;
  v_estimate := app.ai_billed_cents(app.ai_price_units(p_model, p_units, now()), app.ai_fx(now()), coalesce(v_margin, 3000));
  if v_credential = 'platform' then
    v_limit := app.ai_effective_limit(p_farm);
    v_spent := app.ai_month_spend(p_farm, v_month);
    if v_spent + v_estimate > v_limit then
      -- The owner learns of the pause from us, once per month and limit, not from an
      -- employee: the first refusal sets the flag and queues the notice, together.
      v_key := to_char(v_month, 'YYYY-MM') || ':' || v_limit::text;
      update public.assistance_budgets set warned_100 = v_key
       where farm_id = v_root and warned_100 is distinct from v_key;
      v_notify := found;
      if v_notify then
        perform app.ai_notify_owners(v_root, 'ai_limit_reached', jsonb_build_object('limit_cents', v_limit));
      end if;
      return jsonb_build_object('ok', false, 'reason', 'farm_limit', 'notify_owner', v_notify,
                                'limit_cents', v_limit, 'spent_cents', v_spent);
    end if;
    v_member_limit := app.assistance_member_limit(p_farm, p_user);
    if v_member_limit is not null then
      v_member_spent := app.ai_month_spend(p_farm, v_month, p_user);
      if v_member_spent + v_estimate > v_member_limit then
        return jsonb_build_object('ok', false, 'reason', 'member_limit',
                                  'limit_cents', v_member_limit, 'spent_cents', v_member_spent);
      end if;
    end if;
  end if;

  insert into public.ai_reservations (farm_id, user_id, feature, credential, model, estimate_cents, month)
  values (p_farm, p_user, p_feature, v_credential, p_model, v_estimate, v_month)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'credential', v_credential, 'estimate_cents', v_estimate,
                            'remaining_cents', case when v_credential = 'platform' then v_limit - v_spent - v_estimate end);
end $$;

-- == Settling ===============================================================================
-- 20261004100000's settlement, plus the event record (customer, rate version, supplier currency
-- and tax, pricing category), WhatsApp messages (provider whatsapp_cloud, measured by the
-- provider), and the 80% warning kept on the customer's budget. Still idempotent, still clamped
-- to the hold, still billing only a call that answered.
create or replace function app.ai_settle(p_reservation uuid, p_attempts jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.ai_reservations;
  a jsonb;
  v_no integer := 0;
  v_fx numeric;
  v_margin integer;
  v_tax text;
  v_cost numeric;
  v_billed numeric;
  v_left numeric;
  v_total numeric := 0;
  v_limit bigint;
  v_spent numeric;
  v_key text;
  v_warn text;
  v_outcome text;
  v_model text;
  v_root uuid;
  v_rate text;
begin
  select * into r from public.ai_reservations where id = p_reservation for update;
  if not found then
    raise exception 'unknown AI reservation' using errcode = '22023';
  end if;
  if r.settled_at is not null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  v_root := app.billing_root(r.farm_id);

  select ai_margin_bps, supplier_tax_treatment into v_margin, v_tax from public.billing_settings where singleton limit 1;
  v_margin := case when r.credential = 'platform' then coalesce(v_margin, 3000) else 0 end;
  v_fx := app.ai_fx(r.created_at);
  v_left := r.estimate_cents;

  for a in select value from jsonb_array_elements(coalesce(p_attempts, '[]'::jsonb)) loop
    v_no := v_no + 1;
    exit when v_no > 5;
    v_outcome := coalesce(a->>'outcome', 'ok');
    v_model := coalesce(nullif(a->>'model', ''), r.model);
    -- `charged`: the provider did the work although the call failed (an answer that
    -- could not be used), so its real units are priced as cost, and still not billed.
    v_cost := case
      when (a->>'cost_usd') ~ '^\d+(\.\d+)?([eE][-+]?\d+)?$' then (a->>'cost_usd')::numeric
      when v_outcome in ('ok', 'fallback', 'unknown') or a->>'measured' = 'estimated' or a->>'charged' = 'true'
        then app.ai_price_units(v_model, a->'units', r.created_at)
      else 0
    end;
    v_rate := case
      when (a->>'cost_usd') ~ '^\d+(\.\d+)?([eE][-+]?\d+)?$' then 'provider_reported'
      else (select to_char(max(p.effective_from) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              from public.ai_prices p where p.model = v_model and p.effective_from <= r.created_at)
    end;
    v_billed := case
      when r.credential = 'platform' and v_outcome in ('ok', 'fallback') then app.ai_billed_cents(v_cost, v_fx, v_margin)
      else 0
    end;
    insert into public.ai_usage (
      farm_id, user_id, month, feature, provider, model, credential, attempt_no,
      audio_ms, audio_fixed_ms, characters, input_tokens, output_tokens, measured,
      provider_cost_usd, usd_zar, margin_bps, billed_cents, clamped,
      outcome, error_code, latency_ms, generation_id, reservation_id,
      billing_root, rate_version, supplier_currency, supplier_tax, pricing_category
    ) values (
      r.farm_id, r.user_id, r.month, r.feature,
      case r.feature when 'voice' then 'azure_speech' when 'whatsapp_message' then 'whatsapp_cloud' else 'ai_gateway' end,
      v_model, r.credential, v_no,
      nullif(a->'units'->>'audio_ms', '')::integer, nullif(a->'units'->>'audio_fixed_ms', '')::integer,
      nullif(a->'units'->>'characters', '')::integer, nullif(a->'units'->>'input_tokens', '')::integer,
      nullif(a->'units'->>'output_tokens', '')::integer,
      coalesce(a->>'measured', 'server'), v_cost, v_fx, v_margin,
      least(v_billed, v_left), v_billed > v_left,
      v_outcome, nullif(a->>'error_code', ''), nullif(a->>'latency_ms', '')::integer,
      left(nullif(a->>'generation_id', ''), 120), r.id,
      v_root, left(v_rate, 60), 'USD', coalesce(v_tax, 'unconfirmed'),
      case when a->>'category' ~ '^[a-z_-]{1,40}$' then a->>'category' end
    );
    v_total := v_total + least(v_billed, v_left);
    v_left := v_left - least(v_billed, v_left);
  end loop;

  update public.ai_reservations set settled_at = now() where id = r.id;

  if r.credential = 'platform' then
    v_limit := app.ai_effective_limit(r.farm_id);
    v_spent := app.ai_month_spend(r.farm_id, r.month);
    if v_limit > 0 and v_spent >= v_limit * 0.8 then
      -- Once per month and limit, for the customer, queued with the flag whichever path settled.
      v_key := to_char(r.month, 'YYYY-MM') || ':' || v_limit::text;
      update public.assistance_budgets set warned_80 = v_key
       where farm_id = v_root and warned_80 is distinct from v_key;
      if found then
        v_warn := '80';
        perform app.ai_notify_owners(v_root, 'ai_limit_80',
          jsonb_build_object('spent_cents', round(v_spent), 'limit_cents', v_limit));
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'billed_cents', v_total, 'warn', v_warn,
                            'spent_cents', v_spent, 'limit_cents', v_limit);
end $$;

-- 20261004100000's voice session, with the person's sublimit read across the customer's sites
-- (the cap and the spend already are, through app.ai_effective_limit and app.ai_month_spend).
create or replace function app.ai_open_voice_session(
  p_farm uuid, p_user uuid, p_max_audio_ms integer, p_max_characters integer, p_client_version text,
  p_source text default 'meter'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v jsonb;
  v_id uuid;
  v_audio integer := least(greatest(coalesce(p_max_audio_ms, 0), 0), 120000);
  v_chars integer := least(greatest(coalesce(p_max_characters, 0), 0), 4000);
  v_role user_role;
  v_home uuid;
  v_margin integer;
  v_month date := app.ai_month(now());
  v_full numeric;
  v_room numeric;
  v_member_limit bigint;
  v_factor numeric;
begin
  if p_source not in ('meter', 'token') then
    raise exception 'unknown voice session source %', p_source using errcode = '22023';
  end if;
  if p_source = 'token' and (
       (select count(*) from public.ai_voice_sessions
         where user_id = p_user and source = 'token' and opened_at > now() - interval '1 hour') >= 30
    or (select count(*) from public.ai_voice_sessions
         where user_id = p_user and source = 'token' and opened_at > now() - interval '1 day') >= 150) then
    return jsonb_build_object('ok', false, 'reason', 'token_rate');
  end if;
  v_role := app.ai_member_role(p_user, p_farm);
  select farm_id into v_home from public.users where id = p_user;
  if v_role is not null and not (v_role = 'rr_admin' and v_home is distinct from p_farm) then
    select ai_margin_bps into v_margin from public.billing_settings where singleton limit 1;
    v_full := app.ai_billed_cents(
      app.ai_price_units('azure-voice', jsonb_build_object('audio_ms', v_audio, 'characters', v_chars), now()),
      app.ai_fx(now()), coalesce(v_margin, 3000));
    v_room := app.ai_effective_limit(p_farm) - app.ai_month_spend(p_farm, v_month);
    v_member_limit := app.assistance_member_limit(p_farm, p_user);
    if v_member_limit is not null then
      v_room := least(v_room, v_member_limit - app.ai_month_spend(p_farm, v_month, p_user));
    end if;
    if v_full > 0 and v_room > 0 and v_room < v_full then
      -- A little under the exact fit, so rounding cannot tip the hold over the limit.
      v_factor := (v_room / v_full) * 0.98;
      if floor(v_audio * v_factor) >= 10000 then
        v_audio := floor(v_audio * v_factor)::integer;
        v_chars := floor(v_chars * v_factor)::integer;
      end if;
    end if;
  end if;
  v := app.ai_reserve(p_farm, p_user, 'voice', 'azure-voice',
         jsonb_build_object('audio_ms', v_audio, 'characters', v_chars), 'platform');
  if not (v->>'ok')::boolean then
    return v;
  end if;
  insert into public.ai_voice_sessions (reservation_id, farm_id, user_id, source, max_audio_ms, max_characters, client_version)
  values ((v->>'id')::uuid, p_farm, p_user, p_source, v_audio, v_chars, left(coalesce(p_client_version, 'legacy'), 40))
  returning id into v_id;
  return v || jsonb_build_object('session_id', v_id, 'max_audio_ms', v_audio, 'max_characters', v_chars);
end $$;

-- 20261004100000's nightly sweep. A WhatsApp message's hold waits 72 hours for Meta's delivery
-- status (Meta charges on delivery and reports it then) before it is settled at R0 as unknown,
-- its estimated cost kept for the reconciliation; everything else is unchanged.
create or replace function app.ai_settle_stale(p_older_than interval default interval '15 minutes')
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record;
  r record;
  v_voice integer := 0;
  v_ai integer := 0;
begin
  for s in
    select * from public.ai_voice_sessions
     where closed_at is null and opened_at < now() - p_older_than
     for update skip locked
  loop
    update public.ai_voice_sessions set closed_at = now() where id = s.id;
    perform app.ai_settle(s.reservation_id, jsonb_build_array(jsonb_build_object(
      'model', 'azure-voice', 'outcome', 'ok',
      'measured', case when s.last_report_at is null then 'estimated' else 'client_bounded' end,
      'units', case when s.last_report_at is null
        then jsonb_build_object('audio_ms', s.max_audio_ms, 'characters', s.max_characters)
        else jsonb_build_object('audio_ms', s.audio_ms, 'audio_fixed_ms', s.audio_fixed_ms, 'characters', s.characters)
      end)));
    v_voice := v_voice + 1;
  end loop;

  for r in
    select res.* from public.ai_reservations res
     where res.settled_at is null and res.feature <> 'voice'
       and res.created_at < now() - case when res.feature = 'whatsapp_message'
                                        then greatest(p_older_than, interval '72 hours') else p_older_than end
     for update skip locked
  loop
    insert into public.ai_usage (farm_id, user_id, month, feature, provider, model, credential, attempt_no,
      measured, provider_cost_usd, usd_zar, margin_bps, billed_cents, clamped, outcome, reservation_id,
      billing_root, supplier_tax)
    values (r.farm_id, r.user_id, r.month, r.feature,
      case when r.feature = 'whatsapp_message' then 'whatsapp_cloud' else 'ai_gateway' end,
      r.model, r.credential, 1,
      'estimated',
      round(r.estimate_cents / 100 / app.ai_fx(r.created_at) / (1 + coalesce((select ai_margin_bps from public.billing_settings where singleton limit 1), 3000)::numeric / 10000), 8),
      app.ai_fx(r.created_at), 0, 0, false, 'unknown', r.id,
      app.billing_root(r.farm_id), coalesce((select supplier_tax_treatment from public.billing_settings where singleton limit 1), 'unconfirmed'))
    on conflict (reservation_id, attempt_no) do nothing;
    update public.ai_reservations set settled_at = now() where id = r.id;
    v_ai := v_ai + 1;
  end loop;

  return jsonb_build_object('voice_sessions', v_voice, 'ai_holds', v_ai);
end $$;

-- == WhatsApp messages (service role) =======================================================
-- Before a message is sent. Unbilled (Rapid Rise has not switched WhatsApp billing on): sent as
-- today, nothing held. Billed: the owner's acceptance, a rate for the category, the paid-extras
-- rule and a hold on the customer's budget, or a refusal the sender turns into "not sent on
-- WhatsApp; it is in the app".
create or replace function public.whatsapp_usage_reserve(p_farm uuid, p_user uuid, p_category text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_budget public.assistance_budgets;
  v jsonb;
begin
  if not app.whatsapp_billing_on(app.billing_today()) then
    return jsonb_build_object('ok', true, 'metered', false);
  end if;
  if p_category is null or p_category not in ('utility', 'marketing', 'authentication', 'service') then
    return jsonb_build_object('ok', false, 'reason', 'whatsapp_bad_category');
  end if;
  if not app.farm_paid_extras_allowed(p_farm, app.billing_today()) then
    return jsonb_build_object('ok', false, 'reason', 'billing_paused');
  end if;
  select * into v_budget from public.assistance_budgets where farm_id = app.billing_root(p_farm);
  if v_budget.farm_id is null then
    return jsonb_build_object('ok', false, 'reason', 'budget_unset');
  end if;
  if v_budget.whatsapp_accepted_at is null then
    return jsonb_build_object('ok', false, 'reason', 'whatsapp_not_accepted');
  end if;
  if not exists (select 1 from public.ai_prices p
                  where p.model = 'whatsapp/' || p_category and p.unit = 'message' and p.effective_from <= now()) then
    return jsonb_build_object('ok', false, 'reason', 'whatsapp_unpriced');
  end if;
  v := app.ai_reserve(p_farm, p_user, 'whatsapp_message', 'whatsapp/' || p_category,
                      jsonb_build_object('messages', 1), 'platform');
  return v || jsonb_build_object('metered', true);
end $$;
revoke all on function public.whatsapp_usage_reserve(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_usage_reserve(uuid, uuid, text) to service_role;

-- Meta accepted the message: remember its id against the hold.
create or replace function public.whatsapp_usage_sent(p_reservation uuid, p_provider_message_id text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_reservation is null or p_provider_message_id is null then
    return false;
  end if;
  insert into public.whatsapp_usage_holds (reservation_id, provider_message_id)
  values (p_reservation, left(p_provider_message_id, 200))
  on conflict do nothing;
  return true;
end $$;
revoke all on function public.whatsapp_usage_sent(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_usage_sent(uuid, text) to service_role;

-- The send failed before Meta took it: the hold settles at R0.
create or replace function public.whatsapp_usage_release(p_reservation uuid, p_error_code text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  return app.ai_settle(p_reservation, jsonb_build_array(jsonb_build_object(
    'outcome', 'failed', 'measured', 'server',
    'error_code', case when p_error_code ~ '^[a-z0-9_]{1,40}$' then p_error_code end)));
end $$;
revoke all on function public.whatsapp_usage_release(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_usage_release(uuid, text) to service_role;

-- Meta's status for the message, with its pricing when it carries one. 'regular' is billable;
-- free_customer_service, free_entry_point and free_group_customer_service are free and settle at
-- R0 (billable, deprecated, decides only when no type is given). A failed delivery is not charged
-- by Meta and settles at R0. A status without pricing (sent) changes nothing. Once only.
create or replace function public.whatsapp_usage_settle(
  p_provider_message_id text, p_status text, p_billable boolean, p_type text, p_category text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h public.whatsapp_usage_holds;
  r public.ai_reservations;
  v_billable boolean;
  v_category text;
begin
  select * into h from public.whatsapp_usage_holds where provider_message_id = p_provider_message_id;
  if not found then
    return jsonb_build_object('ok', true, 'held', false);
  end if;
  select * into r from public.ai_reservations where id = h.reservation_id;
  if r.settled_at is not null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if p_status = 'failed' then
    return app.ai_settle(r.id, jsonb_build_array(jsonb_build_object(
      'outcome', 'failed', 'measured', 'provider', 'generation_id', p_provider_message_id)));
  end if;
  if p_type is null and p_billable is null then
    return jsonb_build_object('ok', true, 'pending', true);
  end if;
  v_billable := case when p_type is not null then p_type = 'regular' else coalesce(p_billable, false) end;
  v_category := case when p_category ~ '^[a-z_-]{1,40}$' then p_category else replace(r.model, 'whatsapp/', '') end;
  return app.ai_settle(r.id, jsonb_build_array(jsonb_build_object(
    'model', 'whatsapp/' || replace(v_category, 'group_', ''),
    'outcome', 'ok', 'measured', 'provider', 'category', v_category,
    'generation_id', p_provider_message_id,
    'units', case when v_billable then jsonb_build_object('messages', 1) else '{}'::jsonb end,
    'cost_usd', case when v_billable then null else '0' end)));
end $$;
revoke all on function public.whatsapp_usage_settle(text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.whatsapp_usage_settle(text, text, boolean, text, text) to service_role;

-- == What the owner sets ====================================================================
-- The customer's limit (the existing call shape, so the live build keeps working). Zero is a
-- choice; blank is refused, never unlimited.
create or replace function public.ai_set_farm_limit(p_farm uuid, p_limit_cents bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_root uuid := app.billing_root(p_farm);
  v_max  bigint;
begin
  if not app.is_farm_billing_admin(p_farm) and not app.is_farm_billing_admin(v_root) then
    raise exception 'Only the farm owner can change the AI limit.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  if p_limit_cents is null then
    return jsonb_build_object('ok', false, 'reason', 'limit_required');
  end if;
  v_max := app.ai_max_owner_limit(v_root);
  -- Until the customer has paid, the trial amount caps whatever is set, for a Rapid Rise admin
  -- too, so a higher value is refused rather than saved and silently ignored.
  if not app.ai_farm_has_paid(v_root) and p_limit_cents > v_max then
    return jsonb_build_object('ok', false, 'reason', 'trial_limit', 'max_limit_cents', v_max);
  end if;
  if p_limit_cents < 0 or (p_limit_cents > v_max and not app.is_rr_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'limit_out_of_range', 'max_limit_cents', v_max);
  end if;
  insert into public.assistance_budgets (farm_id, monthly_limit_cents, source, chosen_by, chosen_at, updated_by, updated_at)
  values (v_root, p_limit_cents, case when app.is_rr_admin() then 'rapid_rise' else 'owner' end, auth.uid(), now(), auth.uid(), now())
  on conflict (farm_id) do update
    set monthly_limit_cents = excluded.monthly_limit_cents, source = excluded.source,
        chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at,
        updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'limit_cents', app.ai_effective_limit(v_root));
end $$;
revoke all on function public.ai_set_farm_limit(uuid, bigint) from public, anon;
grant execute on function public.ai_set_farm_limit(uuid, bigint) to authenticated;

-- A person's own limit inside the customer's, kept on the billing site (one per person).
create or replace function public.ai_set_member_limit(p_farm uuid, p_user uuid, p_limit_cents bigint)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_root uuid := app.billing_root(p_farm);
begin
  if not app.is_farm_billing_admin(p_farm) and not app.is_farm_billing_admin(v_root) then
    raise exception 'Only the farm owner can change AI limits.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  -- Rapid Rise staff are not members for this purpose: their support use is internal.
  if app.ai_member_role(p_user, p_farm) is null or app.ai_member_role(p_user, p_farm) = 'rr_admin' then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  if p_limit_cents is not null and (p_limit_cents < 0 or (p_limit_cents > app.ai_max_owner_limit(v_root) and not app.is_rr_admin())) then
    return jsonb_build_object('ok', false, 'reason', 'limit_out_of_range', 'max_limit_cents', app.ai_max_owner_limit(v_root));
  end if;
  delete from public.farm_member_ai_limits
   where user_id = p_user and farm_id = any (app.customer_site_ids(p_farm)) and farm_id <> v_root;
  if p_limit_cents is null then
    delete from public.farm_member_ai_limits where farm_id = v_root and user_id = p_user;
  else
    insert into public.farm_member_ai_limits (farm_id, user_id, monthly_limit_cents, updated_by, updated_at)
    values (v_root, p_user, p_limit_cents, auth.uid(), now())
    on conflict (farm_id, user_id) do update
      set monthly_limit_cents = excluded.monthly_limit_cents, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.ai_set_member_limit(uuid, uuid, bigint) from public, anon;
grant execute on function public.ai_set_member_limit(uuid, uuid, bigint) to authenticated;

-- The owner accepts (or withdraws acceptance of) paid WhatsApp: how it is charged (cost + the
-- margin, free messages at R0) and the customer's cap, which must be chosen first (decision 24).
create or replace function public.assistance_accept_whatsapp(p_farm uuid, p_accept boolean, p_terms_version text)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_root uuid := app.billing_root(p_farm);
  v_budget public.assistance_budgets;
begin
  if auth.uid() is null or not (app.is_farm_billing_admin(p_farm) or app.is_farm_billing_admin(v_root)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  select * into v_budget from public.assistance_budgets where farm_id = v_root for update;
  if not coalesce(p_accept, false) then
    update public.assistance_budgets
       set whatsapp_accepted_by = null, whatsapp_accepted_at = null, whatsapp_terms_version = null,
           whatsapp_accepted_limit_cents = null, updated_by = auth.uid(), updated_at = now()
     where farm_id = v_root;
    return jsonb_build_object('ok', true, 'accepted', false);
  end if;
  if v_budget.farm_id is null then
    return jsonb_build_object('ok', false, 'reason', 'budget_unset');
  end if;
  if p_terms_version is null or p_terms_version !~ '^[a-z0-9.-]{1,40}$' then
    return jsonb_build_object('ok', false, 'reason', 'terms_required');
  end if;
  update public.assistance_budgets
     set whatsapp_accepted_by = auth.uid(), whatsapp_accepted_at = now(), whatsapp_terms_version = p_terms_version,
         whatsapp_accepted_limit_cents = v_budget.monthly_limit_cents, updated_by = auth.uid(), updated_at = now()
   where farm_id = v_root;
  return jsonb_build_object('ok', true, 'accepted', true, 'limit_cents', v_budget.monthly_limit_cents);
end $$;
revoke all on function public.assistance_accept_whatsapp(uuid, boolean, text) from public, anon;
grant execute on function public.assistance_accept_whatsapp(uuid, boolean, text) to authenticated;
comment on function public.assistance_accept_whatsapp(uuid, boolean, text) is
  'The owner accepts paid WhatsApp (charge method and the customer cap, with the terms version and '
  'time) or withdraws it (decision 24, 20261118120200).';

-- == What the owner reads ===================================================================
-- 20261112100000's page data, for the customer: the chosen limit (null when not chosen) and where
-- it came from, the spend of every site, the month's zone and next reset, paid WhatsApp's state,
-- and each person's use on every site. Keys the page already reads are kept.
create or replace function public.ai_farm_usage(p_farm uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_month date := app.ai_month(now());
  v_root  uuid := app.billing_root(p_farm);
  v_sites uuid[] := app.customer_site_ids(p_farm);
  v_budget public.assistance_budgets;
begin
  if not app.is_farm_billing_admin(p_farm) and not app.is_farm_billing_admin(v_root) then
    raise exception 'Only the farm owner can see AI and voice usage.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, false);
  select * into v_budget from public.assistance_budgets where farm_id = v_root;
  return jsonb_build_object(
    'month', v_month,
    'time_zone', 'Africa/Johannesburg',
    'resets_at', ((v_month + interval '1 month')::timestamp at time zone 'Africa/Johannesburg'),
    'limit_cents', app.ai_effective_limit(p_farm),
    'budget', case when v_budget.farm_id is null then null else jsonb_build_object(
      'chosen_cents', v_budget.monthly_limit_cents, 'source', v_budget.source,
      'chosen_at', v_budget.chosen_at) end,
    'sites', coalesce(array_length(v_sites, 1), 1),
    'has_paid', app.ai_farm_has_paid(v_root),
    'max_limit_cents', app.ai_max_owner_limit(v_root),
    'billed_cents', coalesce((select sum(billed_cents) from public.ai_usage
                               where farm_id = any (v_sites) and month = v_month and credential = 'platform'), 0),
    'held_cents', coalesce((select sum(estimate_cents) from public.ai_reservations
                             where farm_id = any (v_sites) and month = v_month and settled_at is null
                               and credential = 'platform'), 0),
    'whatsapp', jsonb_build_object(
      'billing_on', app.whatsapp_billing_on(app.billing_today()),
      'accepted_at', v_budget.whatsapp_accepted_at,
      'terms_version', v_budget.whatsapp_terms_version,
      'messages', (select count(*) from public.ai_usage where farm_id = any (v_sites) and month = v_month
                     and feature = 'whatsapp_message' and outcome = 'ok'),
      'billed_cents', coalesce((select sum(billed_cents) from public.ai_usage where farm_id = any (v_sites)
                                 and month = v_month and feature = 'whatsapp_message' and credential = 'platform'), 0)),
    'settings', (select to_jsonb(s) - 'warned_80' - 'warned_100' - 'monthly_limit_cents' from public.farm_ai_settings s where s.farm_id = p_farm),
    'key', (select jsonb_build_object('hint', k.hint, 'status', k.status, 'checked_at', k.checked_at)
              from public.farm_ai_keys k where k.farm_id = p_farm),
    'people', coalesce((
      select jsonb_agg(p order by p->>'name') from (
        select jsonb_build_object(
          'user_id', u.id,
          'name', coalesce(nullif(btrim(u.name), ''), u.email),
          'voice_seconds', coalesce((select sum(coalesce(x.audio_ms, 0) + coalesce(x.audio_fixed_ms, 0)) / 1000
                                       from public.ai_usage x where x.farm_id = any (v_sites) and x.user_id = u.id
                                        and x.month = v_month and x.feature = 'voice'), 0),
          'ai_requests', (select count(*) from public.ai_usage x where x.farm_id = any (v_sites) and x.user_id = u.id
                            and x.month = v_month and x.feature in ('ai_hearing', 'ai_answer') and x.outcome in ('ok', 'fallback')),
          'billed_cents', coalesce((select sum(x.billed_cents) from public.ai_usage x where x.farm_id = any (v_sites)
                                     and x.user_id = u.id and x.month = v_month and x.credential = 'platform'), 0),
          'limit_cents', app.assistance_member_limit(p_farm, u.id)
        ) as p
        from public.users u
       where u.role <> 'rr_admin'
         and u.id in (select user_id from public.ai_usage where farm_id = any (v_sites) and month = v_month
                                                             and credential = 'platform'
                      union select user_id from public.farm_member_ai_limits where farm_id = any (v_sites)
                      union select id from public.users where farm_id = p_farm and active and deleted_at is null
                      union select m.user_id from public.user_farm_memberships m
                             where m.farm_id = p_farm and m.active and m.deleted_at is null)
      ) people), '[]'::jsonb),
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'billed_cents', m.billed) order by m.month desc)
        from (select month, sum(billed_cents) as billed from public.ai_usage
               where farm_id = any (v_sites) and credential = 'platform'
                 and month >= (v_month - interval '5 months')::date and month < v_month
               group by month) m), '[]'::jsonb)
  );
end $$;
revoke all on function public.ai_farm_usage(uuid) from public, anon;
grant execute on function public.ai_farm_usage(uuid) to authenticated;
