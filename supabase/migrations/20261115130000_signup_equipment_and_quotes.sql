-- 20261115130000_signup_equipment_and_quotes.sql
-- Signing up with support equipment, the 200-space online line, and asking for a quote above
-- it (BRIEF section 4 and 22; decision 39; requirements R-009 and R-141; scenario 2).
--
-- == Sign-up ===============================================================================
-- app.create_pending_signup takes the equipment the customer will run (p_equipment, default 0,
-- so the live build's seven-argument call keeps working). The full spaces are at least the
-- price's minimum, as before, and at most app.self_service_max_full_spaces() (200): more is
-- refused 'signup-capacity-quote', and the app records a quote request instead. The 200 is a
-- line on online sign-up only, not a technical maximum and not an equipment cap. Equipment
-- beyond the plan's included allowance is bought as equipment_extra_quota, which the first
-- invoice already bills for a pending subscription (20261114090300). The eight-argument
-- wrapper is replaced by a nine-argument one with a default, not kept beside it: PostgREST
-- resolves by argument name and two would make every call ambiguous.
--
-- == Asking for a quote ====================================================================
-- capacity_quote_requests holds a larger customer's request: who, the business, the plan,
-- term, full spaces and equipment, and what they wrote. Written only by the service-role
-- public.billing_request_capacity_quote (the sign-up action, after its bot check and rate
-- limit); Rapid Rise reads and works them, and is told of each. No farm exists yet, so there
-- is no farm_id and no pay gate.
--
-- Safe on live data: one new table, a replaced function with a defaulted extra argument.

drop function if exists public.billing_create_pending_signup(uuid, text, text, text, farm_plan, billing_period, integer, text);
drop function if exists app.create_pending_signup(uuid, text, text, text, farm_plan, billing_period, integer, text);

create or replace function app.create_pending_signup(
  p_user       uuid,
  p_email      text,
  p_name       text,
  p_farm_name  text,
  p_plan       farm_plan,
  p_period     billing_period,
  p_quota      integer,
  p_promo_code text default null,
  p_equipment  integer default 0
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm   uuid;
  v_sub    uuid;
  v_price  public.billing_price_versions%rowtype;
  v_promo  jsonb;
  v_quota  integer;
  v_extra  integer := 0;
begin
  if p_quota is null or p_quota < 1 then
    raise exception 'SIGNUP: choose at least one vehicle' using errcode = 'check_violation';
  end if;
  if coalesce(btrim(p_farm_name), '') = '' then
    raise exception 'SIGNUP: the farm needs a name' using errcode = 'check_violation';
  end if;
  if coalesce(p_equipment, 0) < 0 or coalesce(p_equipment, 0) > 10000 then
    raise exception 'signup-equipment' using errcode = 'check_violation';
  end if;

  select * into v_price from app.billing_active_price(p_plan, p_period);
  if v_price.id is null or v_price.per_vehicle_monthly_incl_cents is null then
    raise exception 'SIGNUP: that plan is not available to buy online'
      using errcode = 'check_violation';
  end if;

  v_quota := greatest(p_quota, coalesce(v_price.min_billed_slots, 0));
  -- Above the online line: a capacity check and a quote (decision 39), never a sign-up.
  if v_quota > app.self_service_max_full_spaces() then
    raise exception 'signup-capacity-quote' using errcode = 'check_violation';
  end if;
  -- Equipment beyond what the plan includes is bought now, as extra equipment spaces.
  if coalesce(p_equipment, 0) > 0 then
    if v_price.equipment_period_incl_cents is null then
      raise exception 'equipment-not-in-agreement' using errcode = 'check_violation';
    end if;
    v_extra := greatest(p_equipment - coalesce(v_price.equipment_included, 0), 0);
  end if;

  insert into public.farms (name, plan, status, billing_period, billing_email)
  values (btrim(p_farm_name), p_plan, 'active', p_period, lower(btrim(p_email)))
  returning id into v_farm;

  insert into public.users (id, farm_id, workshop_id, role, name, email, active)
  values (p_user, v_farm, null, 'owner',
          nullif(btrim(p_name), ''), lower(btrim(p_email)), true);

  insert into public.billing_subscriptions (
    farm_id, plan, billing_period, status,
    current_period_start, current_period_end, next_billing_on,
    anchor_day, asset_quota, equipment_extra_quota, created_by
  ) values (
    v_farm, p_plan, p_period, 'pending',
    null, null, current_date,
    extract(day from current_date)::integer, v_quota, v_extra, p_user
  )
  returning id into v_sub;

  if coalesce(btrim(p_promo_code), '') <> '' then
    v_promo := app.billing_take_promo_code(v_sub, p_promo_code);
    if not coalesce((v_promo->>'ok')::boolean, false) then
      raise exception 'SIGNUP_PROMO:%', coalesce(v_promo->>'error', 'unknown')
        using errcode = 'check_violation';
    end if;
  end if;

  if app.generate_billing_invoices(v_sub) <> 1 then
    raise exception 'SIGNUP: could not raise the first invoice' using errcode = 'check_violation';
  end if;

  return v_sub;
end $$;
revoke all on function app.create_pending_signup(uuid, text, text, text, farm_plan, billing_period, integer, text, integer)
  from public, anon, authenticated, service_role;

create or replace function public.billing_create_pending_signup(
  p_user       uuid,
  p_email      text,
  p_name       text,
  p_farm_name  text,
  p_plan       farm_plan,
  p_period     billing_period,
  p_quota      integer,
  p_promo_code text default null,
  p_equipment  integer default 0
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.create_pending_signup(p_user, p_email, p_name, p_farm_name,
                                   p_plan, p_period, p_quota, p_promo_code, p_equipment);
$$;
revoke all on function public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer, text, integer)
  from public, anon, authenticated;
grant execute on function public.billing_create_pending_signup(
  uuid, text, text, text, farm_plan, billing_period, integer, text, integer) to service_role;

-- == Asking for a quote ======================================================================
create table if not exists public.capacity_quote_requests (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(btrim(name)) between 1 and 200),
  email         text not null check (length(email) between 3 and 320 and position('@' in email) > 1),
  business_name text not null check (length(btrim(business_name)) between 1 and 200),
  plan          farm_plan not null,
  billing_period billing_period not null,
  full_spaces   integer not null check (full_spaces between 1 and 100000),
  equipment     integer not null default 0 check (equipment between 0 and 100000),
  message       text check (message is null or length(message) <= 2000),
  lang          text not null default 'en' check (lang in ('en', 'af')),
  status        text not null default 'new' check (status in ('new', 'contacted', 'quoted', 'closed')),
  handled_by    uuid references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists capacity_quote_requests_new_idx on public.capacity_quote_requests (created_at desc) where status = 'new';
comment on table public.capacity_quote_requests is
  'A larger customer asking for a capacity check and a quote: more than the online sign-up line '
  'of 200 full spaces (decision 39, 20261115130000). Written by the service role from sign-up; '
  'Rapid Rise reads and works it.';
alter table public.capacity_quote_requests enable row level security;
alter table public.capacity_quote_requests force row level security;
drop policy if exists capacity_quote_requests_rr on public.capacity_quote_requests;
create policy capacity_quote_requests_rr on public.capacity_quote_requests
  for select to authenticated using ((select app.is_rr_admin()));
drop policy if exists capacity_quote_requests_rr_upd on public.capacity_quote_requests;
create policy capacity_quote_requests_rr_upd on public.capacity_quote_requests
  for update to authenticated using ((select app.is_rr_admin())) with check ((select app.is_rr_admin()));
revoke all on public.capacity_quote_requests from public, anon, authenticated;
grant select, update (status, handled_by, updated_at) on public.capacity_quote_requests to authenticated;
grant all on public.capacity_quote_requests to service_role;
drop trigger if exists capacity_quote_requests_audit on public.capacity_quote_requests;
create trigger capacity_quote_requests_audit after insert or update or delete on public.capacity_quote_requests
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('capacity_quote_requests', 'rapid_rise', 'a prospective customer''s request for a quote')
on conflict (table_name) do nothing;

create or replace function public.billing_request_capacity_quote(
  p_name text, p_email text, p_business text, p_plan farm_plan, p_period billing_period,
  p_full integer, p_equipment integer, p_message text, p_lang text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_full is null or p_full <= app.self_service_max_full_spaces() then
    raise exception 'signup-quote-not-needed' using errcode = 'check_violation';
  end if;
  insert into public.capacity_quote_requests (name, email, business_name, plan, billing_period,
                                              full_spaces, equipment, message, lang)
  values (btrim(p_name), lower(btrim(p_email)), btrim(p_business), p_plan, p_period,
          p_full, greatest(coalesce(p_equipment, 0), 0), nullif(btrim(coalesce(p_message, '')), ''),
          case when p_lang = 'af' then 'af' else 'en' end)
  returning id into v_id;
  -- Rapid Rise hears of it in its alert centre: a quote is a person's job.
  insert into public.notifications (farm_id, user_id, channel, template, payload, status)
  select null, u.id, 'inapp', 'capacity_quote_requested',
         jsonb_build_object('request_id', v_id, 'full_spaces', p_full, 'equipment', greatest(coalesce(p_equipment, 0), 0)),
         'queued'
    from public.users u where u.role = 'rr_admin' and u.active and u.deleted_at is null and not u.is_test;
  return v_id;
end $$;
revoke all on function public.billing_request_capacity_quote(text, text, text, farm_plan, billing_period, integer, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.billing_request_capacity_quote(text, text, text, farm_plan, billing_period, integer, integer, text, text)
  to service_role;
