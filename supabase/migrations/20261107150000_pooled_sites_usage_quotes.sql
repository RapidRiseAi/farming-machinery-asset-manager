-- 20261107150000_pooled_sites_usage_quotes.sql
-- Three billing arrangements from the 29 October pricing brief.
--
-- == One bill for several sites ================================================
-- A business with depots or several farms pays once: each other site is billed through the
-- main one. The main site's slots cover the vehicles of every site, one minimum applies, and
-- a site billed through another follows that site's state (paid, paused or closed), since it
-- has no bill of its own. One level only: a main site is never itself billed through another.
-- Each site keeps its own vehicle count (farms.asset_count); only the billing count pools.
--
-- == Usage at cost plus a markup ===============================================
-- WhatsApp messages and stored files cost Rapid Rise money, passed on at cost plus 30% (the
-- default markup) once Rapid Rise has set what each costs. This measures; Rapid Rise raises
-- the invoice from the console, through the same service-invoice path as any once-off charge.
--
-- == A Done-For-You quote ======================================================
-- An accepted quote becomes that customer's own price: a private price row the subscription is
-- pinned to, so the nightly invoice run bills it exactly as it bills every other plan. The
-- minimum is a number of vehicles, because that is what the invoice run bills in.

alter table public.farms add column if not exists billed_through uuid references public.farms(id);
alter table public.farms drop constraint if exists farms_billed_through_self_ck;
alter table public.farms add constraint farms_billed_through_self_ck check (billed_through is null or billed_through <> id);
create index if not exists farms_billed_through_idx on public.farms (billed_through) where billed_through is not null;

create or replace function app.farms_guard_billed_through() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.billed_through is null then return new; end if;
  if exists (select 1 from public.farms f where f.id = new.billed_through and f.billed_through is not null) then
    raise exception 'a site can only be billed through a main site' using errcode = '22023';
  end if;
  if exists (select 1 from public.farms f where f.billed_through = new.id) then
    raise exception 'a main site cannot itself be billed through another' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function app.farms_guard_billed_through() from public, anon, authenticated;
drop trigger if exists farms_guard_billed_through on public.farms;
create trigger farms_guard_billed_through before insert or update of billed_through on public.farms
  for each row execute function app.farms_guard_billed_through();

-- The billing count: this site's vehicles, and those of every site billed through it.
create or replace function app.billable_asset_count(p_farm uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::integer
    from public.machines m
   where (m.farm_id = p_farm
          or m.farm_id in (select f.id from public.farms f where f.billed_through = p_farm and f.deleted_at is null))
     and m.deleted_at is null
     and m.status not in ('retired', 'sold');
$$;

create or replace function app.billing_enforce_vehicle_quota()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_quota integer; v_used integer; v_farm uuid;
begin
  -- A site billed through another uses that site's slots.
  v_farm := coalesce((select f.billed_through from public.farms f where f.id = new.farm_id), new.farm_id);

  -- Only a row that will actually be BILLED counts. Filing a machine that is already
  -- retired or sold, or arriving soft-deleted, adds nothing to the fleet and must not be
  -- refused: app.billable_asset_count excludes exactly these.
  if new.deleted_at is not null or new.status in ('retired', 'sold') then
    return new;
  end if;

  -- On an update, only the transition INTO the billable set is an addition. Editing the
  -- name of a machine on a farm that is already at its ceiling must not fail.
  if tg_op = 'UPDATE'
     and old.farm_id = new.farm_id
     and old.deleted_at is null
     and old.status not in ('retired', 'sold') then
    return new;
  end if;

  select s.asset_quota into v_quota
    from public.billing_subscriptions s
   where s.farm_id = v_farm and s.deleted_at is null
   limit 1;

  -- No quota, no ceiling. Grandfathered farms and admin-created farms live here.
  if v_quota is null then
    return new;
  end if;

  v_used := app.billable_asset_count(v_farm);
  if v_used >= v_quota then
    raise exception
      'BILLING: vehicle limit reached, % of % slots are in use', v_used, v_quota
      using errcode = 'check_violation',
            hint = 'Add more slots on the billing screen, or retire a vehicle first.';
  end if;

  return new;
end $function$;

create or replace function app.farm_billing_gate(p_farm uuid)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  f public.farms%rowtype;
  s public.billing_subscriptions%rowtype;
  v_grace integer;
  v_since date;
begin
  select * into f from public.farms where id = p_farm;
  if not found then return 'ok'; end if;

  -- Rapid Rise ended the account, or holds it: closed. A billing suspension is its own state.
  if f.deleted_at is not null or f.status = 'cancelled' then return 'closed'; end if;
  if f.status = 'suspended' then
    return case when f.suspended_for = 'billing' then 'suspended' else 'closed' end;
  end if;

  if f.billing_exempt then return 'ok'; end if;

  -- A site billed through another has no bill of its own: it follows that site (one level).
  if f.billed_through is not null then return app.farm_billing_gate(f.billed_through); end if;

  select * into s
    from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null
   order by created_at desc
   limit 1;

  -- No subscription at all: still let in. Every self sign-up starts with a PENDING
  -- subscription, so "access only after payment" already holds for them; a farm Rapid Rise
  -- creates by hand gets its pending subscription and invoice from staff onboarding, and test
  -- farms are exempt above.
  if not found then return 'ok'; end if;
  if s.status = 'pending' then return 'pending'; end if;
  if s.status = 'suspended' then return 'suspended'; end if;

  if s.status = 'cancelled' then
    if coalesce(s.ended_on, s.cancelled_at::date) < current_date then return 'closed'; end if;
    return 'ok';
  end if;

  -- Every other state is decided by what is unpaid, not by the card's ladder.
  select coalesce(access_grace_days, 7) into v_grace from public.billing_settings where singleton;
  v_grace := coalesce(v_grace, 7);
  v_since := app.farm_overdue_since(p_farm);
  if v_since is not null and (v_since + v_grace) < current_date
     and (s.access_extended_until is null or s.access_extended_until < current_date) then
    return 'suspended';
  end if;
  return 'ok';
end;
$function$;

-- == Usage =====================================================================
create table if not exists public.usage_rates (
  singleton               boolean primary key default true check (singleton),
  whatsapp_message_cents  integer check (whatsapp_message_cents is null or whatsapp_message_cents >= 0),
  storage_gb_month_cents  integer check (storage_gb_month_cents is null or storage_gb_month_cents >= 0),
  markup_bps              integer not null default 3000 check (markup_bps between 0 and 20000),
  updated_by              uuid references public.users(id) on delete set null,
  updated_at              timestamptz not null default now()
);
insert into public.usage_rates (singleton) values (true) on conflict do nothing;

alter table public.usage_rates enable row level security;
alter table public.usage_rates force row level security;
create policy usage_rates_all on public.usage_rates for all to authenticated
  using (app.is_rr_admin()) with check (app.is_rr_admin());
revoke all on public.usage_rates from public, anon, authenticated;
grant select, update on public.usage_rates to authenticated;
grant all on public.usage_rates to service_role;
create trigger usage_rates_audit after insert or update or delete on public.usage_rates
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('usage_rates', 'rapid_rise', 'what Rapid Rise pays for messages and storage, and its markup')
on conflict (table_name) do nothing;

-- What each business used: messages sent in a month, and what it stores now.
create or replace function public.usage_for_month(p_month date)
returns table (farm_id uuid, whatsapp_sent bigint, storage_bytes bigint)
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_from timestamptz := date_trunc('month', p_month::timestamp) at time zone 'Africa/Johannesburg';
  v_to   timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'Africa/Johannesburg';
begin
  return query
  with sent as (
    select n.farm_id, count(*)::bigint c
      from public.whatsapp_notification_delivery d
      join public.notifications n on n.id = d.notification_id
     where d.state = 'sent' and d.created_at >= v_from and d.created_at < v_to and n.farm_id is not null
     group by n.farm_id
  ),
  stored as (
    select o.farm_id, sum(o.size)::bigint b
      from (select f.id as farm_id, x.size
              from public.farms f
              cross join lateral public.farm_file_objects(f.id) x) o
     group by o.farm_id
  )
  select f.id, coalesce(sent.c, 0), coalesce(stored.b, 0)
    from public.farms f
    left join sent on sent.farm_id = f.id
    left join stored on stored.farm_id = f.id
   where f.deleted_at is null
     and (sent.c is not null or stored.b is not null);
end $$;
revoke all on function public.usage_for_month(date) from public, anon, authenticated;
grant execute on function public.usage_for_month(date) to service_role;

-- == Done-For-You quotes =======================================================
create table if not exists public.done_for_you_quotes (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references public.farms(id),
  reference             text not null check (length(reference) between 1 and 100),
  per_vehicle_incl_cents integer not null check (per_vehicle_incl_cents >= 0),
  min_vehicles          integer not null check (min_vehicles between 0 and 1000),
  billing_period        public.billing_period not null,
  accepted_on           date not null,
  notes                 text check (coalesce(length(notes), 0) <= 2000),
  price_version_id      uuid references public.billing_price_versions(id),
  recorded_by           uuid references public.users(id) on delete set null,
  created_at            timestamptz not null default now()
);
alter table public.done_for_you_quotes enable row level security;
alter table public.done_for_you_quotes force row level security;
create policy done_for_you_quotes_sel on public.done_for_you_quotes for select to authenticated
  using (app.is_rr_admin());
revoke all on public.done_for_you_quotes from public, anon, authenticated;
grant select on public.done_for_you_quotes to authenticated;
grant all on public.done_for_you_quotes to service_role;
create trigger done_for_you_quotes_audit after insert or update or delete on public.done_for_you_quotes
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('done_for_you_quotes', 'rapid_rise', 'a price agreed with one customer')
on conflict (table_name) do nothing;

create or replace function public.billing_record_dfy_quote(
  p_farm uuid, p_reference text, p_per_vehicle_incl_cents integer, p_min_vehicles integer,
  p_period public.billing_period, p_accepted_on date, p_notes text, p_by uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_sub     public.billing_subscriptions%rowtype;
  v_price   uuid;
  v_quote   uuid;
  v_vat     integer;
begin
  select * into v_sub from public.billing_subscriptions
   where farm_id = p_farm and deleted_at is null order by created_at desc limit 1 for update;
  if not found then raise exception 'this business has no subscription to price' using errcode = '22023'; end if;
  if p_per_vehicle_incl_cents is null or p_per_vehicle_incl_cents < 0 then
    raise exception 'a price is needed' using errcode = '22023';
  end if;

  select coalesce(vat_rate_bps, 0) into v_vat from public.billing_price_versions
   where status = 'active' and deleted_at is null order by effective_from desc limit 1;

  -- Private: a draft is never the active price, so it reaches only the subscription pinned to it.
  insert into public.billing_price_versions (version_label, plan, billing_period, per_vehicle_monthly_incl_cents,
                                             months_charged, vat_rate_bps, status, effective_from, notes,
                                             min_billed_slots, created_by)
  values ('quote-' || p_farm::text || '-' || to_char(now(), 'YYYYMMDDHH24MISS'), 'done_for_you', p_period,
          p_per_vehicle_incl_cents, case when p_period = 'annual' then 10 else 1 end, coalesce(v_vat, 0),
          'draft', p_accepted_on, 'Done-For-You quote ' || p_reference, coalesce(p_min_vehicles, 0), p_by)
  returning id into v_price;

  update public.billing_subscriptions
     set plan = 'done_for_you', billing_period = p_period, price_version_id = v_price, updated_at = now(),
         asset_quota = greatest(coalesce(asset_quota, 0), coalesce(p_min_vehicles, 0))
   where id = v_sub.id;
  update public.farms set plan = 'done_for_you' where id = p_farm;

  insert into public.done_for_you_quotes (farm_id, reference, per_vehicle_incl_cents, min_vehicles, billing_period,
                                          accepted_on, notes, price_version_id, recorded_by)
  values (p_farm, p_reference, p_per_vehicle_incl_cents, coalesce(p_min_vehicles, 0), p_period,
          p_accepted_on, nullif(btrim(p_notes), ''), v_price, p_by)
  returning id into v_quote;
  return v_quote;
end $$;
revoke all on function public.billing_record_dfy_quote(uuid, text, integer, integer, public.billing_period, date, text, uuid)
  from public, anon, authenticated;
grant execute on function public.billing_record_dfy_quote(uuid, text, integer, integer, public.billing_period, date, text, uuid)
  to service_role;
