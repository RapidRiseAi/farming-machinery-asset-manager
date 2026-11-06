-- 20261107090000_company_types.sql
-- FLEETWISE is for any fleet, not only farms (founder decision, 6 November 2026).
--
-- A business says what kind it is at sign-up, and that decides the words on every screen, the
-- vehicle types offered and which modules start on. Until it is known, the wording is
-- universal. The table keeps its name: `farms` is what an account is called in the code, and
-- no customer ever reads that.
--
-- Vehicle, licence and credential types are added for the businesses this opens up.

alter table public.farms
  add column if not exists company_type text not null default 'other';

alter table public.farms drop constraint if exists farms_company_type_ck;
alter table public.farms add constraint farms_company_type_ck check (company_type in (
  'farm', 'game_drive', 'goods_transport', 'delivery', 'passenger_transport', 'construction', 'other'
));

alter type public.machine_type add value if not exists 'car';
alter type public.machine_type add value if not exists 'van';
alter type public.machine_type add value if not exists 'minibus';
alter type public.machine_type add value if not exists 'bus';
alter type public.machine_type add value if not exists 'game_viewer';
alter type public.machine_type add value if not exists 'truck_tractor';
alter type public.machine_type add value if not exists 'trailer';
alter type public.machine_type add value if not exists 'motorcycle';
alter type public.machine_type add value if not exists 'forklift';
alter type public.machine_type add value if not exists 'earthmoving';
alter type public.machine_type add value if not exists 'boat';

-- What South African operators are audited on (docs/CORPORATE_FLEET_ROADMAP.md, item 1).
alter type public.licence_type add value if not exists 'cof';
alter type public.licence_type add value if not exists 'operator_card';
alter type public.licence_type add value if not exists 'dangerous_goods';
alter type public.licence_type add value if not exists 'abnormal_load';
alter type public.licence_type add value if not exists 'operating_licence';

alter type public.driver_credential_type add value if not exists 'dangerous_goods_training';
alter type public.driver_credential_type add value if not exists 'first_aid';
alter type public.driver_credential_type add value if not exists 'guide_qualification';

-- `farms_upd` is Rapid Rise's alone, because the row carries the plan, so an owner changes
-- this through something that can touch nothing else, as with billing details (0410).
create or replace function public.set_company_type(p_farm uuid, p_type text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(app.effective_farm_role(auth.uid(), p_farm)::text, '') not in ('owner', 'manager') then
    raise exception 'only the owner or a manager can change this' using errcode = '42501';
  end if;
  update public.farms set company_type = p_type where id = p_farm;
end $$;

revoke all on function public.set_company_type(uuid, text) from public, anon;
grant execute on function public.set_company_type(uuid, text) to authenticated, service_role;
