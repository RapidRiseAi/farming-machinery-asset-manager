-- 20261114090100_equipment_profile.sql
-- The Support Equipment profile (BRIEF section 5; decision register of 12 November 2026,
-- decisions 1 to 5).
--
-- One asset identity, three separate facts:
--   * what it physically IS: machines.type (src/lib/machine-options.ts);
--   * how it is MANAGED and BILLED: machines.profile, 'full' or 'equipment' (new here);
--   * where it is in its life: machines.status (unchanged).
-- Renaming an asset, parking it or not using its trips does not change what it may be.
--
-- == Who may take the equipment profile =======================================
-- app.equipment_eligible(type) is the one SQL answer, mirrored by
-- EQUIPMENT_ELIGIBLE_TYPES in src/lib/machine-options.ts (a test reads this file and
-- keeps the two lists equal). Eligible: pumps and generators, compressors, workshop tools,
-- unpowered attachments (implements), trailers, and other equipment that is not
-- self-propelled. Never: cars, bakkies, trucks, truck tractors, tractors, harvesters,
-- forklifts, earthmoving plant, buses, minibuses, game viewers, motorcycles, boats, ATVs.
-- Every value of machine_type is classified; an unclassified one answers null, which
-- equipment_profile.sql fails on, so a new type cannot arrive without a decision.
-- There is no purchase-value, size or power rule (decision 4).
--
-- == Existing assets ===========================================================
-- Every existing row becomes 'full' through the column default and nothing reclassifies
-- or reprices it (BRIEF section 24). public.equipment_profile_candidates lists the
-- assets that COULD move, read-only, for the owner or Rapid Rise to look at.
--
-- == Changing the profile =======================================================
-- Only the conversion function (20261114090300) may change it, after a priced preview.
-- A browser or the service key updating machines.profile directly is refused, and so is
-- giving an equipment asset a type that may not hold the profile (a trailer renamed to a
-- truck stays a vehicle that must convert first).
--
-- == Unusual items ===============================================================
-- asset_classification_reviews: an owner or manager may ask Rapid Rise to look at an
-- asset's classification, and an asset of type other_equipment on the equipment profile
-- opens a review by itself. Ordinary equipment needs no approval (decision 5); a review
-- never bills, converts or rejects anything automatically, and nothing is decided from a
-- photograph.
--
-- Safe on live data: the column is added with a constant default (no table rewrite), every
-- existing asset is 'full', and no price, quota or access changes for anybody.

-- == The profile =================================================================
do $$
begin
  if not exists (select 1 from pg_type t where t.typname = 'asset_profile' and t.typnamespace = 'public'::regnamespace) then
    create type public.asset_profile as enum ('full', 'equipment');
  end if;
end $$;

alter table public.machines add column if not exists profile public.asset_profile not null default 'full';
comment on column public.machines.profile is
  'Management and billing profile (20261114090100): full = a full-priced fleet space; '
  'equipment = maintenance-focused support equipment, counted against the plan''s included '
  'equipment and extra equipment spaces. Changed only by public.convert_asset_profile.';
grant select (profile) on public.machines to authenticated;
create index if not exists machines_farm_profile_idx on public.machines (farm_id, profile) where deleted_at is null;

-- == Eligibility, one answer ======================================================
create or replace function app.equipment_eligible(p_type public.machine_type)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_type::text
    when 'pump_generator'  then true
    when 'compressor'      then true
    when 'workshop_tool'   then true
    when 'implement'       then true
    when 'trailer'         then true
    when 'other_equipment' then true
    when 'tractor'         then false
    when 'harvester'       then false
    when 'bakkie'          then false
    when 'truck'           then false
    when 'atv_other'       then false
    when 'car'             then false
    when 'van'             then false
    when 'minibus'         then false
    when 'bus'             then false
    when 'game_viewer'     then false
    when 'truck_tractor'   then false
    when 'motorcycle'      then false
    when 'forklift'        then false
    when 'earthmoving'     then false
    when 'boat'            then false
    else null
  end;
$$;
revoke all on function app.equipment_eligible(public.machine_type) from public, anon;
grant execute on function app.equipment_eligible(public.machine_type) to authenticated, service_role;
comment on function app.equipment_eligible(public.machine_type) is
  'May an asset of this type take the equipment profile (20261114090100)? Mirrored by '
  'EQUIPMENT_ELIGIBLE_TYPES in src/lib/machine-options.ts. Null = a type nobody classified.';

-- == The guard on machines ==========================================================
-- SECURITY INVOKER on purpose: it reads current_user to tell a browser or the service key
-- (refused) from the conversion function, which runs as its owner.
create or replace function app.machines_profile_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.profile is distinct from old.profile
     and current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'EQUIPMENT: change the profile through its preview'
      using errcode = '42501', hint = 'equipment-convert-through-preview';
  end if;
  if new.profile = 'equipment' and not coalesce(app.equipment_eligible(new.type), false) then
    raise exception 'EQUIPMENT: a % cannot use the equipment profile', new.type
      using errcode = '22023', hint = 'equipment-type-not-eligible';
  end if;
  return new;
end
$$;
revoke all on function app.machines_profile_guard() from public, anon, authenticated;

drop trigger if exists machines_profile_guard on public.machines;
create trigger machines_profile_guard
  before insert or update of profile, type on public.machines
  for each row execute function app.machines_profile_guard();

-- == Unusual classifications: a review list for Rapid Rise ===========================
create table if not exists public.asset_classification_reviews (
  id             uuid primary key default gen_random_uuid(),
  farm_id        uuid not null references public.farms(id),
  machine_id     uuid not null,
  source         text not null default 'owner' check (source in ('owner', 'automatic')),
  reason         text not null check (length(btrim(reason)) between 1 and 500),
  status         text not null default 'open' check (status in ('open', 'confirmed', 'declined')),
  requested_by   uuid references public.users(id) on delete set null,
  requested_at   timestamptz not null default now(),
  decided_by     uuid references public.users(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text check (decision_note is null or length(decision_note) <= 500),
  constraint asset_classification_reviews_machine_fk foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  constraint asset_classification_reviews_decided_ck check ((status = 'open') = (decided_at is null))
);
create unique index if not exists asset_classification_reviews_one_open
  on public.asset_classification_reviews (machine_id) where status = 'open';
create index if not exists asset_classification_reviews_open_idx
  on public.asset_classification_reviews (requested_at) where status = 'open';
comment on table public.asset_classification_reviews is
  'Asks Rapid Rise to look at how an asset is classified (20261114090100). Never bills, '
  'converts or rejects anything by itself; at most one open review per asset.';

-- Owners and managers of the asset's business, and Rapid Rise.
create or replace function app.asset_profile_manager(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_rr_admin() or coalesce(app.effective_farm_role(auth.uid(), p_farm)::text, '') in ('owner', 'manager');
$$;
revoke all on function app.asset_profile_manager(uuid) from public, anon;
grant execute on function app.asset_profile_manager(uuid) to authenticated, service_role;

alter table public.asset_classification_reviews enable row level security;
alter table public.asset_classification_reviews force row level security;
drop policy if exists asset_classification_reviews_sel on public.asset_classification_reviews;
create policy asset_classification_reviews_sel on public.asset_classification_reviews
  for select to authenticated using ((select app.asset_profile_manager(farm_id)));
revoke all on public.asset_classification_reviews from public, anon, authenticated;
grant select on public.asset_classification_reviews to authenticated;
grant all on public.asset_classification_reviews to service_role;
select app.pay_gate_apply('asset_classification_reviews');

drop trigger if exists asset_classification_reviews_audit on public.asset_classification_reviews;
create trigger asset_classification_reviews_audit after insert or update or delete on public.asset_classification_reviews
  for each row execute function public.app_audit();
insert into app.audit_table_rules (table_name, scope, reason) values
  ('asset_classification_reviews', 'farm', 'a request for Rapid Rise to check how an asset is classified, and the answer')
on conflict (table_name) do nothing;

-- An asset of type other_equipment taking the equipment profile is looked at by a person.
create or replace function app.machines_auto_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.profile = 'equipment' and new.type::text = 'other_equipment' and new.deleted_at is null
     and (tg_op = 'INSERT' or old.profile is distinct from new.profile or old.type is distinct from new.type)
     and not exists (select 1 from public.asset_classification_reviews r
                      where r.machine_id = new.id and r.status = 'open') then
    insert into public.asset_classification_reviews (farm_id, machine_id, source, reason, requested_by)
    values (new.farm_id, new.id, 'automatic', 'Other equipment on the equipment profile', auth.uid());
  end if;
  return new;
end
$$;
revoke all on function app.machines_auto_review() from public, anon, authenticated;

drop trigger if exists machines_auto_review on public.machines;
create trigger machines_auto_review
  after insert or update of profile, type on public.machines
  for each row execute function app.machines_auto_review();

-- An owner or manager asks. Returns the open review (an existing one is reused).
create or replace function public.request_asset_classification_review(p_machine uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_farm uuid;
  v_id uuid;
begin
  select m.farm_id into v_farm from public.machines m where m.id = p_machine and m.deleted_at is null;
  if v_farm is null or not app.asset_profile_manager(v_farm) or auth.uid() is null then
    raise exception 'EQUIPMENT: not your asset' using errcode = '42501';
  end if;
  perform app.require_open_farm(v_farm, true);
  if coalesce(length(btrim(p_reason)), 0) not between 1 and 500 then
    raise exception 'EQUIPMENT: say what is unusual about it' using errcode = '22023', hint = 'equipment-review-reason';
  end if;
  select r.id into v_id from public.asset_classification_reviews r where r.machine_id = p_machine and r.status = 'open';
  if v_id is not null then return v_id; end if;
  insert into public.asset_classification_reviews (farm_id, machine_id, source, reason, requested_by)
  values (v_farm, p_machine, 'owner', btrim(p_reason), auth.uid())
  returning id into v_id;
  return v_id;
end
$$;
revoke all on function public.request_asset_classification_review(uuid, text) from public, anon;
grant execute on function public.request_asset_classification_review(uuid, text) to authenticated;

-- Rapid Rise answers. The answer is a record for the conversation with the customer; it
-- changes no profile and no bill.
create or replace function public.decide_asset_classification_review(p_review uuid, p_status text, p_note text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.is_rr_admin() then
    raise exception 'Rapid Rise only' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('confirmed', 'declined') then
    raise exception 'EQUIPMENT: confirmed or declined' using errcode = '22023';
  end if;
  update public.asset_classification_reviews
     set status = p_status, decided_by = auth.uid(), decided_at = now(),
         decision_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_review and status = 'open';
  if not found then
    raise exception 'EQUIPMENT: no open review' using errcode = '22023';
  end if;
end
$$;
revoke all on function public.decide_asset_classification_review(uuid, text, text) from public, anon;
grant execute on function public.decide_asset_classification_review(uuid, text, text) to authenticated;

-- == The read-only migration preview: which full assets COULD be equipment ===========
-- For one business (its owners and managers) or, with no business, every business
-- (Rapid Rise). Lists; changes nothing (BRIEF section 24).
create or replace function public.equipment_profile_candidates(p_farm uuid default null)
returns table (farm_id uuid, machine_id uuid, name text, type public.machine_type, status public.machine_status)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_farm is null then
    if not app.is_rr_admin() then
      raise exception 'Rapid Rise only' using errcode = '42501';
    end if;
  else
    if not app.asset_profile_manager(p_farm) then
      raise exception 'EQUIPMENT: not your business' using errcode = '42501';
    end if;
    perform app.require_open_farm(p_farm, false);
  end if;
  return query
    select m.farm_id, m.id, m.name, m.type, m.status
      from public.machines m
     where m.deleted_at is null
       and m.profile = 'full'
       and m.status not in ('retired', 'sold')
       and coalesce(app.equipment_eligible(m.type), false)
       and (p_farm is null or m.farm_id = p_farm)
     order by m.farm_id, m.name;
end
$$;
revoke all on function public.equipment_profile_candidates(uuid) from public, anon;
grant execute on function public.equipment_profile_candidates(uuid) to authenticated;
