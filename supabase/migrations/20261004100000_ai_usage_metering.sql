-- AI and voice usage: an exact ledger, and owner limits that hold.
--
-- Founder decisions of 2026-10-03 (docs/AI_USAGE.md, docs/FLEETWISE_FOUNDER_DECISIONS.md
-- decision 10): usage is billed at provider cost in Rand plus a margin the platform admin
-- sets; owners set monthly limits, farm-wide and per person, and at the limit voice and AI
-- pause; a farm may link its own OpenAI key, whose usage is recorded but not billed by us.
-- This migration is the ledger and the limits. Putting the ledger on invoices is a later
-- migration, so nothing here changes what any existing invoice or charge does.
--
-- Everything is additive. The build still serving while this is applied calls none of it.
--
-- The month is always the calendar month in Africa/Johannesburg, for every farm. Billing
-- periods were the first idea and the wrong one: an annual subscription would make the
-- "monthly" limit a yearly one, and between midnight and the billing cron, or for any
-- subscription the generator skips, today falls outside the period and the cap would read
-- zero spend.
--
-- Money: provider cost in USD, at the day's ECB rate, plus the margin, is what the farm is
-- billed, EXCLUDING VAT (VAT is added at the invoice's rate when it is invoiced). Kept to
-- 4 decimals of a cent per row; rounding to whole cents happens once, per invoice line.
--
-- Who sees what (docs/BILLING.md section 10): money is visible to the farm's billing
-- admins (owner, Rapid Rise admin) only. Members read their own minutes and requests,
-- never Rand, through ai_my_usage(). Provider cost, rate and margin are for platform
-- admins. Every write goes through the SECURITY DEFINER functions here; the ones that
-- spend are executable by the service role alone, and the server passes the farm and the
-- person from the signed-in session, never from the request body.

-- == Settings on the single audited billing_settings row ==========================

alter table public.billing_settings
  add column if not exists ai_margin_bps integer not null default 3000
    check (ai_margin_bps between 0 and 50000),
  add column if not exists ai_default_limit_cents bigint not null default 20000
    check (ai_default_limit_cents >= 0),
  add column if not exists ai_trial_limit_cents bigint not null default 5000
    check (ai_trial_limit_cents >= 0),
  add column if not exists ai_max_owner_limit_cents bigint not null default 500000
    check (ai_max_owner_limit_cents >= 0),
  add column if not exists ai_fallback_usd_zar numeric(10,4) not null default 18.0000
    check (ai_fallback_usd_zar > 0);

comment on column public.billing_settings.ai_margin_bps is
  'Margin on AI and voice provider cost, in basis points (3000 = 30%).';
comment on column public.billing_settings.ai_trial_limit_cents is
  'Monthly AI and voice limit, ex VAT, for a farm that has never paid an invoice; owners cannot raise it until one is paid.';

-- == Prices and exchange rates ====================================================

create table public.ai_prices (
  model           text not null check (char_length(model) between 1 and 120),
  unit            text not null check (unit in (
                    'audio_second', 'audio_second_fixed', 'character',
                    'input_token', 'output_token', 'audio_input_token')),
  usd_per_unit    numeric(24,14) not null check (usd_per_unit >= 0),
  effective_from  timestamptz not null default now(),
  source          text not null check (source in ('gateway', 'azure_retail', 'manual', 'seed')),
  confirmed_by    uuid references public.users(id),
  created_at      timestamptz not null default now(),
  primary key (model, unit, effective_from)
);

create table public.fx_rates (
  day         date primary key,
  usd_zar     numeric(10,4) not null check (usd_zar > 0),
  source      text not null check (source in ('ecb', 'manual', 'seed')),
  fetched_at  timestamptz not null default now()
);

-- Prices read on 2026-10-04: Azure retail prices API (southafricanorth, S1 meters) and
-- the Vercel AI Gateway's public model list. `azure-voice` is one Azure Speech session:
-- live recognition with continuous language ID ($1.00 + $0.30 enhanced add-on per audio
-- hour), fixed-language recognition ($1.00 per hour) and neural speech ($15 per million
-- characters). gpt-4o-transcribe is priced by OpenAI in tokens: audio in at $6, text in
-- (the machine-name prompt) at $2.50 and text out at $10 per million. Its audio_second
-- figure is OpenAI's own $0.006 a minute for the audio part, so a hold for a hearing adds
-- the prompt's tokens and an allowance for the transcript to it (the server's
-- hearingHoldUnits), and settlement uses the reported cost or the real token counts.
insert into public.ai_prices (model, unit, usd_per_unit, effective_from, source) values
  ('azure-voice', 'audio_second',        1.30 / 3600, '2026-10-01', 'seed'),
  ('azure-voice', 'audio_second_fixed',  1.00 / 3600, '2026-10-01', 'seed'),
  ('azure-voice', 'character',           0.000015,    '2026-10-01', 'seed'),
  ('openai/gpt-4o-transcribe', 'audio_second',      0.0001,     '2026-10-01', 'seed'),
  ('openai/gpt-4o-transcribe', 'audio_input_token', 0.000006,   '2026-10-01', 'seed'),
  ('openai/gpt-4o-transcribe', 'input_token',       0.0000025,  '2026-10-01', 'seed'),
  ('openai/gpt-4o-transcribe', 'output_token',      0.00001,    '2026-10-01', 'seed'),
  ('microsoft/mai-transcribe-2', 'audio_second',    0.00002778, '2026-10-01', 'seed'),
  ('openai/gpt-5-mini',  'input_token',  0.00000025, '2026-10-01', 'seed'),
  ('openai/gpt-5-mini',  'output_token', 0.000002,   '2026-10-01', 'seed'),
  ('openai/gpt-5-nano',  'input_token',  0.00000005, '2026-10-01', 'seed'),
  ('openai/gpt-5-nano',  'output_token', 0.0000004,  '2026-10-01', 'seed'),
  ('openai/gpt-4.1-mini', 'input_token',  0.0000004, '2026-10-01', 'seed'),
  ('openai/gpt-4.1-mini', 'output_token', 0.0000016, '2026-10-01', 'seed'),
  ('google/gemini-2.5-flash-lite', 'input_token',  0.0000001, '2026-10-01', 'seed'),
  ('google/gemini-2.5-flash-lite', 'output_token', 0.0000004, '2026-10-01', 'seed');

insert into public.fx_rates (day, usd_zar, source) values ('2026-10-02', 16.7340, 'seed');

-- == A farm's settings, limits and own key ========================================

create table public.farm_ai_settings (
  farm_id              uuid primary key references public.farms(id) on delete cascade,
  ai_enabled           boolean not null default true,
  voice_enabled        boolean not null default true,
  -- Null means "the default for this farm": the trial limit until an invoice has been
  -- paid, then the platform default. A converted trial is never left on R50.
  monthly_limit_cents  bigint check (monthly_limit_cents is null or monthly_limit_cents >= 0),
  -- When a linked OpenAI key fails: pause AI (default) or carry on, billed, on ours.
  own_key_fallback     text not null default 'pause' check (own_key_fallback in ('pause', 'platform')),
  -- "YYYY-MM:<limit cents>" a warning was last sent for: once per month AND limit, so a
  -- raised limit warns again on its own 80% and 100%.
  warned_80            text,
  warned_100           text,
  updated_by           uuid references public.users(id),
  updated_at           timestamptz not null default now()
);

create table public.farm_member_ai_limits (
  farm_id              uuid not null references public.farms(id) on delete cascade,
  user_id              uuid not null references public.users(id),
  monthly_limit_cents  bigint not null check (monthly_limit_cents >= 0),
  updated_by           uuid references public.users(id),
  updated_at           timestamptz not null default now(),
  primary key (farm_id, user_id)
);

create table public.farm_ai_keys (
  farm_id          uuid primary key references public.farms(id) on delete cascade,
  provider         text not null default 'openai' check (provider = 'openai'),
  ciphertext       text not null check (ciphertext like 'v2.%'),
  hint             text not null check (char_length(hint) = 4),
  status           text not null default 'active' check (status in ('active', 'invalid', 'no_quota')),
  checked_at       timestamptz not null default now(),
  last_error_code  text check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,40}$'),
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- == Holds, voice sessions and the ledger =========================================

-- A hold on a farm's budget for one paid attempt, taken BEFORE the provider is called.
-- Every unsettled hold counts against the month, however old: a hold stops counting only
-- when its settlement row is written. Nothing frees budget by merely expiring.
create table public.ai_reservations (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null references public.farms(id),
  user_id         uuid not null references public.users(id),
  feature         text not null check (feature in ('voice', 'ai_hearing', 'ai_answer')),
  credential      text not null check (credential in ('platform', 'farm_openai', 'internal')),
  model           text not null,
  estimate_cents  numeric(14,4) not null check (estimate_cents >= 0),
  month           date not null,
  created_at      timestamptz not null default now(),
  settled_at      timestamptz
);
create index ai_reservations_open_idx on public.ai_reservations (farm_id, month) where settled_at is null;
create index ai_reservations_stale_idx on public.ai_reservations (created_at) where settled_at is null;

-- One stretch of Azure Speech use from the browser, sized to the farm's headroom and
-- capped at two minutes. Azure itself cannot enforce it (the token works on the whole
-- resource), so the browser reports cumulative use and the database clamps each report to
-- the session's maximum. A session never reported is settled at its full maximum.
--
-- Every Azure token the server hands out opens one (source 'token'), so no client gets a
-- token without budget held for it: an app that never reports, such as an installed copy
-- of an older build, is billed each token's full session. The browser opens more as each
-- fills (source 'meter').
create table public.ai_voice_sessions (
  id               uuid primary key default gen_random_uuid(),
  reservation_id   uuid not null unique references public.ai_reservations(id),
  farm_id          uuid not null references public.farms(id),
  user_id          uuid not null references public.users(id),
  source           text not null default 'meter' check (source in ('meter', 'token')),
  max_audio_ms     integer not null check (max_audio_ms between 0 and 120000),
  max_characters   integer not null check (max_characters between 0 and 4000),
  audio_ms         integer not null default 0 check (audio_ms >= 0),
  audio_fixed_ms   integer not null default 0 check (audio_fixed_ms >= 0),
  characters       integer not null default 0 check (characters >= 0),
  client_version   text check (client_version is null or char_length(client_version) <= 40),
  opened_at        timestamptz not null default now(),
  last_report_at   timestamptz,
  closed_at        timestamptz
);
create index ai_voice_sessions_open_idx on public.ai_voice_sessions (opened_at) where closed_at is null;
create index ai_voice_sessions_user_token_idx on public.ai_voice_sessions (user_id, opened_at) where source = 'token';

create table public.ai_usage (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null references public.farms(id),
  user_id            uuid not null references public.users(id),
  occurred_at        timestamptz not null default now(),
  month              date not null,
  feature            text not null check (feature in ('voice', 'ai_hearing', 'ai_answer')),
  provider           text not null check (provider in ('azure_speech', 'ai_gateway')),
  model              text not null check (char_length(model) between 1 and 120),
  credential         text not null check (credential in ('platform', 'farm_openai', 'internal')),
  attempt_no         smallint not null default 1 check (attempt_no between 1 and 5),
  audio_ms           integer check (audio_ms >= 0),
  audio_fixed_ms     integer check (audio_fixed_ms >= 0),
  characters         integer check (characters >= 0),
  input_tokens       integer check (input_tokens >= 0),
  output_tokens      integer check (output_tokens >= 0),
  measured           text not null check (measured in ('server', 'gateway', 'client_bounded', 'estimated')),
  -- What the provider charged, unclamped, so cost against billed stays true...
  provider_cost_usd  numeric(14,8) not null default 0 check (provider_cost_usd >= 0),
  usd_zar            numeric(10,4) not null check (usd_zar > 0),
  margin_bps         integer not null check (margin_bps >= 0),
  -- ...and what the farm is billed, ex VAT, clamped to its hold so a limit is never passed.
  billed_cents       numeric(14,4) not null default 0 check (billed_cents >= 0),
  clamped            boolean not null default false,
  outcome            text not null check (outcome in (
                       'ok', 'fallback', 'failed', 'timeout', 'rate_limited',
                       'no_credit', 'key_invalid', 'cancelled', 'unknown')),
  error_code         text check (error_code is null or error_code ~ '^[a-z0-9_]{1,40}$'),
  latency_ms         integer check (latency_ms >= 0),
  generation_id      text check (generation_id is null or char_length(generation_id) <= 120),
  reservation_id     uuid not null references public.ai_reservations(id),
  -- Set once, by the invoicing migration to come; never billed twice.
  invoice_id         uuid references public.billing_invoices(id),
  created_at         timestamptz not null default now(),
  constraint ai_usage_attempt_uq unique (reservation_id, attempt_no),
  constraint ai_usage_billed_platform_ck check (credential = 'platform' or billed_cents = 0)
);
create index ai_usage_farm_month_idx on public.ai_usage (farm_id, month);
create index ai_usage_farm_user_month_idx on public.ai_usage (farm_id, user_id, month);
create index ai_usage_uninvoiced_idx on public.ai_usage (farm_id, occurred_at)
  where invoice_id is null and billed_cents > 0;
create index ai_usage_model_recent_idx on public.ai_usage (model, occurred_at);

-- A money record: never deleted, and never changed except to stamp the invoice once.
-- POPIA erasure pseudonymises the person's users row and keeps this UUID, as every other
-- table does, so erasure needs no exception here.
create or replace function app.ai_usage_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'ai_usage is a money record and is never deleted.' using errcode = '42501';
  end if;
  if old.invoice_id is null and new.invoice_id is not null
     and (to_jsonb(new) - 'invoice_id') = (to_jsonb(old) - 'invoice_id') then
    return new;
  end if;
  raise exception 'ai_usage rows cannot be changed once written.' using errcode = '42501';
end $$;
create trigger ai_usage_guard before update or delete on public.ai_usage
  for each row execute function app.ai_usage_guard();

-- What went wrong, for the founder: a provider failing, Gateway credit low, a price that
-- moved too far to take without a person confirming it. One open row per kind and subject.
create table public.ai_health_events (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in (
                 'model_failures', 'no_credit', 'gateway_auth', 'low_credit', 'price_pending',
                 'fx_stale', 'model_unpriced', 'voice_token_failures', 'canary_failed',
                 'holds_clamped', 'voice_underreported')),
  subject      text not null default '' check (char_length(subject) <= 120),
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  alerted_at   timestamptz,
  resolved_at  timestamptz
);
create unique index ai_health_events_open_uq on public.ai_health_events (kind, subject) where resolved_at is null;

-- == Grants and row security ======================================================

alter table public.ai_prices enable row level security;
alter table public.fx_rates enable row level security;
alter table public.farm_ai_settings enable row level security;
alter table public.farm_member_ai_limits enable row level security;
alter table public.farm_ai_keys enable row level security;
alter table public.ai_reservations enable row level security;
alter table public.ai_voice_sessions enable row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_health_events enable row level security;

revoke all on public.ai_prices, public.fx_rates, public.farm_ai_settings, public.farm_member_ai_limits,
  public.farm_ai_keys, public.ai_reservations, public.ai_voice_sessions, public.ai_usage,
  public.ai_health_events from public, anon, authenticated;
grant all on public.ai_prices, public.fx_rates, public.farm_ai_settings, public.farm_member_ai_limits,
  public.farm_ai_keys, public.ai_reservations, public.ai_voice_sessions, public.ai_usage,
  public.ai_health_events to service_role;

-- Read-only, and only where a policy says so. The key, holds and sessions have no grant
-- at all for signed-in users: only the server reads them. On the ledger, the farm's
-- billing admins read what was used and what they were billed, never Rapid Rise's
-- provider cost, exchange rate or margin: those columns have no grant, and /admin/ai reads
-- them through ai_admin_month().
grant select (id, farm_id, user_id, occurred_at, month, feature, provider, model, credential, attempt_no,
              audio_ms, audio_fixed_ms, characters, input_tokens, output_tokens, measured,
              billed_cents, clamped, outcome, error_code, latency_ms, reservation_id, invoice_id, created_at)
  on public.ai_usage to authenticated;
grant select on public.farm_ai_settings, public.farm_member_ai_limits to authenticated;
grant select on public.ai_prices, public.fx_rates, public.ai_health_events to authenticated;

create policy ai_usage_billing_admin_read on public.ai_usage for select to authenticated
  using (app.is_farm_billing_admin(farm_id));
create policy farm_ai_settings_billing_admin_read on public.farm_ai_settings for select to authenticated
  using (app.is_farm_billing_admin(farm_id));
create policy farm_member_ai_limits_billing_admin_read on public.farm_member_ai_limits for select to authenticated
  using (app.is_farm_billing_admin(farm_id));
create policy ai_prices_platform_read on public.ai_prices for select to authenticated using (app.is_rr_admin());
create policy fx_rates_platform_read on public.fx_rates for select to authenticated using (app.is_rr_admin());
create policy ai_health_events_platform_read on public.ai_health_events for select to authenticated using (app.is_rr_admin());

-- == Arithmetic ====================================================================

create or replace function app.ai_month(p_at timestamptz default now()) returns date
language sql stable set search_path = public, pg_temp as $$
  select date_trunc('month', p_at at time zone 'Africa/Johannesburg')::date
$$;

create or replace function app.ai_fx(p_at timestamptz default now()) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select usd_zar from public.fx_rates
      where day <= (p_at at time zone 'Africa/Johannesburg')::date order by day desc limit 1),
    (select ai_fallback_usd_zar from public.billing_settings where singleton limit 1),
    18.0000)
$$;

-- USD cost of some units of use, at the prices in force at p_at. A unit with no price is
-- priced high on purpose (the server raises a model_unpriced health event and the founder
-- adds the price): an unknown model must never look free.
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
        else 0.00001 end;
    end if;
    v_total := v_total + (case when v_unit like 'audio_second%' then v_qty / 1000 else v_qty end) * v_price;
  end loop;
  return v_total;
end $$;

-- What the farm is billed, ex VAT, in cents to 4 decimals. The margin is cast to numeric:
-- integer 3000 / 10000 is 0, and a margin of zero would bill every call at cost.
create or replace function app.ai_billed_cents(p_cost_usd numeric, p_usd_zar numeric, p_margin_bps integer)
returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select round(coalesce(p_cost_usd, 0) * p_usd_zar * 100 * (1 + p_margin_bps::numeric / 10000), 4)
$$;

-- The role p_user holds on p_farm, for the server acting on that person's behalf. Mirrors
-- app.effective_farm_role rule for rule, because that function answers only for the
-- signed-in caller (it returns null unless auth.uid() is p_user, and the service role may
-- not execute it), so it says nothing to the server or to an owner asking about an employee.
create or replace function app.ai_member_role(p_user uuid, p_farm uuid) returns user_role
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_user public.users%rowtype;
  v_role user_role;
begin
  if p_user is null or p_farm is null then
    return null;
  end if;
  select * into v_user from public.users where id = p_user and active and deleted_at is null;
  if not found then
    return null;
  end if;
  if v_user.role = 'rr_admin' then
    return 'rr_admin'::user_role;
  end if;
  if v_user.role = 'workshop' then
    return null;
  end if;
  select m.role into v_role from public.user_farm_memberships m
   where m.user_id = p_user and m.farm_id = p_farm and m.active and m.deleted_at is null;
  if v_role is not null then
    return v_role;
  end if;
  if v_user.farm_id = p_farm and v_user.role in ('owner', 'manager', 'mechanic', 'operator') then
    return v_user.role;
  end if;
  return null;
end $$;

-- Has this farm ever paid us money? Until it has, its limit is the trial limit and the
-- owner cannot raise it: the platform does not front a stranger's AI bill. Money actually
-- received, net of refunds and reversals, not an invoice's status: an invoice with nothing
-- to collect (a 100% promotion, a free month) is marked paid without a cent changing hands.
create or replace function app.ai_farm_has_paid(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(p.amount_incl_cents) from public.billing_payments p
                    where p.farm_id = p_farm and p.deleted_at is null), 0) > 0
$$;

-- Never null: a null limit would make "spent + estimate > limit" null, which an IF reads
-- as false, and every hold would pass with no cap at all. A missing settings row falls
-- back to the shipped defaults.
create or replace function app.ai_effective_limit(p_farm uuid) returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_own bigint;
  v_trial bigint;
  v_default bigint;
begin
  select monthly_limit_cents into v_own from public.farm_ai_settings where farm_id = p_farm;
  select ai_trial_limit_cents, ai_default_limit_cents into v_trial, v_default
    from public.billing_settings where singleton limit 1;
  v_trial := coalesce(v_trial, 5000);
  v_default := coalesce(v_default, 20000);
  if not app.ai_farm_has_paid(p_farm) then
    return least(coalesce(v_own, v_trial), v_trial);
  end if;
  return coalesce(v_own, v_default);
end $$;

-- The highest limit an owner may set: the trial limit until the farm has paid an invoice,
-- then the platform maximum (above it, a Rapid Rise admin sets it).
create or replace function app.ai_max_owner_limit(p_farm uuid) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when app.ai_farm_has_paid(p_farm) then ai_max_owner_limit_cents else ai_trial_limit_cents end
       from public.billing_settings where singleton limit 1),
    5000)
$$;

-- Committed spend this month: settled billed amounts plus every unsettled hold.
create or replace function app.ai_month_spend(p_farm uuid, p_month date, p_user uuid default null)
returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select sum(billed_cents) from public.ai_usage
                    where farm_id = p_farm and month = p_month and credential = 'platform'
                      and (p_user is null or user_id = p_user)), 0)
       + coalesce((select sum(estimate_cents) from public.ai_reservations
                    where farm_id = p_farm and month = p_month and settled_at is null
                      and credential = 'platform' and (p_user is null or user_id = p_user)), 0)
$$;

-- An in-app notice (Web Push delivers it too) to every owner of the farm: home-farm owners
-- and owners by membership alike, never a Rapid Rise admin. The ledger functions call it
-- in the same transaction that sets the once-per-month flag, so the warning cannot be lost
-- between the flag and a caller that forgets to deliver it. Shaped like app.notify_farm
-- (0261): same columns, same channel, same queue, and the person's in-app opt-out holds.
create or replace function app.ai_notify_owners(p_farm uuid, p_template text, p_payload jsonb)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sent integer;
begin
  if p_farm is null then
    return 0;
  end if;
  insert into public.notifications (farm_id, user_id, channel, template, payload, status)
  select p_farm, u.id, 'inapp', p_template, coalesce(p_payload, '{}'::jsonb), 'queued'
    from public.users u
   where u.active and u.deleted_at is null and u.role <> 'rr_admin'
     and coalesce(u.notify_inapp, true)
     and (u.farm_id = p_farm
          or exists (select 1 from public.user_farm_memberships m
                      where m.user_id = u.id and m.farm_id = p_farm and m.active and m.deleted_at is null))
     and app.ai_member_role(u.id, p_farm) = 'owner';
  get diagnostics v_sent = row_count;
  return v_sent;
end $$;

-- == Holding and settling ==========================================================

-- Takes a hold for ONE paid attempt. Each platform-credential attempt (a fallback model, a
-- retry on our key after a farm's key failed) takes its own hold, so no call is ever made
-- on the platform's account without budget held for it.
create or replace function app.ai_reserve(
  p_farm uuid, p_user uuid, p_feature text, p_model text, p_units jsonb, p_credential text default 'platform'
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_settings public.farm_ai_settings;
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
  if p_feature not in ('voice', 'ai_hearing', 'ai_answer') then
    raise exception 'unknown AI feature %', p_feature using errcode = '22023';
  end if;
  if p_credential not in ('platform', 'farm_openai') then
    raise exception 'unknown AI credential %', p_credential using errcode = '22023';
  end if;

  -- One lock per farm serialises every hold the farm takes, so two people at once cannot
  -- both pass the last of the budget.
  insert into public.farm_ai_settings (farm_id) values (p_farm) on conflict (farm_id) do nothing;
  select * into v_settings from public.farm_ai_settings where farm_id = p_farm for update;

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

  -- Priced for every credential, so a hold left unsettled can still be costed by the
  -- nightly sweep; only the platform's counts against a limit or is billed.
  select ai_margin_bps into v_margin from public.billing_settings where singleton limit 1;
  v_estimate := app.ai_billed_cents(app.ai_price_units(p_model, p_units, now()), app.ai_fx(now()), coalesce(v_margin, 3000));
  if v_credential = 'platform' then
    v_limit := app.ai_effective_limit(p_farm);
    v_spent := app.ai_month_spend(p_farm, v_month);
    if v_spent + v_estimate > v_limit then
      -- The owner learns of the pause from us, once per month and limit, not from an
      -- employee: the first refusal sets the flag and queues the notice, together.
      v_key := to_char(v_month, 'YYYY-MM') || ':' || v_limit::text;
      update public.farm_ai_settings set warned_100 = v_key
       where farm_id = p_farm and warned_100 is distinct from v_key;
      v_notify := found;
      if v_notify then
        perform app.ai_notify_owners(p_farm, 'ai_limit_reached', jsonb_build_object('limit_cents', v_limit));
      end if;
      return jsonb_build_object('ok', false, 'reason', 'farm_limit', 'notify_owner', v_notify,
                                'limit_cents', v_limit, 'spent_cents', v_spent);
    end if;
    select monthly_limit_cents into v_member_limit
      from public.farm_member_ai_limits where farm_id = p_farm and user_id = p_user;
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

-- Writes the ledger rows for the attempts made under one hold and releases it. Idempotent:
-- a second settlement of the same hold (a retried request, the nightly sweep racing a late
-- report) returns without writing anything.
--
-- p_attempts: [{model, outcome, units: {...}, cost_usd?, measured?, error_code?,
-- latency_ms?, generation_id?}]. cost_usd, when the provider reported it, wins over priced
-- units. The farm's billed amount is clamped to the hold, so the limit is never passed;
-- the true provider cost is kept beside it.
--
-- Only a call that answered (ok, fallback) is billed. A call that failed, timed out or was
-- cancelled bills nothing, but one cut off after it was sent ('estimated') still records
-- what it probably cost the platform, priced on the units held for it, so cost against
-- billed stays honest on /admin/ai.
create or replace function app.ai_settle(p_reservation uuid, p_attempts jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r public.ai_reservations;
  a jsonb;
  v_no integer := 0;
  v_fx numeric;
  v_margin integer;
  v_cost numeric;
  v_billed numeric;
  v_left numeric;
  v_total numeric := 0;
  v_limit bigint;
  v_spent numeric;
  v_key text;
  v_warn text;
  v_outcome text;
begin
  select * into r from public.ai_reservations where id = p_reservation for update;
  if not found then
    raise exception 'unknown AI reservation' using errcode = '22023';
  end if;
  if r.settled_at is not null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  select ai_margin_bps into v_margin from public.billing_settings where singleton limit 1;
  v_margin := case when r.credential = 'platform' then coalesce(v_margin, 3000) else 0 end;
  v_fx := app.ai_fx(r.created_at);
  v_left := r.estimate_cents;

  for a in select value from jsonb_array_elements(coalesce(p_attempts, '[]'::jsonb)) loop
    v_no := v_no + 1;
    exit when v_no > 5;
    v_outcome := coalesce(a->>'outcome', 'ok');
    -- `charged`: the provider did the work although the call failed (an answer that
    -- could not be used), so its real units are priced as cost, and still not billed.
    v_cost := case
      when (a->>'cost_usd') ~ '^\d+(\.\d+)?([eE][-+]?\d+)?$' then (a->>'cost_usd')::numeric
      when v_outcome in ('ok', 'fallback', 'unknown') or a->>'measured' = 'estimated' or a->>'charged' = 'true'
        then app.ai_price_units(coalesce(nullif(a->>'model', ''), r.model), a->'units', r.created_at)
      else 0
    end;
    v_billed := case
      when r.credential = 'platform' and v_outcome in ('ok', 'fallback') then app.ai_billed_cents(v_cost, v_fx, v_margin)
      else 0
    end;
    insert into public.ai_usage (
      farm_id, user_id, month, feature, provider, model, credential, attempt_no,
      audio_ms, audio_fixed_ms, characters, input_tokens, output_tokens, measured,
      provider_cost_usd, usd_zar, margin_bps, billed_cents, clamped,
      outcome, error_code, latency_ms, generation_id, reservation_id
    ) values (
      r.farm_id, r.user_id, r.month, r.feature,
      case when r.feature = 'voice' then 'azure_speech' else 'ai_gateway' end,
      coalesce(nullif(a->>'model', ''), r.model), r.credential, v_no,
      nullif(a->'units'->>'audio_ms', '')::integer, nullif(a->'units'->>'audio_fixed_ms', '')::integer,
      nullif(a->'units'->>'characters', '')::integer, nullif(a->'units'->>'input_tokens', '')::integer,
      nullif(a->'units'->>'output_tokens', '')::integer,
      coalesce(a->>'measured', 'server'), v_cost, v_fx, v_margin,
      least(v_billed, v_left), v_billed > v_left,
      v_outcome, nullif(a->>'error_code', ''), nullif(a->>'latency_ms', '')::integer,
      left(nullif(a->>'generation_id', ''), 120), r.id
    );
    v_total := v_total + least(v_billed, v_left);
    v_left := v_left - least(v_billed, v_left);
  end loop;

  update public.ai_reservations set settled_at = now() where id = r.id;

  if r.credential = 'platform' then
    v_limit := app.ai_effective_limit(r.farm_id);
    v_spent := app.ai_month_spend(r.farm_id, r.month);
    if v_limit > 0 and v_spent >= v_limit * 0.8 then
      -- Once per month and limit, queued with the flag whichever path settled (an AI call,
      -- a voice report, the nightly sweep), so no caller can drop it.
      v_key := to_char(r.month, 'YYYY-MM') || ':' || v_limit::text;
      update public.farm_ai_settings set warned_80 = v_key
       where farm_id = r.farm_id and warned_80 is distinct from v_key;
      if found then
        v_warn := '80';
        perform app.ai_notify_owners(r.farm_id, 'ai_limit_80',
          jsonb_build_object('spent_cents', round(v_spent), 'limit_cents', v_limit));
      end if;
    end if;
  end if;
  return jsonb_build_object('ok', true, 'billed_cents', v_total, 'warn', v_warn,
                            'spent_cents', v_spent, 'limit_cents', v_limit);
end $$;

-- == Voice sessions ================================================================

-- Opens a session sized to what the farm (and the person) have left: one the month cannot
-- take whole is shrunk to fit, down to ten seconds of audio, rather than refused while
-- budget remains. Below that floor the hold is refused as usual, which tells the owner.
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
  -- A token works on the whole Speech resource for about ten minutes, whatever is reported
  -- against its session, so tokens are capped per person: far above real use (the app
  -- reuses one for eight and a half minutes), a ceiling on what a tampered client could
  -- take. The nightly job also flags anyone who takes tokens without reporting use.
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
    select monthly_limit_cents into v_member_limit
      from public.farm_member_ai_limits where farm_id = p_farm and user_id = p_user;
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

-- Cumulative usage for a session, any number of times, from the browser (a regular report,
-- a final one, or a beacon as the page closes). Each counter only ever rises and is clamped
-- to the session's maximum. Not to the time since the session opened: a recording made
-- offline is recognised from a file faster than it was spoken, and is billed in full.
create or replace function app.ai_report_voice_session(
  p_session uuid, p_user uuid, p_audio_ms integer, p_audio_fixed_ms integer, p_characters integer, p_final boolean
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.ai_voice_sessions;
  v_audio integer;
  v_fixed integer;
  v_chars integer;
begin
  select * into s from public.ai_voice_sessions where id = p_session for update;
  if not found or s.user_id is distinct from p_user then
    return jsonb_build_object('ok', false, 'reason', 'unknown_session');
  end if;
  if s.closed_at is not null then
    -- Closed already (a final report, or the nightly sweep under a tab left open): the
    -- browser must stop using it and open another, or its use would go unmetered.
    return jsonb_build_object('ok', true, 'already', true, 'closed', true);
  end if;
  v_audio := least(greatest(coalesce(p_audio_ms, 0), s.audio_ms), s.max_audio_ms);
  v_fixed := least(greatest(coalesce(p_audio_fixed_ms, 0), s.audio_fixed_ms), greatest(s.max_audio_ms - v_audio, 0));
  v_chars := least(greatest(coalesce(p_characters, 0), s.characters), s.max_characters);
  update public.ai_voice_sessions
     set audio_ms = v_audio, audio_fixed_ms = v_fixed, characters = v_chars, last_report_at = now(),
         closed_at = case when p_final then now() end
   where id = s.id;
  if p_final then
    perform app.ai_settle(s.reservation_id, jsonb_build_array(jsonb_build_object(
      'model', 'azure-voice', 'outcome', 'ok', 'measured', 'client_bounded',
      'units', jsonb_build_object('audio_ms', v_audio, 'audio_fixed_ms', v_fixed, 'characters', v_chars))));
  end if;
  return jsonb_build_object('ok', true, 'audio_ms', v_audio, 'audio_fixed_ms', v_fixed,
                            'characters', v_chars, 'closed', coalesce(p_final, false));
end $$;

-- The nightly sweep. A voice session still open 15 minutes after it opened is settled: at
-- what was reported if anything was (the app reports after every use, every 30 seconds
-- while in use, and when it is hidden or closed), or at its full maximum if nothing ever
-- was: an app that never reports, such as an installed copy of an older build, is billed
-- the whole session its token opened. An AI hold left unsettled (the function died after
-- calling the provider) is settled as 'unknown': its estimated cost is recorded for the
-- founder's reconciliation, and the farm is not billed for a call nobody saw finish.
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
     where res.settled_at is null and res.feature <> 'voice' and res.created_at < now() - p_older_than
     for update skip locked
  loop
    -- Billed nothing: settle with a priced attempt on a zero-estimate copy of the hold is
    -- not possible, so write the row directly.
    insert into public.ai_usage (farm_id, user_id, month, feature, provider, model, credential, attempt_no,
      measured, provider_cost_usd, usd_zar, margin_bps, billed_cents, clamped, outcome, reservation_id)
    values (r.farm_id, r.user_id, r.month, r.feature, 'ai_gateway', r.model, r.credential, 1,
      'estimated',
      round(r.estimate_cents / 100 / app.ai_fx(r.created_at) / (1 + coalesce((select ai_margin_bps from public.billing_settings where singleton limit 1), 3000)::numeric / 10000), 8),
      app.ai_fx(r.created_at), 0, 0, false, 'unknown', r.id)
    on conflict (reservation_id, attempt_no) do nothing;
    update public.ai_reservations set settled_at = now() where id = r.id;
    v_ai := v_ai + 1;
  end loop;

  return jsonb_build_object('voice_sessions', v_voice, 'ai_holds', v_ai);
end $$;

-- == What the owner and the employee may read ======================================

-- Everything the owner's AI page shows, for billing admins only.
create or replace function public.ai_farm_usage(p_farm uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_month date := app.ai_month(now());
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can see AI and voice usage.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'month', v_month,
    'limit_cents', app.ai_effective_limit(p_farm),
    'has_paid', app.ai_farm_has_paid(p_farm),
    'max_limit_cents', app.ai_max_owner_limit(p_farm),
    'billed_cents', coalesce((select sum(billed_cents) from public.ai_usage
                               where farm_id = p_farm and month = v_month and credential = 'platform'), 0),
    'held_cents', coalesce((select sum(estimate_cents) from public.ai_reservations
                             where farm_id = p_farm and month = v_month and settled_at is null
                               and credential = 'platform'), 0),
    'settings', (select to_jsonb(s) - 'warned_80' - 'warned_100' from public.farm_ai_settings s where s.farm_id = p_farm),
    'key', (select jsonb_build_object('hint', k.hint, 'status', k.status, 'checked_at', k.checked_at)
              from public.farm_ai_keys k where k.farm_id = p_farm),
    'people', coalesce((
      select jsonb_agg(p order by p->>'name') from (
        select jsonb_build_object(
          'user_id', u.id,
          'name', coalesce(nullif(btrim(u.name), ''), u.email),
          'voice_seconds', coalesce((select sum(coalesce(x.audio_ms, 0) + coalesce(x.audio_fixed_ms, 0)) / 1000
                                       from public.ai_usage x where x.farm_id = p_farm and x.user_id = u.id
                                        and x.month = v_month and x.feature = 'voice'), 0),
          'ai_requests', (select count(*) from public.ai_usage x where x.farm_id = p_farm and x.user_id = u.id
                            and x.month = v_month and x.feature <> 'voice' and x.outcome in ('ok', 'fallback')),
          'billed_cents', coalesce((select sum(x.billed_cents) from public.ai_usage x where x.farm_id = p_farm
                                     and x.user_id = u.id and x.month = v_month and x.credential = 'platform'), 0),
          'limit_cents', (select l.monthly_limit_cents from public.farm_member_ai_limits l
                           where l.farm_id = p_farm and l.user_id = u.id)
        ) as p
        from public.users u
       -- Everyone who belongs to the farm (home farm or membership), so a limit can be set
       -- before someone's first use, and anyone billed this month. Never Rapid Rise staff:
       -- their support use is internal, not billed, and a limit would never apply to it.
       where u.role <> 'rr_admin'
         and u.id in (select user_id from public.ai_usage where farm_id = p_farm and month = v_month
                                                             and credential = 'platform'
                      union select user_id from public.farm_member_ai_limits where farm_id = p_farm
                      union select id from public.users where farm_id = p_farm and active and deleted_at is null
                      union select m.user_id from public.user_farm_memberships m
                             where m.farm_id = p_farm and m.active and m.deleted_at is null)
      ) people), '[]'::jsonb),
    -- The five months before this one; this month is the card at the top.
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'billed_cents', m.billed) order by m.month desc)
        from (select month, sum(billed_cents) as billed from public.ai_usage
               where farm_id = p_farm and credential = 'platform'
                 and month >= (v_month - interval '5 months')::date and month < v_month
               group by month) m), '[]'::jsonb)
  );
end $$;

-- A person's own use this month: minutes and requests, never money (BILLING.md section 10).
create or replace function public.ai_my_usage(p_farm uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_month date := app.ai_month(now());
begin
  if auth.uid() is null or app.effective_farm_role(auth.uid(), p_farm) is null then
    raise exception 'Not a member of this farm.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'month', v_month,
    'voice_seconds', coalesce((select sum(coalesce(audio_ms, 0) + coalesce(audio_fixed_ms, 0)) / 1000
                                 from public.ai_usage where farm_id = p_farm and user_id = auth.uid()
                                  and month = v_month and feature = 'voice'), 0),
    'ai_requests', (select count(*) from public.ai_usage where farm_id = p_farm and user_id = auth.uid()
                      and month = v_month and feature <> 'voice' and outcome in ('ok', 'fallback'))
  );
end $$;

-- == What Rapid Rise reads ===========================================================

-- /admin/ai: a month's provider cost against what farms were billed, by farm. Summed here,
-- not in the page, so a month of more rows than the API returns at once is still whole.
-- Provider cost counts every credential per farm (a farm's own key costs that farm, not
-- us); the platform total counts the platform and Rapid Rise support only.
create or replace function public.ai_admin_month(p_month date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin() then
    raise exception 'Platform admins only.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'month', p_month,
    'platform_cost_usd', coalesce((select sum(provider_cost_usd) from public.ai_usage
                                    where month = p_month and credential in ('platform', 'internal')), 0),
    'billed_cents', coalesce((select sum(billed_cents) from public.ai_usage where month = p_month), 0),
    'farms', coalesce((
      select jsonb_agg(jsonb_build_object(
               'farm_id', x.farm_id, 'name', f.name, 'cost_usd', x.cost_usd, 'billed_cents', x.billed,
               'calls', x.calls, 'failed', x.failed) order by x.billed desc, x.cost_usd desc)
        from (select farm_id, sum(provider_cost_usd) as cost_usd, sum(billed_cents) as billed, count(*) as calls,
                     count(*) filter (where outcome not in ('ok', 'fallback')) as failed
                from public.ai_usage where month = p_month group by farm_id) x
        join public.farms f on f.id = x.farm_id), '[]'::jsonb)
  );
end $$;

-- The nightly health check: per model since p_since, how many AI calls on the platform's
-- credential failed (one farm's broken key is that farm's problem, not an outage), and how
-- many rows of any kind were clamped to their hold (a hold that is not an upper bound
-- bills less than the call cost).
create or replace function app.ai_ops_window(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'model', model, 'ai_calls', ai_calls, 'ai_failed', ai_failed, 'no_credit', no_credit,
           'rows', total, 'clamped', clamped)), '[]'::jsonb)
    from (select model,
                 count(*) filter (where credential = 'platform' and feature <> 'voice') as ai_calls,
                 -- An answer the model gave but that could not be used is the request's
                 -- difficulty, not the provider failing.
                 count(*) filter (where credential = 'platform' and feature <> 'voice'
                                    and outcome in ('failed', 'timeout', 'rate_limited', 'no_credit')
                                    and coalesce(error_code, '') <> 'invalid_output') as ai_failed,
                 count(*) filter (where credential = 'platform' and outcome = 'no_credit') as no_credit,
                 count(*) filter (where credential = 'platform') as total,
                 count(*) filter (where credential = 'platform' and clamped) as clamped
            from public.ai_usage where occurred_at >= p_since group by model) m
$$;

-- The nightly check on voice the server cannot see: per person since p_since, how many
-- Azure tokens they took and how much use they reported across all their sessions. A
-- token works on the whole Speech resource whatever is reported, so many tokens with
-- almost nothing reported is the pattern of a client that takes tokens and does not meter
-- (the caller decides the threshold and opens a health event for a person to look at).
create or replace function app.ai_voice_token_window(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'farm_id', t.farm_id, 'user_id', t.user_id, 'tokens', t.tokens,
           'reported_ms', coalesce(u.reported_ms, 0), 'reported_characters', coalesce(u.reported_characters, 0))), '[]'::jsonb)
    from (select farm_id, user_id, count(*) as tokens
            from public.ai_voice_sessions
           where source = 'token' and opened_at >= p_since
           group by farm_id, user_id) t
    left join (select farm_id, user_id, sum(audio_ms + audio_fixed_ms) as reported_ms, sum(characters) as reported_characters
                 from public.ai_voice_sessions
                where opened_at >= p_since
                group by farm_id, user_id) u
      on u.farm_id = t.farm_id and u.user_id = t.user_id
$$;

-- == What the owner may change ======================================================

create or replace function public.ai_set_farm_limit(p_farm uuid, p_limit_cents bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_max bigint;
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can change the AI limit.' using errcode = '42501';
  end if;
  v_max := app.ai_max_owner_limit(p_farm);
  -- Until the farm has paid, the trial limit caps whatever is set, for a Rapid Rise admin
  -- too (ai_effective_limit applies it), so a higher value is refused rather than saved
  -- and silently ignored.
  if p_limit_cents is not null and not app.ai_farm_has_paid(p_farm) and p_limit_cents > v_max then
    return jsonb_build_object('ok', false, 'reason', 'trial_limit', 'max_limit_cents', v_max);
  end if;
  if p_limit_cents is not null and (p_limit_cents < 0 or (p_limit_cents > v_max and not app.is_rr_admin())) then
    return jsonb_build_object('ok', false, 'reason', 'limit_out_of_range', 'max_limit_cents', v_max);
  end if;
  insert into public.farm_ai_settings (farm_id, monthly_limit_cents, updated_by, updated_at)
  values (p_farm, p_limit_cents, auth.uid(), now())
  on conflict (farm_id) do update
    set monthly_limit_cents = excluded.monthly_limit_cents, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'limit_cents', app.ai_effective_limit(p_farm));
end $$;

create or replace function public.ai_set_member_limit(p_farm uuid, p_user uuid, p_limit_cents bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can change AI limits.' using errcode = '42501';
  end if;
  -- Rapid Rise staff are not members for this purpose: their support use is internal.
  if app.ai_member_role(p_user, p_farm) is null or app.ai_member_role(p_user, p_farm) = 'rr_admin' then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  if p_limit_cents is null then
    delete from public.farm_member_ai_limits where farm_id = p_farm and user_id = p_user;
  elsif p_limit_cents < 0 or (p_limit_cents > app.ai_max_owner_limit(p_farm) and not app.is_rr_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'limit_out_of_range', 'max_limit_cents', app.ai_max_owner_limit(p_farm));
  else
    insert into public.farm_member_ai_limits (farm_id, user_id, monthly_limit_cents, updated_by, updated_at)
    values (p_farm, p_user, p_limit_cents, auth.uid(), now())
    on conflict (farm_id, user_id) do update
      set monthly_limit_cents = excluded.monthly_limit_cents, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.ai_set_farm_switches(
  p_farm uuid, p_ai_enabled boolean, p_voice_enabled boolean, p_own_key_fallback text
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can change AI settings.' using errcode = '42501';
  end if;
  if p_own_key_fallback is not null and p_own_key_fallback not in ('pause', 'platform') then
    return jsonb_build_object('ok', false, 'reason', 'bad_fallback');
  end if;
  insert into public.farm_ai_settings (farm_id) values (p_farm) on conflict (farm_id) do nothing;
  update public.farm_ai_settings
     set ai_enabled = coalesce(p_ai_enabled, ai_enabled),
         voice_enabled = coalesce(p_voice_enabled, voice_enabled),
         own_key_fallback = coalesce(p_own_key_fallback, own_key_fallback),
         updated_by = auth.uid(), updated_at = now()
   where farm_id = p_farm;
  return jsonb_build_object('ok', true);
end $$;

-- == The service-role surface =======================================================

create or replace function public.ai_reserve(
  p_farm uuid, p_user uuid, p_feature text, p_model text, p_units jsonb, p_credential text default 'platform'
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app.ai_reserve(p_farm, p_user, p_feature, p_model, p_units, p_credential)
$$;
create or replace function public.ai_settle(p_reservation uuid, p_attempts jsonb) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select app.ai_settle(p_reservation, p_attempts)
$$;
create or replace function public.ai_open_voice_session(
  p_farm uuid, p_user uuid, p_max_audio_ms integer, p_max_characters integer, p_client_version text,
  p_source text default 'meter'
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app.ai_open_voice_session(p_farm, p_user, p_max_audio_ms, p_max_characters, p_client_version, p_source)
$$;
create or replace function public.ai_report_voice_session(
  p_session uuid, p_user uuid, p_audio_ms integer, p_audio_fixed_ms integer, p_characters integer, p_final boolean
) returns jsonb language sql security definer set search_path = public, pg_temp as $$
  select app.ai_report_voice_session(p_session, p_user, p_audio_ms, p_audio_fixed_ms, p_characters, p_final)
$$;
create or replace function public.ai_settle_stale() returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select app.ai_settle_stale()
$$;
create or replace function public.ai_notify_owners(p_farm uuid, p_template text, p_payload jsonb) returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.ai_notify_owners(p_farm, p_template, p_payload)
$$;
create or replace function public.ai_ops_window(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select app.ai_ops_window(p_since)
$$;
create or replace function public.ai_voice_token_window(p_since timestamptz) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select app.ai_voice_token_window(p_since)
$$;

-- Nothing here is callable by anyone but what is granted below. Supabase grants EXECUTE
-- on new functions to PUBLIC by default, which would let any signed-in user spend.
revoke execute on function
  app.ai_usage_guard(), app.ai_month(timestamptz), app.ai_fx(timestamptz),
  app.ai_price_units(text, jsonb, timestamptz), app.ai_billed_cents(numeric, numeric, integer),
  app.ai_member_role(uuid, uuid), app.ai_max_owner_limit(uuid),
  app.ai_farm_has_paid(uuid), app.ai_effective_limit(uuid), app.ai_month_spend(uuid, date, uuid),
  app.ai_notify_owners(uuid, text, jsonb),
  app.ai_reserve(uuid, uuid, text, text, jsonb, text), app.ai_settle(uuid, jsonb),
  app.ai_open_voice_session(uuid, uuid, integer, integer, text, text),
  app.ai_report_voice_session(uuid, uuid, integer, integer, integer, boolean),
  app.ai_settle_stale(interval), app.ai_ops_window(timestamptz), app.ai_voice_token_window(timestamptz),
  public.ai_reserve(uuid, uuid, text, text, jsonb, text), public.ai_settle(uuid, jsonb),
  public.ai_open_voice_session(uuid, uuid, integer, integer, text, text),
  public.ai_report_voice_session(uuid, uuid, integer, integer, integer, boolean),
  public.ai_settle_stale(), public.ai_notify_owners(uuid, text, jsonb), public.ai_ops_window(timestamptz), public.ai_voice_token_window(timestamptz),
  public.ai_farm_usage(uuid), public.ai_my_usage(uuid), public.ai_admin_month(date),
  public.ai_set_farm_limit(uuid, bigint), public.ai_set_member_limit(uuid, uuid, bigint),
  public.ai_set_farm_switches(uuid, boolean, boolean, text)
  from public, anon, authenticated;

-- The engine is reached through its public wrappers only; the service role does not call
-- app.* directly (the billing suite's lockdown sweep asserts this of every function that
-- touches a billing table).
revoke execute on function
  app.ai_fx(timestamptz), app.ai_farm_has_paid(uuid), app.ai_effective_limit(uuid),
  app.ai_max_owner_limit(uuid), app.ai_member_role(uuid, uuid), app.ai_month_spend(uuid, date, uuid),
  app.ai_price_units(text, jsonb, timestamptz), app.ai_billed_cents(numeric, numeric, integer),
  app.ai_notify_owners(uuid, text, jsonb),
  app.ai_reserve(uuid, uuid, text, text, jsonb, text), app.ai_settle(uuid, jsonb),
  app.ai_open_voice_session(uuid, uuid, integer, integer, text, text),
  app.ai_report_voice_session(uuid, uuid, integer, integer, integer, boolean),
  app.ai_settle_stale(interval), app.ai_ops_window(timestamptz), app.ai_voice_token_window(timestamptz)
  from service_role;

grant execute on function
  public.ai_reserve(uuid, uuid, text, text, jsonb, text), public.ai_settle(uuid, jsonb),
  public.ai_open_voice_session(uuid, uuid, integer, integer, text, text),
  public.ai_report_voice_session(uuid, uuid, integer, integer, integer, boolean),
  public.ai_settle_stale(), public.ai_notify_owners(uuid, text, jsonb), public.ai_ops_window(timestamptz), public.ai_voice_token_window(timestamptz)
  to service_role;

-- Read and owner-change functions check the caller themselves (is_farm_billing_admin,
-- membership for ai_my_usage, platform admin for ai_admin_month), so a signed-in user may
-- call them.
grant execute on function
  public.ai_farm_usage(uuid), public.ai_my_usage(uuid), public.ai_admin_month(date),
  public.ai_set_farm_limit(uuid, bigint), public.ai_set_member_limit(uuid, uuid, bigint),
  public.ai_set_farm_switches(uuid, boolean, boolean, text)
  to authenticated, service_role;
