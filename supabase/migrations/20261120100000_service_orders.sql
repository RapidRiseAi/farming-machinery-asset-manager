-- 20261120100000_service_orders.sql
-- Done-For-You agreements, the optional setup and training catalogue as orders, and the work
-- and review record (BRIEF section 18; decisions 28, 29 and 30; scenario 43).
--
-- == What was wrong with the old Done-For-You path ===========================================
-- public.billing_record_dfy_quote (20261107150000) moved the subscription onto a per-vehicle
-- price THE MOMENT Rapid Rise typed it in, with no acceptance by the customer, and an annual
-- quote always charged ten months. It stays for the build that is live and for the agreements
-- already recorded through it (status 'legacy'); nothing here rewrites one of them.
--
-- == A managed-service agreement now ==========================================================
--   1. OFFER (public.dfy_offer, Rapid Rise): the quote states the work (scope), the included work
--      allowance, the review and report schedule, who at Rapid Rise owns it (a role, never a
--      personal name), what costs extra, the asset assumptions, any mandate to spend money with
--      suppliers (none means the owner approves every supplier cost), the term and the dates.
--      The price is EXPLICIT for the billing period: a price per full space, a minimum number of
--      spaces, the equipment included and a price for further equipment (never the R15 software
--      rate: human work is priced in the quote, decision 29). The recurring total at the assumed
--      quantities is worked out once with the same sum the invoice run uses
--      (app.billing_renewal_cents) and stored with the tax and currency it was priced under.
--      Floors (approved pricing, 29 October 2026): from R170 a space a month and a R2,500 customer
--      minimum a month. An annual term is quoted individually and is never discounted
--      automatically: its floor is twelve months of the monthly floor (no ten-month rule).
--   2. ACCEPT (public.dfy_accept, the owner only): the total the owner saw is passed back and must
--      match; an expired offer, a changed tax setting or a business in its grace is refused.
--   3. APPLY at the renewal on or after the effective date (public.cron_apply_service_agreements,
--      before the invoice run): the subscription is pinned to a private price row for this
--      agreement (plan done_for_you, the explicit period prices, frozen at insert) and the invoice
--      run bills it exactly as it bills every other plan; A2's quotes then price added spaces at the
--      agreement's own space price. A plan change through /billing is refused while the term runs
--      (app.dfy_guard_change_quote); Rapid Rise ends an agreement with public.dfy_end, which
--      schedules the next plan at the renewal through A2's pending change.
--
-- == The activation catalogue ==================================================================
-- Rules from the approved activation catalogue, as data on billing_service_catalogue:
--   clean_setup       R150 an asset, R750 minimum          (per_unit)
--   document_capture  R300 an asset, R1,500 minimum        (per_unit)
--   historical_work   R500 an hour, scoped                 (hourly)
--   remote_training   R500 an hour                         (hourly)
--   onsite_training   from R3,500, up to four working hours plus agreed travel (from)
--   qr_kits           R45 an asset, minimum ten, ONLY once a supplier quote is recorded and
--                     Rapid Rise marks it ready: until then it cannot be offered or accepted.
-- Clean setup and document capture are alternatives for the same work, never stacked: they share
-- the work group 'setup' and one piece of work (work_key, and the assets named) has one live
-- setup order. Nothing is mandatory: no sign-up or plan path creates an order. The older
-- per-case codes (onboarding, training, QR stickers by the sheet) are retired from new use; the
-- installation code (quoted hardware) is untouched.
--
-- An order is offered by Rapid Rise with its quantity, scope, delivery or travel terms and the
-- amount the rules give; the owner accepts it before any invoice; Rapid Rise then raises one
-- service invoice for exactly the accepted amount (never charged to the card by the nightly run,
-- 20261029110000), and records completion.
--
-- == Work and reviews ===========================================================================
-- service_work_entries records time by customer, activity and asset (Rapid Rise only; the
-- five-minute estimate is internal planning, not an entitlement) and service reviews, which the
-- owner reads.
--
-- == Safe on live data ==========================================================================
-- New tables; new nullable columns and a status that marks every existing quote 'legacy'; new
-- catalogue rows. No subscription, price, invoice or access changes; the only catalogue change to
-- an existing row is that three per-case codes stop being offered for new invoices.
set lock_timeout = '3s';

-- == The catalogue, as data =====================================================================
alter table public.billing_service_catalogue add column if not exists pricing text not null default 'quoted';
alter table public.billing_service_catalogue add column if not exists minimum_incl_cents bigint;
alter table public.billing_service_catalogue add column if not exists min_quantity integer;
alter table public.billing_service_catalogue add column if not exists work_group text;
alter table public.billing_service_catalogue add column if not exists included_en text;
alter table public.billing_service_catalogue add column if not exists included_af text;
alter table public.billing_service_catalogue add column if not exists requires_supplier_quote boolean not null default false;
alter table public.billing_service_catalogue add column if not exists ready boolean not null default true;
alter table public.billing_service_catalogue add column if not exists supplier_quote_reference text;
alter table public.billing_service_catalogue drop constraint if exists billing_service_catalogue_rules_ck;
alter table public.billing_service_catalogue add constraint billing_service_catalogue_rules_ck check (
  pricing in ('quoted', 'per_unit', 'hourly', 'from')
  and (pricing = 'quoted' or unit_price_incl_cents is not null)
  and (minimum_incl_cents is null or minimum_incl_cents >= 0)
  and (min_quantity is null or min_quantity between 1 and 10000)
  and (work_group is null or work_group ~ '^[a-z]{1,20}$')
  and (supplier_quote_reference is null or length(btrim(supplier_quote_reference)) between 1 and 200)
  -- A supplier-dependent item is ready only with the supplier's quote on record.
  and (not requires_supplier_quote or not ready or supplier_quote_reference is not null));
comment on column public.billing_service_catalogue.pricing is
  'quoted: typed per invoice (older codes); per_unit: max(minimum, quantity x unit); hourly: hours '
  'x unit; from: an agreed total of at least the unit price, plus agreed travel (20261120100000).';
comment on column public.billing_service_catalogue.ready is
  'False: not offered or accepted. A supplier-dependent item needs supplier_quote_reference first.';

insert into public.billing_service_catalogue
  (code, name_en, name_af, unit_en, unit_af, unit_price_incl_cents, pricing, minimum_incl_cents,
   min_quantity, work_group, included_en, included_af, requires_supplier_quote, ready, sort)
values
  ('clean_setup', 'Clean spreadsheet setup', 'Opstelling uit ''n skoon sigblad', 'asset', 'bate',
   15000, 'per_unit', 75000, 1, 'setup',
   'We import a clean spreadsheet you supply: asset details and the agreed starting service information.',
   'Ons voer ''n skoon sigblad in wat u verskaf: batebesonderhede en die ooreengekome begindiensinligting.',
   false, true, 50),
  ('document_capture', 'Capture from documents or photos', 'Vaslegging uit dokumente of foto''s', 'asset', 'bate',
   30000, 'per_unit', 150000, 1, 'setup',
   'We read the documents or photos you supply and capture asset details and the agreed starting service information.',
   'Ons lees die dokumente of foto''s wat u verskaf en lê batebesonderhede en die ooreengekome begindiensinligting vas.',
   false, true, 60),
  ('historical_work', 'Historical records and extra data work', 'Historiese rekords en ekstra datawerk', 'hour', 'uur',
   50000, 'hourly', null, null, null,
   'Back-capture, exceptional clean-up or extra data work, to an agreed scope and time estimate.',
   'Terugvaslegging, buitengewone skoonmaak of ekstra datawerk, volgens ''n ooreengekome omvang en tydskatting.',
   false, true, 70),
  ('remote_training', 'Remote training', 'Afstandopleiding', 'hour', 'uur',
   50000, 'hourly', null, null, null,
   'Training by video call, by the hour.',
   'Opleiding per video-oproep, per uur.',
   false, true, 80),
  ('onsite_training', 'On-site training', 'Opleiding op die perseel', 'visit', 'besoek',
   350000, 'from', null, 1, null,
   'Up to four working hours at your premises, plus the travel agreed in the order.',
   'Tot vier werksure by u perseel, plus die reis wat in die bestelling ooreengekom is.',
   false, true, 90),
  ('qr_kits', 'Weatherproof QR sticker kits', 'Weerbestande QR-plakkerstelle', 'asset', 'bate',
   4500, 'per_unit', null, 10, null,
   'One sticker per asset, minimum ten. Delivery and fitting are extra. Available once the supplier''s quote is confirmed.',
   'Een plakker per bate, minimum tien. Aflewering en aanbring kos ekstra. Beskikbaar sodra die verskaffer se kwotasie bevestig is.',
   true, false, 100)
on conflict (code) do nothing;

-- Superseded by the approved activation catalogue (29 October 2026): per-case setup, training
-- and QR sheets are no longer offered on new service invoices. Installation stays.
update public.billing_service_catalogue set active = false, updated_at = now()
 where code in ('onboarding', 'training', 'qr_stickers') and active;

-- == Managed-service agreements on done_for_you_quotes ===========================================
alter table public.done_for_you_quotes alter column accepted_on drop not null;
alter table public.done_for_you_quotes add column if not exists status text not null default 'legacy';
alter table public.done_for_you_quotes add column if not exists request_id uuid;
alter table public.done_for_you_quotes add column if not exists scope text;
alter table public.done_for_you_quotes add column if not exists work_allowance text;
alter table public.done_for_you_quotes add column if not exists review_schedule text;
alter table public.done_for_you_quotes add column if not exists staff_owner text;
alter table public.done_for_you_quotes add column if not exists extras text;
alter table public.done_for_you_quotes add column if not exists assumptions text;
alter table public.done_for_you_quotes add column if not exists supplier_mandate text;
alter table public.done_for_you_quotes add column if not exists assumed_full_assets integer;
alter table public.done_for_you_quotes add column if not exists assumed_equipment integer;
alter table public.done_for_you_quotes add column if not exists space_period_incl_cents bigint;
alter table public.done_for_you_quotes add column if not exists min_spaces integer;
alter table public.done_for_you_quotes add column if not exists equipment_included integer;
alter table public.done_for_you_quotes add column if not exists equipment_period_incl_cents bigint;
alter table public.done_for_you_quotes add column if not exists recurring_incl_cents bigint;
alter table public.done_for_you_quotes add column if not exists currency text;
alter table public.done_for_you_quotes add column if not exists vat_rate_bps integer;
alter table public.done_for_you_quotes add column if not exists tax_snapshot jsonb;
alter table public.done_for_you_quotes add column if not exists term_months integer;
alter table public.done_for_you_quotes add column if not exists effective_from date;
alter table public.done_for_you_quotes add column if not exists effective_until date;
alter table public.done_for_you_quotes add column if not exists expires_on date;
alter table public.done_for_you_quotes add column if not exists accepted_by uuid references public.users(id) on delete set null;
alter table public.done_for_you_quotes add column if not exists accepted_at timestamptz;
alter table public.done_for_you_quotes add column if not exists applied_at timestamptz;
alter table public.done_for_you_quotes add column if not exists ends_on date;
alter table public.done_for_you_quotes add column if not exists closed_at timestamptz;
alter table public.done_for_you_quotes add column if not exists close_reason text;
alter table public.done_for_you_quotes add column if not exists updated_at timestamptz not null default now();
create unique index if not exists done_for_you_quotes_request_uq on public.done_for_you_quotes (request_id) where request_id is not null;
create index if not exists done_for_you_quotes_farm_idx on public.done_for_you_quotes (farm_id, created_at desc);
-- One live offer and one agreement in force per customer at a time.
create unique index if not exists done_for_you_quotes_open_uq on public.done_for_you_quotes (farm_id) where status in ('offered', 'accepted');
create unique index if not exists done_for_you_quotes_active_uq on public.done_for_you_quotes (farm_id) where status = 'active';
alter table public.done_for_you_quotes drop constraint if exists done_for_you_quotes_terms_ck;
alter table public.done_for_you_quotes add constraint done_for_you_quotes_terms_ck check (
  status in ('legacy', 'offered', 'accepted', 'active', 'superseded', 'ended', 'cancelled', 'expired')
  and (status = 'legacy' or (
        request_id is not null
    and length(btrim(coalesce(scope, ''))) between 1 and 2000
    and length(btrim(coalesce(work_allowance, ''))) between 1 and 1000
    and length(btrim(coalesce(review_schedule, ''))) between 1 and 500
    and length(btrim(coalesce(staff_owner, ''))) between 1 and 200
    and length(btrim(coalesce(extras, ''))) between 1 and 1000
    and coalesce(length(assumptions), 0) <= 1000
    and coalesce(length(supplier_mandate), 0) <= 1000
    and assumed_full_assets between 0 and 100000 and assumed_equipment between 0 and 100000
    and space_period_incl_cents > 0 and min_spaces between 1 and 100000
    and equipment_included between 0 and 100000 and equipment_period_incl_cents > 0
    and recurring_incl_cents > 0 and currency = 'ZAR'
    and vat_rate_bps between 0 and 10000 and tax_snapshot is not null
    and term_months between 1 and 60
    and effective_from is not null and expires_on is not null
    and effective_until = (effective_from + make_interval(months => term_months) - interval '1 day')::date
    and coalesce(length(close_reason), 0) <= 300))
  and (status not in ('accepted', 'active', 'superseded', 'ended') or status = 'legacy' or accepted_at is not null));
comment on column public.done_for_you_quotes.status is
  'legacy: recorded by billing_record_dfy_quote (priced at once). offered, accepted, active (the '
  'subscription is pinned to its price row), superseded, ended, cancelled, expired (20261120100000).';
comment on column public.done_for_you_quotes.recurring_incl_cents is
  'The period total at the assumed quantities, from app.billing_renewal_cents on the agreement''s '
  'prices, as offered and accepted. VAT-inclusive cents, currency and tax as snapshotted.';
comment on column public.done_for_you_quotes.supplier_mandate is
  'Null: the owner approves every supplier cost. Text: the separate mandate the owner agreed to.';

drop policy if exists done_for_you_quotes_owner on public.done_for_you_quotes;
create policy done_for_you_quotes_owner on public.done_for_you_quotes for select to authenticated
  using (status <> 'legacy' and (select app.is_farm_billing_admin(farm_id)));

-- == Once-off orders =============================================================================
create table if not exists public.service_orders (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references public.farms(id),
  request_id            uuid not null unique,
  code                  text not null references public.billing_service_catalogue(code),
  pricing               text not null check (pricing in ('per_unit', 'hourly', 'from')),
  work_group            text,
  work_key              text check (work_key is null or length(btrim(work_key)) between 1 and 100),
  machine_ids           uuid[] not null default '{}',
  quantity              numeric(10,2) not null check (quantity > 0 and quantity <= 100000),
  unit_price_incl_cents bigint not null check (unit_price_incl_cents >= 0),
  minimum_incl_cents    bigint not null default 0 check (minimum_incl_cents >= 0),
  quoted_incl_cents     bigint check (quoted_incl_cents is null or quoted_incl_cents > 0),
  travel_incl_cents     bigint not null default 0 check (travel_incl_cents between 0 and 100000000),
  amount_incl_cents     bigint not null check (amount_incl_cents > 0 and amount_incl_cents <= 100000000),
  currency              text not null default 'ZAR' check (currency = 'ZAR'),
  vat_rate_bps          integer not null check (vat_rate_bps between 0 and 10000),
  tax_snapshot          jsonb not null,
  scope                 text not null check (length(btrim(scope)) between 1 and 2000),
  delivery              text not null check (length(btrim(delivery)) between 1 and 1000),
  assumptions           text check (assumptions is null or length(assumptions) <= 1000),
  status                text not null default 'offered'
                          check (status in ('offered', 'accepted', 'invoiced', 'completed', 'cancelled', 'expired')),
  expires_on            date not null,
  offered_by            uuid references public.users(id) on delete set null,
  offered_at            timestamptz not null default now(),
  accepted_by           uuid references public.users(id) on delete set null,
  accepted_at           timestamptz,
  invoice_id            uuid references public.billing_invoices(id),
  completed_at          timestamptz,
  closed_at             timestamptz,
  close_reason          text check (close_reason is null or length(close_reason) <= 300),
  updated_at            timestamptz not null default now(),
  constraint service_orders_setup_ck check (work_group is null or work_key is not null),
  constraint service_orders_accept_ck check (status in ('offered', 'cancelled', 'expired') or accepted_at is not null),
  constraint service_orders_invoice_ck check (status not in ('invoiced') or invoice_id is not null),
  unique (id, farm_id)
);
create index if not exists service_orders_farm_idx on public.service_orders (farm_id, offered_at desc);
create unique index if not exists service_orders_invoice_uq on public.service_orders (invoice_id) where invoice_id is not null;
-- One piece of setup work, one live order: clean import and document capture are not stacked.
create unique index if not exists service_orders_setup_uq on public.service_orders (farm_id, work_group, lower(btrim(work_key)))
  where work_group is not null and status in ('offered', 'accepted', 'invoiced', 'completed');
comment on table public.service_orders is
  'Optional setup, data and training work from the activation catalogue: offered by Rapid Rise '
  'with quantity, scope and delivery, accepted by the owner, then invoiced once (20261120100000).';

-- == Work and reviews ============================================================================
create table if not exists public.service_work_entries (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null references public.farms(id),
  request_id       uuid not null unique,
  dfy_quote_id     uuid references public.done_for_you_quotes(id),
  service_order_id uuid,
  kind             text not null check (kind in ('work', 'review')),
  activity         text check (activity is null or activity in ('maintenance_planning', 'workshop_follow_up',
                     'cost_monitoring', 'records', 'reporting', 'setup', 'training', 'other')),
  machine_id       uuid references public.machines(id),
  minutes          integer not null default 0 check (minutes between 0 and 1440),
  worked_on        date not null,
  note             text not null check (length(btrim(note)) between 1 and 4000),
  outcome          text check (outcome is null or length(outcome) <= 4000),
  next_review_on   date,
  recorded_by      uuid references public.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  foreign key (service_order_id, farm_id) references public.service_orders (id, farm_id),
  constraint service_work_entries_target_ck check ((dfy_quote_id is null) <> (service_order_id is null)),
  constraint service_work_entries_kind_ck check (
    (kind = 'work' and activity is not null and minutes > 0)
    or (kind = 'review' and minutes = 0 and outcome is not null))
);
create index if not exists service_work_entries_farm_idx on public.service_work_entries (farm_id, worked_on desc, created_at desc);
comment on table public.service_work_entries is
  'Time Rapid Rise spent per customer, activity and asset (Rapid Rise only) and service reviews '
  '(the owner reads these) (20261120100000).';

do $$
declare t text;
begin
  foreach t in array array['service_orders', 'service_work_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.app_audit()', t || '_audit', t);
  end loop;
end $$;
drop policy if exists service_orders_sel on public.service_orders;
create policy service_orders_sel on public.service_orders for select to authenticated
  using ((select app.is_farm_billing_admin(farm_id)));
drop policy if exists service_work_entries_sel on public.service_work_entries;
create policy service_work_entries_sel on public.service_work_entries for select to authenticated
  using ((select app.is_rr_admin()) or (kind = 'review' and (select app.is_farm_billing_admin(farm_id))));
insert into app.audit_table_rules (table_name, scope, reason) values
  ('service_orders', 'rapid_rise', 'billing: optional services the owner accepted'),
  ('service_work_entries', 'rapid_rise', 'Rapid Rise''s own work record and the reviews it shares')
on conflict (table_name) do nothing;
insert into app.pay_gate_rules (table_name, rule, reason) values
  ('service_orders', 'open', 'paying: an accepted order and its invoice, read by the owner while stopped'),
  ('service_work_entries', 'open', 'what Rapid Rise did for the account, like support visits')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;
select app.pay_gate_apply('service_orders');
select app.pay_gate_apply('service_work_entries');

-- == Who is acting ===============================================================================
-- Rapid Rise staff (never a test account, 20261014120000) and the customer's owner (home site or
-- an owner membership of the billing site). The server action checks first; these check again.
create or replace function app.service_rr_actor(p_by uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_by is not null and exists (
    select 1 from public.users u
     where u.id = p_by and u.role = 'rr_admin' and u.active and u.deleted_at is null and not u.is_test);
$$;
revoke all on function app.service_rr_actor(uuid) from public, anon, authenticated, service_role;

create or replace function app.service_owner_actor(p_farm uuid, p_by uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_by is not null and exists (
    select 1 from public.users u
     where u.id = p_by and u.active and u.deleted_at is null
       and ((u.role = 'owner' and u.farm_id = p_farm)
            or exists (select 1 from public.user_farm_memberships m
                        where m.user_id = u.id and m.farm_id = p_farm and m.role = 'owner'
                          and m.active and m.deleted_at is null)));
$$;
revoke all on function app.service_owner_actor(uuid, uuid) from public, anon, authenticated, service_role;

-- The tax a price is snapshotted under: the seller's VAT status today (not registered today, so 0%).
create or replace function app.service_tax_snapshot() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'vat_rate_bps', case when coalesce(s.vat_registered, false) then coalesce(s.vat_rate_bps, 0) else 0 end,
    'vat_registered', coalesce(s.vat_registered, false),
    'vat_number', s.vat_number,
    'legal_name', s.legal_name,
    'currency', 'ZAR')
    from public.billing_settings s where s.singleton;
$$;
revoke all on function app.service_tax_snapshot() from public, anon, authenticated, service_role;

-- == The catalogue's arithmetic ==================================================================
-- src/lib/service-orders.ts mirrors this (servicePrice) and its test reads this file.
create or replace function app.service_order_price(p_code text, p_quantity numeric, p_quoted bigint, p_travel bigint)
returns bigint
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  c public.billing_service_catalogue%rowtype;
  v_travel bigint := coalesce(p_travel, 0);
begin
  select * into c from public.billing_service_catalogue where code = p_code;
  if not found or not c.active or c.pricing = 'quoted' then
    raise exception 'service-not-orderable' using errcode = '22023';
  end if;
  if not c.ready or (c.requires_supplier_quote and c.supplier_quote_reference is null) then
    raise exception 'service-not-ready' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 100000 or p_quantity <> round(p_quantity, 2)
     or v_travel < 0 or v_travel > 100000000 then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  if c.pricing <> 'from' and v_travel <> 0 then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  if c.pricing = 'per_unit' then
    if p_quantity <> trunc(p_quantity) or p_quantity < coalesce(c.min_quantity, 1) then
      raise exception 'service-below-minimum' using errcode = '22023';
    end if;
    return greatest(coalesce(c.minimum_incl_cents, 0), (p_quantity * c.unit_price_incl_cents)::bigint);
  elsif c.pricing = 'hourly' then
    -- Quarter hours.
    if p_quantity * 4 <> trunc(p_quantity * 4) then
      raise exception 'service-invalid' using errcode = '22023';
    end if;
    return round(p_quantity * c.unit_price_incl_cents)::bigint;
  else
    -- 'from': one visit at an agreed total of at least the unit price, plus agreed travel.
    if p_quantity <> 1 or p_quoted is null or p_quoted < c.unit_price_incl_cents or p_quoted > 100000000 then
      raise exception 'service-below-minimum' using errcode = '22023';
    end if;
    return p_quoted + v_travel;
  end if;
end $$;
revoke all on function app.service_order_price(text, numeric, bigint, bigint) from public, anon, authenticated, service_role;

-- == Done-For-You floors =========================================================================
-- From R170 a space a month, a R2,500 customer minimum a month; annual: twelve times each, since
-- annual managed terms are quoted individually and never discounted automatically.
create or replace function app.dfy_space_floor_cents(p_period public.billing_period) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case when p_period = 'annual' then 12 * 17000 else 17000 end::bigint;
$$;
create or replace function app.dfy_minimum_floor_cents(p_period public.billing_period) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case when p_period = 'annual' then 12 * 250000 else 250000 end::bigint;
$$;
revoke all on function app.dfy_space_floor_cents(public.billing_period) from public, anon, authenticated, service_role;
revoke all on function app.dfy_minimum_floor_cents(public.billing_period) from public, anon, authenticated, service_role;

-- The period total at given quantities: the A1 renewal sum (F x space + extra equipment x price).
create or replace function app.dfy_period_total(p_space bigint, p_min integer, p_eq_included integer, p_eq_price bigint,
                                                p_full integer, p_equipment integer)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select greatest(coalesce(p_full, 0), coalesce(p_min, 0))::bigint * p_space
       + greatest(coalesce(p_equipment, 0) - coalesce(p_eq_included, 0), 0)::bigint * p_eq_price;
$$;
revoke all on function app.dfy_period_total(bigint, integer, integer, bigint, integer, integer) from public, anon, authenticated, service_role;

-- == Offer an agreement ==========================================================================
create or replace function public.dfy_offer(
  p_by uuid, p_farm uuid, p_request uuid, p_reference text, p_period public.billing_period,
  p_space_cents bigint, p_min_spaces integer, p_equipment_included integer, p_equipment_cents bigint,
  p_assumed_full integer, p_assumed_equipment integer,
  p_scope text, p_work_allowance text, p_review_schedule text, p_staff_owner text, p_extras text,
  p_assumptions text, p_supplier_mandate text, p_term_months integer, p_effective_from date, p_expires_on date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.done_for_you_quotes%rowtype;
  v_tax jsonb;
  v_total bigint;
  v_today date := app.billing_today();
  v_id uuid;
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_request is null then raise exception 'service-invalid' using errcode = '22023'; end if;
  select * into q from public.done_for_you_quotes where request_id = p_request;
  if found then
    if q.farm_id <> p_farm then raise exception 'service-changed' using errcode = '22023'; end if;
    return q.id;
  end if;
  if not exists (select 1 from public.farms f where f.id = p_farm and f.deleted_at is null) then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  -- The customer is the billing site; a site billed through another has no bill of its own.
  if app.billing_root(p_farm) <> p_farm then raise exception 'service-billing-site' using errcode = '22023'; end if;
  if app.billing_subscription_for(p_farm) is null then raise exception 'service-no-subscription' using errcode = '22023'; end if;
  if p_period is null or p_space_cents is null or p_min_spaces is null or p_equipment_included is null
     or p_equipment_cents is null or p_assumed_full is null or p_assumed_equipment is null
     or p_term_months is null or p_effective_from is null or p_expires_on is null
     or p_min_spaces < 1 or p_assumed_full < 0 or p_assumed_equipment < 0 or p_equipment_included < 0
     or p_term_months not between 1 and 60
     or p_effective_from < v_today or p_expires_on < v_today or p_expires_on > v_today + 60 then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  -- The approved floors, for full spaces and for equipment alike (human work is priced per asset).
  if p_space_cents < app.dfy_space_floor_cents(p_period) or p_equipment_cents < app.dfy_space_floor_cents(p_period)
     or p_min_spaces::bigint * p_space_cents < app.dfy_minimum_floor_cents(p_period)
     or p_space_cents > 100000000 or p_equipment_cents > 100000000 then
    raise exception 'service-below-minimum' using errcode = '22023';
  end if;
  v_total := app.dfy_period_total(p_space_cents, p_min_spaces, p_equipment_included, p_equipment_cents,
                                  p_assumed_full, p_assumed_equipment);
  v_tax := app.service_tax_snapshot();

  perform pg_advisory_xact_lock(hashtextextended('dfy:' || p_farm::text, 0));
  -- A new offer replaces one not yet in force.
  update public.done_for_you_quotes
     set status = 'cancelled', closed_at = now(), close_reason = 'replaced by a new offer', updated_at = now()
   where farm_id = p_farm and status in ('offered', 'accepted');

  insert into public.done_for_you_quotes (
    farm_id, reference, per_vehicle_incl_cents, min_vehicles, billing_period, accepted_on, notes, recorded_by,
    status, request_id, scope, work_allowance, review_schedule, staff_owner, extras, assumptions, supplier_mandate,
    assumed_full_assets, assumed_equipment, space_period_incl_cents, min_spaces, equipment_included,
    equipment_period_incl_cents, recurring_incl_cents, currency, vat_rate_bps, tax_snapshot,
    term_months, effective_from, effective_until, expires_on)
  values (
    p_farm, left(btrim(coalesce(p_reference, '')), 100), least(p_space_cents, 2147483647)::integer,
    least(p_min_spaces, 1000), p_period, null, null, p_by,
    'offered', p_request, btrim(p_scope), btrim(p_work_allowance), btrim(p_review_schedule), btrim(p_staff_owner),
    btrim(p_extras), nullif(btrim(coalesce(p_assumptions, '')), ''), nullif(btrim(coalesce(p_supplier_mandate, '')), ''),
    p_assumed_full, p_assumed_equipment, p_space_cents, p_min_spaces, p_equipment_included,
    p_equipment_cents, v_total, 'ZAR', (v_tax ->> 'vat_rate_bps')::integer, v_tax,
    p_term_months, p_effective_from,
    (p_effective_from + make_interval(months => p_term_months) - interval '1 day')::date, p_expires_on)
  returning id into v_id;
  return v_id;
end $$;

-- == The owner accepts ===========================================================================
create or replace function public.dfy_accept(p_by uuid, p_quote uuid, p_recurring bigint)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.done_for_you_quotes%rowtype;
  v_today date := app.billing_today();
begin
  select * into q from public.done_for_you_quotes where id = p_quote for update;
  if not found or q.status = 'legacy' or not app.service_owner_actor(q.farm_id, p_by) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if q.status in ('accepted', 'active') and q.accepted_by = p_by then return q.id; end if;
  if q.status <> 'offered' then raise exception 'service-not-open' using errcode = '22023'; end if;
  if q.expires_on < v_today then raise exception 'service-expired' using errcode = '22023'; end if;
  if p_recurring is distinct from q.recurring_incl_cents
     or (app.service_tax_snapshot() ->> 'vat_rate_bps')::integer is distinct from q.vat_rate_bps then
    raise exception 'service-changed' using errcode = '22023';
  end if;
  -- A business that is stopped or in its grace takes on no new paid work (decision 41).
  if not app.farm_paid_extras_allowed(q.farm_id, v_today) then
    raise exception 'billing-grace-no-extras' using errcode = '22023';
  end if;
  update public.done_for_you_quotes
     set status = 'accepted', accepted_by = p_by, accepted_at = now(), accepted_on = v_today, updated_at = now()
   where id = q.id;
  return q.id;
end $$;

-- == Rapid Rise withdraws an offer not yet in force ==============================================
create or replace function public.dfy_cancel(p_by uuid, p_quote uuid, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.done_for_you_quotes
     set status = 'cancelled', closed_at = now(), close_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300),
         updated_at = now()
   where id = p_quote and status in ('offered', 'accepted');
  if not found then raise exception 'service-not-open' using errcode = '22023'; end if;
end $$;

-- == Rapid Rise ends an agreement at the next renewal ============================================
-- Through A2's pending change: the plan named lands at the renewal on the current price list, and
-- the nightly apply marks the agreement ended once the subscription has left done_for_you.
create or replace function public.dfy_end(p_by uuid, p_quote uuid, p_next_plan public.farm_plan, p_reason text)
returns date
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.done_for_you_quotes%rowtype;
  s public.billing_subscriptions%rowtype;
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_next_plan is null or p_next_plan = 'done_for_you' then raise exception 'service-invalid' using errcode = '22023'; end if;
  select * into q from public.done_for_you_quotes where id = p_quote for update;
  if not found or q.status <> 'active' then raise exception 'service-not-open' using errcode = '22023'; end if;
  select * into s from public.billing_subscriptions where id = app.billing_subscription_for(q.farm_id) for update;
  if not found or s.next_billing_on is null then raise exception 'service-no-subscription' using errcode = '22023'; end if;
  update public.billing_subscriptions
     set pending_plan = p_next_plan, pending_billing_period = s.billing_period,
         pending_plan_on = s.next_billing_on, pending_plan_set_at = now(), updated_at = now()
   where id = s.id;
  update public.done_for_you_quotes
     set ends_on = s.next_billing_on, close_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300), updated_at = now()
   where id = q.id;
  return s.next_billing_on;
end $$;

-- == While the term runs, no plan change through /billing =========================================
create or replace function app.dfy_guard_change_quote() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.change = 'plan' and exists (
       select 1 from public.done_for_you_quotes q
        where q.farm_id = new.farm_id and q.status = 'active' and q.ends_on is null
          and q.effective_until >= app.billing_today()) then
    raise exception 'service-agreement-term'
      using errcode = '22023', hint = 'A managed-service agreement is in force; Rapid Rise changes or ends it.';
  end if;
  return new;
end $$;
revoke all on function app.dfy_guard_change_quote() from public, anon, authenticated, service_role;
drop trigger if exists billing_change_quotes_dfy_guard on public.billing_change_quotes;
create trigger billing_change_quotes_dfy_guard before insert on public.billing_change_quotes
  for each row execute function app.dfy_guard_change_quote();

-- == The nightly apply, before the invoice run ===================================================
-- An accepted agreement lands at the first renewal on or after its effective date: the private
-- price row is written from the accepted terms (frozen at insert: status retired, so no edit can
-- reach it) and the subscription is pinned to it. Repeat-safe: a landed agreement is 'active'.
create or replace function app.dfy_apply_due() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  q public.done_for_you_quotes%rowtype;
  s public.billing_subscriptions%rowtype;
  v_price uuid;
  v_done integer := 0;
begin
  for q in
    select * from public.done_for_you_quotes
     where status = 'accepted'
     order by accepted_at
     for update skip locked
  loop
    select * into s from public.billing_subscriptions where id = app.billing_subscription_for(q.farm_id) for update;
    continue when not found;
    -- The renewal being raised tonight (next_billing_on <= today, the invoice run's own test) is
    -- on or after the effective date; a pending first invoice lands it too.
    continue when s.status not in ('active', 'trialing', 'pending', 'past_due', 'non_renewing')
              or s.next_billing_on is null or s.next_billing_on > current_date
              or s.next_billing_on < q.effective_from;

    insert into public.billing_price_versions (
      version_label, plan, billing_period, per_vehicle_monthly_incl_cents, months_charged,
      period_price_incl_cents, equipment_included, equipment_period_incl_cents,
      vat_rate_bps, min_billed_slots, status, effective_from, notes, created_by)
    values (
      'dfy-' || q.id::text, 'done_for_you', q.billing_period, q.space_period_incl_cents, 1,
      q.space_period_incl_cents, q.equipment_included, q.equipment_period_incl_cents,
      q.vat_rate_bps, least(q.min_spaces, 1000), 'retired', q.effective_from,
      'Done-For-You agreement ' || q.reference || ' (explicit price for the period, accepted '
        || coalesce(q.accepted_on::text, '') || ')', q.accepted_by)
    returning id into v_price;

    update public.billing_subscriptions
       set plan = 'done_for_you', billing_period = q.billing_period,
           price_version_id = v_price, price_version_label = 'dfy-' || q.id::text,
           asset_quota = greatest(coalesce(asset_quota, 0), q.min_spaces, q.assumed_full_assets,
                                  app.billable_asset_count(s.farm_id)),
           pending_plan = null, pending_billing_period = null, pending_plan_on = null, pending_plan_set_at = null,
           updated_at = now()
     where id = s.id;
    update public.farms set plan = 'done_for_you' where id = s.farm_id;
    update public.farms set plan = 'done_for_you' where billed_through = s.farm_id and deleted_at is null;
    -- Self-service changes priced on the old basis no longer apply.
    update public.billing_change_quotes
       set status = 'superseded', closed_at = now(), close_reason = 'a managed-service agreement took effect',
           updated_at = now()
     where subscription_id = s.id and status in ('quoted', 'scheduled');
    update public.done_for_you_quotes
       set status = 'superseded', closed_at = now(), updated_at = now()
     where farm_id = q.farm_id and status = 'active' and id <> q.id;
    update public.done_for_you_quotes
       set status = 'active', applied_at = now(), price_version_id = v_price, updated_at = now()
     where id = q.id;
    v_done := v_done + 1;
  end loop;

  -- Ended: the subscription has left done_for_you (dfy_end's pending change landed).
  update public.done_for_you_quotes dq
     set status = 'ended', closed_at = now(), updated_at = now()
   where dq.status = 'active' and dq.ends_on is not null and dq.ends_on <= current_date
     and exists (select 1 from public.billing_subscriptions bs
                  where bs.id = app.billing_subscription_for(dq.farm_id) and bs.plan <> 'done_for_you');

  -- Offers nobody accepted in time.
  update public.done_for_you_quotes
     set status = 'expired', closed_at = now(), updated_at = now()
   where status = 'offered' and expires_on < app.billing_today();
  update public.service_orders
     set status = 'expired', closed_at = now(), updated_at = now()
   where status = 'offered' and expires_on < app.billing_today();
  return v_done;
end $$;
revoke all on function app.dfy_apply_due() from public, anon, authenticated, service_role;

create or replace function public.cron_apply_service_agreements() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.dfy_apply_due();
$$;

-- == Once-off orders =============================================================================
create or replace function public.service_order_offer(
  p_by uuid, p_farm uuid, p_request uuid, p_code text, p_quantity numeric, p_quoted bigint, p_travel bigint,
  p_scope text, p_delivery text, p_assumptions text, p_work_key text, p_machines uuid[], p_expires_on date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.service_orders%rowtype;
  c public.billing_service_catalogue%rowtype;
  v_amount bigint;
  v_tax jsonb;
  v_key text := nullif(btrim(coalesce(p_work_key, '')), '');
  v_machines uuid[] := coalesce(p_machines, '{}');
  v_today date := app.billing_today();
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_request is null then raise exception 'service-invalid' using errcode = '22023'; end if;
  select * into o from public.service_orders where request_id = p_request;
  if found then
    if o.farm_id <> p_farm or o.code <> p_code or o.quantity <> p_quantity then
      raise exception 'service-changed' using errcode = '22023';
    end if;
    return o.id;
  end if;
  if not exists (select 1 from public.farms f where f.id = p_farm and f.deleted_at is null) then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  if p_expires_on is null or p_expires_on < v_today or p_expires_on > v_today + 60
     or length(btrim(coalesce(p_scope, ''))) not between 1 and 2000
     or length(btrim(coalesce(p_delivery, ''))) not between 1 and 1000
     or cardinality(v_machines) > 10000
     or exists (select 1 from unnest(v_machines) m(id)
                 where not exists (select 1 from public.machines x where x.id = m.id and x.farm_id = p_farm)) then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  v_amount := app.service_order_price(p_code, p_quantity, p_quoted, p_travel);
  select * into c from public.billing_service_catalogue where code = p_code;
  if c.work_group is not null then
    if v_key is null then raise exception 'service-invalid' using errcode = '22023'; end if;
    perform pg_advisory_xact_lock(hashtextextended('service-setup:' || p_farm::text, 0));
    -- The same work, or the same assets, under the other setup service: not stacked.
    if exists (select 1 from public.service_orders x
                where x.farm_id = p_farm and x.work_group = c.work_group
                  and x.status in ('offered', 'accepted', 'invoiced', 'completed')
                  and (lower(btrim(x.work_key)) = lower(v_key) or x.machine_ids && v_machines)) then
      raise exception 'service-overlap' using errcode = '22023';
    end if;
  end if;
  v_tax := app.service_tax_snapshot();
  insert into public.service_orders (
    farm_id, request_id, code, pricing, work_group, work_key, machine_ids, quantity, unit_price_incl_cents,
    minimum_incl_cents, quoted_incl_cents, travel_incl_cents, amount_incl_cents, vat_rate_bps, tax_snapshot,
    scope, delivery, assumptions, expires_on, offered_by)
  values (
    p_farm, p_request, p_code, c.pricing, c.work_group, v_key, v_machines, p_quantity, c.unit_price_incl_cents,
    coalesce(c.minimum_incl_cents, 0), case when c.pricing = 'from' then p_quoted end, coalesce(p_travel, 0),
    v_amount, (v_tax ->> 'vat_rate_bps')::integer, v_tax,
    btrim(p_scope), btrim(p_delivery), nullif(btrim(coalesce(p_assumptions, '')), ''), p_expires_on, p_by)
  returning id into o.id;
  return o.id;
end $$;

create or replace function public.service_order_accept(p_by uuid, p_order uuid, p_amount bigint)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.service_orders%rowtype;
  c public.billing_service_catalogue%rowtype;
  v_today date := app.billing_today();
begin
  select * into o from public.service_orders where id = p_order for update;
  if not found or not app.service_owner_actor(o.farm_id, p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  if o.status in ('accepted', 'invoiced', 'completed') and o.accepted_by = p_by then return o.id; end if;
  if o.status <> 'offered' then raise exception 'service-not-open' using errcode = '22023'; end if;
  if o.expires_on < v_today then raise exception 'service-expired' using errcode = '22023'; end if;
  if p_amount is distinct from o.amount_incl_cents
     or (app.service_tax_snapshot() ->> 'vat_rate_bps')::integer is distinct from o.vat_rate_bps then
    raise exception 'service-changed' using errcode = '22023';
  end if;
  select * into c from public.billing_service_catalogue where code = o.code;
  if not c.active or not c.ready or (c.requires_supplier_quote and c.supplier_quote_reference is null) then
    raise exception 'service-not-ready' using errcode = '22023';
  end if;
  if not app.farm_paid_extras_allowed(o.farm_id, v_today) then
    raise exception 'billing-grace-no-extras' using errcode = '22023';
  end if;
  update public.service_orders
     set status = 'accepted', accepted_by = p_by, accepted_at = now(), updated_at = now()
   where id = o.id;
  return o.id;
end $$;

-- One service invoice for exactly the accepted amount, once.
create or replace function public.service_order_invoice(p_by uuid, p_order uuid, p_due date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o public.service_orders%rowtype;
  c public.billing_service_catalogue%rowtype;
  v_invoice uuid;
  v_desc text;
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into o from public.service_orders where id = p_order for update;
  if not found then raise exception 'service-invalid' using errcode = '22023'; end if;
  if o.invoice_id is not null then return o.invoice_id; end if;
  if o.status <> 'accepted' then raise exception 'service-not-accepted' using errcode = '22023'; end if;
  if (app.service_tax_snapshot() ->> 'vat_rate_bps')::integer is distinct from o.vat_rate_bps then
    raise exception 'service-changed' using errcode = '22023';
  end if;
  select * into c from public.billing_service_catalogue where code = o.code;
  v_desc := left(c.name_en || ', ' || trim(trailing '.' from trim(trailing '0' from o.quantity::text)) || ' '
            || c.unit_en || case when o.travel_incl_cents > 0 then ', travel included' else '' end, 200);
  v_invoice := app.billing_raise_service_invoice(o.farm_id,
    jsonb_build_array(jsonb_build_object('code', o.code, 'description', v_desc, 'qty', 1,
                                         'unit_price_cents', o.amount_incl_cents)),
    p_due, p_by);
  update public.service_orders set status = 'invoiced', invoice_id = v_invoice, updated_at = now() where id = o.id;
  return v_invoice;
end $$;

-- Completed (the work was done) or cancelled (not yet invoiced: an invoiced order is voided or
-- refunded through billing first).
create or replace function public.service_order_close(p_by uuid, p_order uuid, p_status text, p_reason text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status = 'completed' then
    update public.service_orders set status = 'completed', completed_at = now(), updated_at = now()
     where id = p_order and status in ('accepted', 'invoiced');
  elsif p_status = 'cancelled' then
    update public.service_orders
       set status = 'cancelled', closed_at = now(), close_reason = left(nullif(btrim(coalesce(p_reason, '')), ''), 300),
           updated_at = now()
     where id = p_order and status in ('offered', 'accepted');
  else
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  if not found then raise exception 'service-not-open' using errcode = '22023'; end if;
end $$;

-- == Work and reviews ============================================================================
create or replace function public.service_log(
  p_by uuid, p_request uuid, p_quote uuid, p_order uuid, p_kind text, p_activity text, p_machine uuid,
  p_minutes integer, p_worked_on date, p_note text, p_outcome text, p_next_review date)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.service_work_entries%rowtype;
  v_farm uuid;
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into e from public.service_work_entries where request_id = p_request;
  if found then return e.id; end if;
  if (p_quote is null) = (p_order is null) then raise exception 'service-invalid' using errcode = '22023'; end if;
  if p_quote is not null then
    select farm_id into v_farm from public.done_for_you_quotes where id = p_quote and status in ('active', 'ended', 'superseded');
  else
    select farm_id into v_farm from public.service_orders where id = p_order and status in ('accepted', 'invoiced', 'completed');
  end if;
  if v_farm is null then raise exception 'service-not-accepted' using errcode = '22023'; end if;
  if p_machine is not null and not exists (select 1 from public.machines m where m.id = p_machine and m.farm_id = v_farm) then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  if p_worked_on is null or p_worked_on > app.billing_today() or p_worked_on < app.billing_today() - 366 then
    raise exception 'service-invalid' using errcode = '22023';
  end if;
  insert into public.service_work_entries (farm_id, request_id, dfy_quote_id, service_order_id, kind, activity,
    machine_id, minutes, worked_on, note, outcome, next_review_on, recorded_by)
  values (v_farm, p_request, p_quote, p_order, p_kind, case when p_kind = 'work' then p_activity end,
    p_machine, coalesce(p_minutes, 0), p_worked_on, btrim(coalesce(p_note, '')),
    nullif(btrim(coalesce(p_outcome, '')), ''), p_next_review, p_by)
  returning id into e.id;
  return e.id;
end $$;

-- == Grants: the service role only; the actor is passed and checked inside =========================
do $$
declare f regprocedure;
begin
  foreach f in array array[
    'public.dfy_offer(uuid,uuid,uuid,text,public.billing_period,bigint,integer,integer,bigint,integer,integer,text,text,text,text,text,text,text,integer,date,date)'::regprocedure,
    'public.dfy_accept(uuid,uuid,bigint)'::regprocedure,
    'public.dfy_cancel(uuid,uuid,text)'::regprocedure,
    'public.dfy_end(uuid,uuid,public.farm_plan,text)'::regprocedure,
    'public.cron_apply_service_agreements()'::regprocedure,
    'public.service_order_offer(uuid,uuid,uuid,text,numeric,bigint,bigint,text,text,text,text,uuid[],date)'::regprocedure,
    'public.service_order_accept(uuid,uuid,bigint)'::regprocedure,
    'public.service_order_invoice(uuid,uuid,date)'::regprocedure,
    'public.service_order_close(uuid,uuid,text,text)'::regprocedure,
    'public.service_log(uuid,uuid,uuid,uuid,text,text,uuid,integer,date,text,text,date)'::regprocedure]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

comment on function public.billing_record_dfy_quote(uuid, text, integer, integer, public.billing_period, date, text, uuid) is
  'OLD PATH, kept for the live build and the agreements recorded through it: prices at once with no '
  'acceptance and charges ten months on an annual quote. New agreements use public.dfy_offer, '
  'dfy_accept and the nightly apply (20261120100000).';
reset lock_timeout;
