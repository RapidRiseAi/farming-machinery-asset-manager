-- 20261104220000_plan_boundaries.sql
-- The database half of the plan audit of 4 November 2026 (docs/PLAN_FEATURES.md).
--
-- * farm_book_values: the depreciated asset register is Professional analytics. It
--   relied on cost visibility alone, so an Essential farm's owner could read it through
--   the RPC however the screen was gated.
-- * Driving and hardware feeds are Done-For-You. Switching one on (staff only, with a
--   quote reference) and every event it delivers now check the farm's plan as well, so a
--   feed stops when the farm leaves the plan, closes or is paused for payment.
--
-- Signatures are unchanged, so existing grants carry over.

create or replace function public.farm_book_values(p_farm uuid, p_on date default null)
returns table (
  machine_id            uuid,
  name                  text,
  reg_no                text,
  type                  machine_type,
  status                machine_status,
  purchase_date         date,
  purchase_price_cents  bigint,
  method                depreciation_method,
  rate_bps              integer,
  life_months           integer,
  residual_value_cents  bigint,
  start_date            date,
  months_held           integer,
  book_value_cents      bigint,
  depreciated_cents     bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    m.id,
    m.name,
    m.reg_no,
    m.type,
    m.status,
    m.purchase_date,
    m.purchase_price_cents,
    m.depreciation_method,
    m.depreciation_rate_bps,
    m.useful_life_months,
    m.residual_value_cents,
    coalesce(m.depreciation_start_date, m.purchase_date),
    app.months_between(
      coalesce(m.depreciation_start_date, m.purchase_date),
      coalesce(p_on, current_date)),
    app.book_value_cents(
      m.purchase_price_cents, m.depreciation_method, m.depreciation_rate_bps,
      m.useful_life_months, m.residual_value_cents,
      coalesce(m.depreciation_start_date, m.purchase_date), coalesce(p_on, current_date)),
    m.purchase_price_cents - app.book_value_cents(
      m.purchase_price_cents, m.depreciation_method, m.depreciation_rate_bps,
      m.useful_life_months, m.residual_value_cents,
      coalesce(m.depreciation_start_date, m.purchase_date), coalesce(p_on, current_date))
  from public.machines m
  where m.farm_id = p_farm
    and m.deleted_at is null
    -- Sold and retired machines are left out of a register of what to insure. They are
    -- still in the audit trail and in the cost history; they are not assets to cover.
    and m.status not in ('sold', 'retired')
    and app.can_view_farm_costs(m.farm_id)
    -- Book value is asset analytics, a Professional feature (20261104220000). The purchase
    -- price itself stays a record every plan keeps (machine detail, sale pack); this is
    -- the depreciated register built from it.
    and (app.is_rr_admin() or app.has_entitlement(m.farm_id, 'tco'))
    and (
      app.row_visible_to_role(m.farm_id, m.id)
      or (app.is_farm_side() and app.has_permission(m.farm_id, 'see_all_vehicles'))
    )
  order by m.name;
$$;

create or replace function public.configure_driver_connection(p_farm uuid,p_name text,p_kind text,p_hash text,
  p_id uuid default null,p_active boolean default false,p_quote text default null) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare result uuid;
begin
  if not app.is_rr_admin() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_active and nullif(trim(p_quote),'') is null then raise exception 'quote_required' using errcode='22023'; end if;
  -- Hardware and provider feeds are Done-For-You (founder decision 2026-10-29): a quote
  -- reference alone does not switch a feed on for a farm on a lower plan.
  if p_active and not exists(select 1 from farms f where f.id=p_farm and f.deleted_at is null
      and app.plan_rank(f.plan) >= app.feature_min_rank('api_access')) then
    raise exception 'plan_required' using errcode='22023';
  end if;
  if p_id is null then
    if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token' using errcode='22023'; end if;
    insert into driver_connections(farm_id,name,kind,active,quote_reference) values(p_farm,p_name,p_kind,p_active,p_quote) returning id into result;
    insert into driver_connection_secrets(connection_id,token_hash) values(result,p_hash);
  else
    update driver_connections set name=p_name,kind=p_kind,active=p_active,quote_reference=p_quote where id=p_id and farm_id=p_farm returning id into result;
    if result is null then raise exception 'not_found' using errcode='22023'; end if;
    if p_hash is not null then
      if p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token' using errcode='22023'; end if;
      update driver_connection_secrets set token_hash=p_hash where connection_id=result;
    end if;
  end if;
  return result;
end $$;

create or replace function public.ingest_driving_event(p_connection uuid,p_machine_external text,p_driver_external text,
  p_event_id text,p_kind text,p_at timestamptz,p_location text default null,p_lat double precision default null,p_lng double precision default null) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare f uuid; m uuid; d uuid;
begin
  select farm_id into f from driver_connections where id=p_connection and active for update;
  if f is null or nullif(trim(p_event_id),'') is null or length(p_event_id)>200 then raise exception 'invalid_connection' using errcode='22023'; end if;
  -- Ingest checks the farm as it is NOW, not as it was when the feed was switched on: a
  -- farm that left Done-For-You, closed or was paused for payment stops receiving events.
  if not exists(select 1 from farms fm where fm.id=f and fm.deleted_at is null and fm.status in ('active','trial')
      and app.plan_rank(fm.plan) >= app.feature_min_rank('api_access')) then
    raise exception 'plan_required' using errcode='42501';
  end if;
  select machine_id into m from driver_device_links where connection_id=p_connection and external_id=p_machine_external;
  select driver_id into d from driver_device_links where connection_id=p_connection and external_id=p_driver_external;
  if m is null or d is null then raise exception 'unmapped_device_or_driver' using errcode='22023'; end if;
  return app.write_driving_event(f,m,d,p_kind,p_at,p_location,null,p_lat,p_lng,null,p_connection,p_event_id);
end $$;
