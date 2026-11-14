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

-- == Equipment capacity on the subscription ===========================================
alter table public.billing_subscriptions add column if not exists equipment_extra_quota integer not null default 0;
alter table public.billing_subscriptions drop constraint if exists billing_subscriptions_equipment_extra_ck;
alter table public.billing_subscriptions add constraint billing_subscriptions_equipment_extra_ck
  check (equipment_extra_quota between 0 and 100000);
comment on column public.billing_subscriptions.equipment_extra_quota is
  'Extra support-equipment spaces paid for the current period, beyond the plan''s included '
  'equipment (20261114090300). Reset at each renewal to the extra equipment then in use.';

-- == Counting, once per customer ======================================================
-- The billing site: the main site a site is billed through, or the site itself.
create or replace function app.billing_root(p_farm uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select f.billed_through from public.farms f where f.id = p_farm), p_farm);
$$;
revoke all on function app.billing_root(uuid) from public, anon, authenticated;
grant execute on function app.billing_root(uuid) to service_role;

-- Full spaces in use: this site's full assets and those of every site billed through it.
-- Support equipment is not a full space (20261114090300).
create or replace function app.billable_asset_count(p_farm uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer
    from public.machines m
   where (m.farm_id = p_farm
          or m.farm_id in (select f.id from public.farms f where f.billed_through = p_farm and f.deleted_at is null))
     and m.deleted_at is null
     and m.status not in ('retired', 'sold')
     and m.profile = 'full';
$$;

-- Support equipment in use, the same way.
create or replace function app.billable_equipment_count(p_farm uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer
    from public.machines m
   where (m.farm_id = p_farm
          or m.farm_id in (select f.id from public.farms f where f.billed_through = p_farm and f.deleted_at is null))
     and m.deleted_at is null
     and m.status not in ('retired', 'sold')
     and m.profile = 'equipment';
$$;
revoke all on function app.billable_equipment_count(uuid) from public, anon, authenticated;
grant execute on function app.billable_equipment_count(uuid) to service_role;

-- farms.asset_count stays the site's own full spaces in use, the same rule as above.
create or replace function app.recount_farm_assets(p_farm uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_farm is null then return; end if;
  update public.farms f
     set asset_count = (
       select count(*) from public.machines m
       where m.farm_id = p_farm
         and m.deleted_at is null
         and m.status not in ('retired','sold')
         and m.profile = 'full'
     )
   where f.id = p_farm;
end;
$$;

-- The subscription a business is billed under: its main site's, newest live one.
create or replace function app.billing_subscription_for(p_farm uuid) returns uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select s.id from public.billing_subscriptions s
   where s.farm_id = app.billing_root(p_farm) and s.deleted_at is null
   order by s.created_at desc
   limit 1;
$$;
revoke all on function app.billing_subscription_for(uuid) from public, anon, authenticated;
grant execute on function app.billing_subscription_for(uuid) to service_role;

-- == The capacity guard on every add path ===============================================
-- Replaces app.billing_enforce_vehicle_quota (20261107150000) under the same trigger.
-- Fires before an insert, a restore (retired or sold back into use), a site move, a
-- conversion between profiles and an undelete. The subscription row is locked first, so
-- concurrent adds wait for each other and the second one counts the first one's asset.
create or replace function app.billing_enforce_vehicle_quota()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_root   uuid;
  v_sub    public.billing_subscriptions%rowtype;
  v_price  public.billing_price_versions%rowtype;
  v_used   integer;
  v_cap    integer;
begin
  -- Only an asset that will actually be in use takes a space.
  if new.deleted_at is not null or new.status in ('retired', 'sold') then
    return new;
  end if;

  -- On an update, only a move INTO use, into another customer, or onto the other profile
  -- takes a space. Editing an asset where it stands never fails for capacity.
  if tg_op = 'UPDATE'
     and old.deleted_at is null
     and old.status not in ('retired', 'sold')
     and old.profile = new.profile
     and app.billing_root(old.farm_id) = app.billing_root(new.farm_id) then
    return new;
  end if;

  v_root := app.billing_root(new.farm_id);
  select * into v_sub from public.billing_subscriptions s
   where s.farm_id = v_root and s.deleted_at is null
   order by s.created_at desc
   limit 1
   for update;

  -- No subscription: grandfathered and admin-created businesses have no ceiling.
  if not found then
    return new;
  end if;

  if new.profile = 'full' then
    -- No quota, no ceiling: a metered subscription bills what it counts.
    if v_sub.asset_quota is null then return new; end if;
    v_used := app.billable_asset_count(v_root);
    if v_used >= v_sub.asset_quota then
      raise exception 'vehicle-limit-reached'
        using errcode = 'check_violation',
              detail = format('%s of %s full spaces are in use', v_used, v_sub.asset_quota),
              hint = 'Add more full spaces on the billing screen, or retire an asset first.';
    end if;
    return new;
  end if;

  -- Support equipment needs an agreement with equipment terms.
  select * into v_price from app.billing_price_for_subscription(v_sub.id);
  if v_price.id is null or v_price.equipment_period_incl_cents is null then
    raise exception 'equipment-not-in-agreement'
      using errcode = 'check_violation',
            hint = 'This subscription''s agreement predates support equipment.';
  end if;
  -- Metered: no ceiling; the renewal counts what is in use.
  if v_sub.asset_quota is null then return new; end if;
  v_used := app.billable_equipment_count(v_root);
  v_cap := coalesce(v_price.equipment_included, 0) + coalesce(v_sub.equipment_extra_quota, 0);
  if v_used >= v_cap then
    raise exception 'equipment-limit-reached'
      using errcode = 'check_violation',
            detail = format('%s of %s equipment spaces are in use', v_used, v_cap),
            hint = 'Add an equipment space on the billing screen, or retire equipment first.';
  end if;
  return new;
end $function$;

-- Fire on the columns that can take a space (it was every update before).
drop trigger if exists a_billing_vehicle_quota on public.machines;
create trigger a_billing_vehicle_quota
  before insert or update of status, deleted_at, farm_id, profile on public.machines
  for each row execute function app.billing_enforce_vehicle_quota();

-- The allowance a screen reads, now pooled through the main site like the trigger.
create or replace function app.farm_vehicle_allowance(p_farm uuid)
returns table (enforced boolean, quota integer, used integer, remaining integer)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    s.asset_quota is not null,
    s.asset_quota,
    app.billable_asset_count(app.billing_root(p_farm)),
    case when s.asset_quota is null then null
         else greatest(s.asset_quota - app.billable_asset_count(app.billing_root(p_farm)), 0) end
  from public.billing_subscriptions s
  where s.id = app.billing_subscription_for(p_farm)
  union all
  select false, null::integer, app.billable_asset_count(app.billing_root(p_farm)), null::integer
  where app.billing_subscription_for(p_farm) is null
  limit 1;
$$;

-- == No new ordinary work on retired or sold equipment ==================================
-- Retiring equipment stops its charge at renewal; work posted to it afterwards would be
-- active use without a space. Restore it first (which needs a free space).
create or replace function app.refuse_retired_equipment_work()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.machine_id is not null and exists (
       select 1 from public.machines m
        where m.id = new.machine_id and m.profile = 'equipment' and m.status in ('retired', 'sold')) then
    raise exception 'equipment-retired' using errcode = 'P0001',
      hint = 'Restore the equipment first; restoring needs a free equipment space.';
  end if;
  return new;
end
$$;
revoke all on function app.refuse_retired_equipment_work() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['job_cards', 'faults', 'meter_readings', 'checklist_instances', 'work_requests'] loop
    execute format('drop trigger if exists %I on public.%I', t || '_retired_equipment', t);
    execute format('create trigger %I before insert on public.%I for each row execute function app.refuse_retired_equipment_work()',
                   t || '_retired_equipment', t);
  end loop;
end $$;
-- == Equipment on the invoice ===========================================================
alter table public.billing_invoices add column if not exists equipment_active integer not null default 0;
alter table public.billing_invoices add column if not exists equipment_included integer not null default 0;
alter table public.billing_invoices add column if not exists equipment_count integer not null default 0;
alter table public.billing_invoices add column if not exists equipment_unit_incl_cents bigint not null default 0;
alter table public.billing_invoices drop constraint if exists billing_invoices_equipment_ck;
alter table public.billing_invoices add constraint billing_invoices_equipment_ck check (
  equipment_active >= 0 and equipment_included >= 0 and equipment_count >= 0 and equipment_unit_incl_cents >= 0);
comment on column public.billing_invoices.equipment_count is
  'Extra support-equipment spaces charged on this invoice: max(0, in use - included) at '
  'renewal (20261114090300). equipment_unit_incl_cents is the price of one for the period.';
alter table public.billing_asset_snapshots add column if not exists equipment_count integer;

create or replace function app.billing_derive_invoice_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_gross bigint;
  v_discount bigint;
begin
  -- Full spaces, plus extra support equipment for the period (20261114090300). Both are
  -- the plan's price, so a subscription's discount applies to both.
  v_gross := new.unit_price_incl_cents * new.asset_count * new.months_charged
             + coalesce(new.equipment_unit_incl_cents, 0) * coalesce(new.equipment_count, 0);

  if new.kind = 'service' then
    new.discount_cents := 0;
    new.ai_usage_ex_vat_cents := 0;
    new.ai_usage_incl_cents := 0;
    new.total_incl_cents := coalesce(
      (select sum(l.line_total_incl_cents) from public.billing_invoice_lines l where l.invoice_id = new.id), 0);
    new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
    new.vat_cents := new.total_incl_cents - new.subtotal_ex_vat_cents;
    new.updated_at := now();
    return new;
  end if;

  if tg_op = 'INSERT' or new.status = 'draft' then
    v_discount := coalesce(
      app.billing_discount_cents(new.subscription_id, v_gross, new.period_start), 0);
    new.discount_cents := least(v_discount, v_gross);
    if new.discount_cents > 0 and new.discount_label is null then
      new.discount_label := (
        select coalesce(s.discount_label, s.discount_code)
          from public.billing_subscriptions s where s.id = new.subscription_id);
    end if;
  else
    new.discount_cents := least(coalesce(new.discount_cents, 0), v_gross);
  end if;

  new.ai_usage_ex_vat_cents := coalesce(new.ai_usage_ex_vat_cents, 0);
  new.ai_usage_incl_cents   := new.ai_usage_ex_vat_cents
    + round(new.ai_usage_ex_vat_cents::numeric * coalesce(new.vat_rate_bps, 0) / 10000)::bigint;

  new.total_incl_cents      := v_gross - new.discount_cents + new.ai_usage_incl_cents;
  new.subtotal_ex_vat_cents := app.ex_vat_cents(new.total_incl_cents, new.vat_rate_bps);
  new.vat_cents             := new.total_incl_cents - new.subtotal_ex_vat_cents;
  new.updated_at            := now();
  return new;
end $$;
revoke execute on function app.billing_derive_invoice_totals() from public, anon, authenticated;

create or replace function app.billing_freeze_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'BILLING: invoice % has been issued and cannot be deleted (void it instead)',
        old.invoice_ref using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if old.status = 'draft' then
    return new;
  end if;

  if new.invoice_ref       is distinct from old.invoice_ref
     or new.farm_id        is distinct from old.farm_id
     or new.period_start   is distinct from old.period_start
     or new.period_end     is distinct from old.period_end
     or new.plan           is distinct from old.plan
     or new.billing_period is distinct from old.billing_period
     or new.asset_count    is distinct from old.asset_count
     or new.unit_price_incl_cents is distinct from old.unit_price_incl_cents
     or new.months_charged is distinct from old.months_charged
     or new.price_version_id      is distinct from old.price_version_id
     or new.price_version_label   is distinct from old.price_version_label
     or new.vat_rate_bps          is distinct from old.vat_rate_bps
     or new.seller_vat_number     is distinct from old.seller_vat_number
     or new.subtotal_ex_vat_cents is distinct from old.subtotal_ex_vat_cents
     or new.vat_cents             is distinct from old.vat_cents
     or new.total_incl_cents      is distinct from old.total_incl_cents
     or new.currency              is distinct from old.currency
     or new.ai_usage_ex_vat_cents is distinct from old.ai_usage_ex_vat_cents
     or new.ai_usage_incl_cents   is distinct from old.ai_usage_incl_cents
     or new.ai_usage_from         is distinct from old.ai_usage_from
     or new.ai_usage_to           is distinct from old.ai_usage_to
     or new.ai_usage_people       is distinct from old.ai_usage_people
     -- Support equipment on the invoice (20261114090300).
     or new.equipment_active          is distinct from old.equipment_active
     or new.equipment_included        is distinct from old.equipment_included
     or new.equipment_count           is distinct from old.equipment_count
     or new.equipment_unit_incl_cents is distinct from old.equipment_unit_incl_cents
     or new.seller_snapshot       is distinct from old.seller_snapshot
     or new.bill_to_snapshot      is distinct from old.bill_to_snapshot then
    raise exception
      'BILLING: invoice % is issued; its pricing snapshot is immutable (status/payment/void may still change)',
      old.invoice_ref using errcode = 'check_violation';
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function app.billing_freeze_invoice() from public, anon, authenticated;

-- == The invoice run, with support equipment ===============================================
-- 20261104200000's run, plus: the full-space line priced at the explicit period price, an
-- equipment line for max(0, in use - included), and the subscription's equipment capacity
-- reset to what the new period paid for. Everything else is unchanged.
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
  v_exempt   boolean;
  v_space    bigint;
  v_eq_active   integer;
  v_eq_included integer;
  v_eq_extra    integer;
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
            -- Exempt farms stay in this loop (20261029160000, finding money-5) and take the
            -- no-invoice path below: left out of it altogether (20261029150000) their
            -- periods froze, and the night the flag was cleared the run caught up one
            -- invoice a night for every month they had been exempt.
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
                -- A REFUNDED invoice is open again but deliberately not owed
                -- (20261029150000), the predicate app.farm_overdue_since uses: counting it
                -- left a reopened farm pending with nothing it could pay.
                and not exists (
                  select 1 from public.billing_payments p
                   where p.invoice_id = i.id and p.deleted_at is null and p.amount_incl_cents < 0
                )
           ))
       -- Never renew a subscription that is ENDING (20261029150000). The nightly cron raises
       -- invoices before it closes cancellations, so on the night a period-end cancellation
       -- fell due this raised the next period and moved the end a month on, the close never
       -- matched, and seven days later the farm was suspended and its stored card charged
       -- for the month after it left. Left alone here, app.billing_close_cancellations
       -- closes it the same night.
       -- A trial that cancelled has no period yet, so its trial end is its period end
       -- (20261029160000, finding money-1): keyed on current_period_end alone, the night
       -- the trial ended raised a month, wrote a period, and the close never matched.
       and not (cancel_at_period_end and coalesce(current_period_end, trial_ends_on) is not null
                and next_billing_on > coalesce(current_period_end, trial_ends_on))
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
    -- An EXEMPT farm (20261029160000, finding money-5) moves on a period with nothing
    -- raised, so its dates keep pace while it is exempt and clearing the flag bills only
    -- from then on. Its AI use from the exempt time is waived when the flag is cleared
    -- (app.farms_billing_exempt_track).
    select f.billing_exempt into v_exempt from public.farms f where f.id = s.farm_id;
    if v_exempt then
      v_pstart := coalesce(s.current_period_end + 1, s.next_billing_on);
      v_pend   := app.billing_advance_period(v_pstart, s.billing_period, s.anchor_day) - 1;
      update public.billing_subscriptions
         set current_period_start = v_pstart,
             current_period_end   = v_pend,
             next_billing_on      = v_pend + 1,
             status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
             updated_at = now()
       where id = s.id;
      continue;
    end if;

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
    --
    -- THE PLAN MINIMUM (20261104200000). A price row may carry a minimum number of billed
    -- slots (five on the November 2026 list, none on the launch list), and a farm billed
    -- below it is billed the minimum. Slot changes and sign-ups already keep the quota at
    -- or above it, so this only reaches a farm billed on its counted fleet (no quota),
    -- which the admin start path creates. Older generations carry 0, so a grandfathered
    -- farm's invoice is exactly what it was.
    v_count := greatest(app.billing_billable_units(s.id), coalesce(v_price.min_billed_slots, 0));

    -- SUPPORT EQUIPMENT (20261114090300). What is in use at renewal, less the plan's
    -- included equipment; retired and sold equipment drop off here, at the renewal, never in
    -- the middle of a period. A first invoice (pending) bills what was bought at sign-up when
    -- that is more. An agreement without equipment terms has none to bill. The extra paid for
    -- the new period becomes the subscription's equipment capacity.
    v_space       := app.billing_space_period_cents(v_price);
    v_eq_active   := app.billable_equipment_count(s.farm_id);
    v_eq_included := coalesce(v_price.equipment_included, 0);
    v_eq_extra    := greatest(v_eq_active - v_eq_included, 0);
    if s.status = 'pending' then
      v_eq_extra := greatest(v_eq_extra, coalesce(s.equipment_extra_quota, 0));
    end if;
    if v_price.equipment_period_incl_cents is null then
      v_eq_extra := 0;
    end if;

    if v_count <= 0 and v_eq_extra <= 0 then
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
        equipment_active, equipment_included, equipment_count, equipment_unit_incl_cents,
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
        v_eq_active, v_eq_included, v_eq_extra, coalesce(v_price.equipment_period_incl_cents, 0),
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
      'FleetWise ' || s.plan::text || ', ' || v_count::text || ' vehicle(s)'
        || case when v_count > app.billing_billable_units(s.id) then ' (plan minimum)' else '' end,
      v_count, v_price.months_charged,
      v_price.per_vehicle_monthly_incl_cents,
      i.total,
      app.ex_vat_cents(i.total, i.rate),
      i.total - app.ex_vat_cents(i.total, i.rate)
    from (
      select
        -- The explicit price for the period (equal to unit x months by the price row's check).
        (v_space * v_count)::bigint as total,
        -- Read the rate BACK off the invoice: the VAT guard may have forced it to zero,
        -- and a line that disagreed with its own invoice would be the worst of both.
        (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate
    ) i;

    if v_eq_extra > 0 then
      insert into public.billing_invoice_lines (
        invoice_id, farm_id, sort_order, description, qty, months_charged,
        unit_price_incl_cents, line_total_incl_cents, line_ex_vat_cents, line_vat_cents
      )
      select
        v_invoice, s.farm_id, 1,
        'FleetWise support equipment, ' || v_eq_extra::text || ' beyond the ' || v_eq_included::text || ' included',
        v_eq_extra, 1,
        v_price.equipment_period_incl_cents,
        e.total,
        app.ex_vat_cents(e.total, e.rate),
        e.total - app.ex_vat_cents(e.total, e.rate)
      from (
        select (v_price.equipment_period_incl_cents * v_eq_extra)::bigint as total,
               (select vat_rate_bps from public.billing_invoices where id = v_invoice) as rate
      ) e;
    end if;

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

    insert into public.billing_asset_snapshots (farm_id, subscription_id, captured_on, asset_count, equipment_count, source)
    values (s.farm_id, s.id, current_date, v_count, v_eq_active, 'period_close')
    on conflict (farm_id, captured_on, source) do update set asset_count = excluded.asset_count, equipment_count = excluded.equipment_count;

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
           equipment_extra_quota = v_eq_extra,
           status = case when status = 'trialing' then 'active'::billing_subscription_status else status end,
           updated_at = now()
     where id = s.id;

    v_made := v_made + 1;
  end loop;

  return v_made;
end $$;

-- The renewal notice states the same sum the invoice run raises, equipment included.
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
  v_eq     integer;
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
    -- With the plan minimum (20261104200000), exactly as the invoice run applies it.
    v_units  := greatest(app.billing_billable_units(s.id), coalesce(v_price.min_billed_slots, 0));
    -- Full spaces and extra support equipment, the sum the invoice run will raise
    -- (app.billing_renewal_cents, 20261114090300).
    v_eq     := case when v_price.equipment_period_incl_cents is null then 0
                     else app.billable_equipment_count(s.farm_id) end;
    v_amount := coalesce(app.billing_renewal_cents(v_price, v_units, v_eq), 0);
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
        'equipment',      v_eq,
        'ai_billed',      v_ai_on,
        'ai_cents',       v_ai
      )
    );
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end $$;
