-- 20261114090300_equipment_pricing_capacity.sql
-- Support equipment on the bill, explicit annual prices, and capacity that cannot be
-- oversold (BRIEF section 4 and 5; decision register of 12 November 2026, decisions 2, 6,
-- 7, 22, 25, 27 and 39).
--
-- == The contract: a new price generation, launch-2026-11-eq ======================
-- Per full space: R49 / R79 / R99 a month, R490 / R790 / R990 a year. Included equipment
-- once per customer subscription: 2 / 5 / 15. Extra equipment: R15 a month or R150 a year.
-- Minimum five full spaces. The prices are EXPLICIT per billing period on the row
-- (period_price_incl_cents, equipment_period_incl_cents), not derived from a monthly
-- figure: an annual invoice is twelve months at the annual price. The older columns
-- (per_vehicle_monthly_incl_cents x months_charged) stay filled for the screens and quote
-- functions that still read them, and a check keeps them equal to the explicit price, so
-- no path can price a space differently from the invoice.
--
-- Existing agreements keep theirs. Every live subscription without a pin or an invoice is
-- pinned to what it would pay today BEFORE launch-2026-11 is retired, exactly as
-- 20261104200000 did; a subscription on an older generation has no equipment terms, so it
-- cannot take support equipment until it moves to this one by an agreed change (task A2).
-- Issued invoices are never touched.
--
-- Rapid Rise is not VAT-registered (billing_settings.vat_registered false, checked): the
-- rows carry 0% and the VAT guard still forces every invoice to 0%.
--
-- == The renewal ===================================================================
--   F = purchased full spaces, at least the minimum (asset_quota, or counted when metered)
--   E = support equipment in use at renewal (retired, sold and deleted are not)
--   A = the plan's included equipment
--   renewal = F x space price + max(0, E - A) x equipment price
-- app.billing_renewal_cents is that sum, used by the invoice run, the renewal notice and
-- the previews; src/lib/billing/calculator.ts mirrors it and both are tested on the same
-- fixtures. Equipment is a quantity: no item is ever labelled free or paid.
--
-- == Capacity ======================================================================
-- One customer subscription pools capacity across the sites billed through its main site
-- (farms.billed_through, 20261107150000); a shared email or a person in two businesses
-- never groups anything. Full capacity is the purchased asset_quota; equipment capacity is
-- the included allowance plus equipment_extra_quota, the extra spaces paid for this period.
-- Every add path (a screen, an import, a restore, a conversion, a site move) goes through
-- the machines trigger, which LOCKS the subscription row before it counts, so two
-- simultaneous adds, imports or restores cannot both take the last space.
--
-- Retiring equipment frees its space at once and stops its charge at the next renewal,
-- when equipment_extra_quota is reset to what is then in use. Restoring needs a free space
-- now; archive and restore cannot dodge a charge (restoring needs capacity that is paid
-- for) or charge twice (a space paid for this period is still there). No new ordinary work
-- is recorded on retired or sold equipment.
--
-- == What task A2 fills in =============================================================
-- Buying extra capacity mid-period (pro rata to the renewal date) is A2's. The preview here
-- returns charge_now.status = 'quote_pending' when a change needs paid capacity, and the
-- change itself is refused until that capacity exists.
--
-- Safe on live data: new columns are nullable or default to values that change nothing
-- (equipment_extra_quota 0, equipment_* on old price rows null); every existing machine is
-- full (20261114090100) so every count, quota and invoice is what it was; the new price
-- generation reaches only subscriptions that have no price yet.

-- == The contract ======================================================================
alter table public.billing_price_versions add column if not exists period_price_incl_cents bigint;
alter table public.billing_price_versions add column if not exists equipment_included integer not null default 0;
alter table public.billing_price_versions add column if not exists equipment_period_incl_cents bigint;
alter table public.billing_price_versions drop constraint if exists billing_price_versions_equipment_ck;
alter table public.billing_price_versions add constraint billing_price_versions_equipment_ck check (
  equipment_included between 0 and 10000
  and (equipment_period_incl_cents is null or equipment_period_incl_cents >= 0)
  and (period_price_incl_cents is null or period_price_incl_cents >= 0)
  -- The explicit price is the authority; the older columns may not say otherwise.
  and (period_price_incl_cents is null or per_vehicle_monthly_incl_cents is null
       or per_vehicle_monthly_incl_cents::bigint * months_charged = period_price_incl_cents)
  -- Equipment terms come with an explicit space price, never alone.
  and (equipment_period_incl_cents is null or period_price_incl_cents is not null));
comment on column public.billing_price_versions.period_price_incl_cents is
  'One full space for one billing period, VAT-inclusive cents (20261114090300): R490 a year '
  'is 49000 on the annual row, not 4900 x 10. Null on generations before launch-2026-11-eq.';
comment on column public.billing_price_versions.equipment_included is
  'Support equipment included once per customer subscription (2 / 5 / 15 on launch-2026-11-eq).';
comment on column public.billing_price_versions.equipment_period_incl_cents is
  'One extra support-equipment space for one billing period (1500 a month, 15000 a year). '
  'Null: this agreement has no equipment terms.';

create or replace function app.billing_freeze_price_version() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.billing_invoices where price_version_id = old.id) then
      raise exception 'BILLING: price version % is referenced by an invoice and cannot be deleted',
        old.version_label using errcode = 'check_violation';
    end if;
    return old;
  end if;
  if old.status <> 'draft'
     and (new.per_vehicle_monthly_incl_cents is distinct from old.per_vehicle_monthly_incl_cents
          or new.months_charged is distinct from old.months_charged
          or new.vat_rate_bps   is distinct from old.vat_rate_bps
          or new.plan           is distinct from old.plan
          or new.billing_period is distinct from old.billing_period
          or new.min_billed_slots is distinct from old.min_billed_slots
          -- The explicit prices and the equipment terms are the price too (20261114090300).
          or new.period_price_incl_cents     is distinct from old.period_price_incl_cents
          or new.equipment_included          is distinct from old.equipment_included
          or new.equipment_period_incl_cents is distinct from old.equipment_period_incl_cents) then
    raise exception
      'BILLING: price version % is no longer a draft; retire it and add a new version instead',
      old.version_label using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- One full space for one period, from any generation: the explicit price where there is one.
create or replace function app.billing_space_period_cents(p public.billing_price_versions)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select coalesce(p.period_price_incl_cents,
                  p.per_vehicle_monthly_incl_cents::bigint * p.months_charged);
$$;
revoke all on function app.billing_space_period_cents(public.billing_price_versions) from public, anon, authenticated;

-- The renewal sum: F x space + max(0, E - A) x equipment. Null for a price on application.
-- Equipment on an agreement without equipment terms is not priced here (null): nothing can
-- put it there, the capacity trigger refuses it.
create or replace function app.billing_renewal_cents(p public.billing_price_versions, p_full integer, p_equipment integer)
returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p.id is null or app.billing_space_period_cents(p) is null then null
    when coalesce(p_equipment, 0) > coalesce(p.equipment_included, 0) and p.equipment_period_incl_cents is null then null
    else greatest(coalesce(p_full, 0), coalesce(p.min_billed_slots, 0))::bigint * app.billing_space_period_cents(p)
         + greatest(coalesce(p_equipment, 0) - coalesce(p.equipment_included, 0), 0)::bigint
           * coalesce(p.equipment_period_incl_cents, 0)
  end;
$$;
revoke all on function app.billing_renewal_cents(public.billing_price_versions, integer, integer) from public, anon, authenticated;

-- == Existing agreements keep their price, then the new generation ======================
do $pin$
declare
  r record;
  v public.billing_price_versions%rowtype;
begin
  for r in
    select s.id
      from public.billing_subscriptions s
      join public.farms f on f.id = s.farm_id
     where s.deleted_at is null
       and s.price_version_id is null
       and s.status <> 'cancelled'
       and s.ended_on is null
       and not f.billing_exempt
       and not exists (select 1 from public.billing_invoices i
                        where i.subscription_id = s.id and i.deleted_at is null and i.status <> 'void')
  loop
    select * into v from app.billing_price_for_subscription(r.id);
    continue when v.id is null;
    update public.billing_subscriptions
       set price_version_id = v.id, price_version_label = v.version_label, updated_at = now()
     where id = r.id;
  end loop;
end $pin$;

update public.billing_price_versions
   set status = 'retired',
       effective_to = greatest(current_date - 1, coalesce(effective_from, current_date - 1))
 where version_label = 'launch-2026-11' and status = 'active' and deleted_at is null;

insert into public.billing_price_versions (
  version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, period_price_incl_cents,
  equipment_included, equipment_period_incl_cents,
  vat_rate_bps, min_billed_slots, status, effective_from, notes
)
select v.* from (values
  ('launch-2026-11-eq', 'essential'::farm_plan,    'monthly'::billing_period, 4900,  1,   4900::bigint,  2, 1500::bigint,  0, 5, 'active', current_date,
   'Decision register 2026-11-12. R49 a full space a month, 2 equipment included, extra R15.'),
  ('launch-2026-11-eq', 'essential'::farm_plan,    'annual'::billing_period,  4900, 10,  49000::bigint, 2, 15000::bigint, 0, 5, 'active', current_date,
   'R490 a full space a year (explicit), 2 equipment included all year, extra R150 a year.'),
  ('launch-2026-11-eq', 'professional'::farm_plan, 'monthly'::billing_period, 7900,  1,   7900::bigint,  5, 1500::bigint,  0, 5, 'active', current_date,
   'Decision register 2026-11-12. R79 a full space a month, 5 equipment included, extra R15.'),
  ('launch-2026-11-eq', 'professional'::farm_plan, 'annual'::billing_period,  7900, 10,  79000::bigint, 5, 15000::bigint, 0, 5, 'active', current_date,
   'R790 a full space a year (explicit), 5 equipment included all year, extra R150 a year.'),
  ('launch-2026-11-eq', 'complete'::farm_plan,     'monthly'::billing_period, 9900,  1,   9900::bigint, 15, 1500::bigint,  0, 5, 'active', current_date,
   'Decision register 2026-11-12. R99 a full space a month, 15 equipment included, extra R15.'),
  ('launch-2026-11-eq', 'complete'::farm_plan,     'annual'::billing_period,  9900, 10,  99000::bigint, 15, 15000::bigint, 0, 5, 'active', current_date,
   'R990 a full space a year (explicit), 15 equipment included all year, extra R150 a year.')
) as v(version_label, plan, billing_period, per_vehicle_monthly_incl_cents, months_charged, period_price_incl_cents,
       equipment_included, equipment_period_incl_cents, vat_rate_bps, min_billed_slots, status, effective_from, notes)
where not exists (select 1 from public.billing_price_versions p
                   where p.version_label = 'launch-2026-11-eq' and p.plan = v.plan and p.billing_period = v.billing_period);

comment on table public.billing_price_versions is
  'Versioned price list, VAT-INCLUSIVE cents. launch-2026 (R44/R73/R89/R250) and '
  'launch-2026-11 (R49/R79/R99, minimum 5) are retired and still price the agreements pinned '
  'to them; launch-2026-11-eq (20261114090300) is current: explicit period prices, 2/5/15 '
  'included equipment, extra equipment R15 a month or R150 a year. A non-draft row is frozen.';

-- The self-service ceiling on full spaces (decision 39): more is a capacity check and a
-- quote, not a refusal of the customer. Not a technical maximum and not an equipment cap.
create or replace function app.self_service_max_full_spaces() returns integer
language sql immutable set search_path = public, pg_temp as $$ select 200 $$;
grant execute on function app.self_service_max_full_spaces() to authenticated, service_role;
