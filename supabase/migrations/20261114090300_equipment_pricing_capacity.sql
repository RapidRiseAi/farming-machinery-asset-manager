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