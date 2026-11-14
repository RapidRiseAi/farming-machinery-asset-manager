\set ON_ERROR_STOP on
-- The Support Equipment profile: who may take it, who may change it, and the review list
-- for unusual items (20261114090100).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.as_user(p uuid, p_aal text default 'aal1') returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;

-- Every type is classified, so a new one cannot arrive without a decision.
do $t$
declare v text;
begin
  select string_agg(e.enumlabel, ', ') into v
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'machine_type' and app.equipment_eligible(e.enumlabel::public.machine_type) is null;
  if v is not null then raise exception 'machine types nobody classified for the equipment profile: %', v; end if;
  if app.equipment_eligible('truck') or app.equipment_eligible('tractor') or app.equipment_eligible('forklift')
     or app.equipment_eligible('bakkie') or app.equipment_eligible('car') or app.equipment_eligible('harvester') then
    raise exception 'a self-propelled vehicle may take the equipment profile';
  end if;
  if not (app.equipment_eligible('pump_generator') and app.equipment_eligible('compressor')
          and app.equipment_eligible('workshop_tool') and app.equipment_eligible('implement')
          and app.equipment_eligible('trailer') and app.equipment_eligible('other_equipment')) then
    raise exception 'an eligible kind of equipment is refused';
  end if;
end $t$;

insert into public.farms (id, name, plan, status, billing_period) values
  ('ea100000-0000-4000-9000-000000000001', 'Pumps and Co', 'essential', 'active', 'monthly'),
  ('ea100000-0000-4000-9000-000000000002', 'Elsewhere', 'essential', 'active', 'monthly');
insert into auth.users (id, email) values
  ('ea110000-0000-4000-9000-000000000001', 'owner@equip.test'),
  ('ea110000-0000-4000-9000-000000000002', 'operator@equip.test'),
  ('ea110000-0000-4000-9000-000000000003', 'rival@equip.test'),
  ('ea110000-0000-4000-9000-000000000004', 'staff@equip.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('ea110000-0000-4000-9000-000000000001', 'ea100000-0000-4000-9000-000000000001', null, 'owner', 'Owner', 'owner@equip.test', true),
  ('ea110000-0000-4000-9000-000000000002', 'ea100000-0000-4000-9000-000000000001', null, 'operator', 'Operator', 'operator@equip.test', true),
  ('ea110000-0000-4000-9000-000000000003', 'ea100000-0000-4000-9000-000000000002', null, 'owner', 'Rival', 'rival@equip.test', true),
  ('ea110000-0000-4000-9000-000000000004', null, null, 'rr_admin', 'Staff', 'staff@equip.test', true);

-- An asset that existed before is a full one; nothing moved it.
insert into public.machines (id, farm_id, name, type) values
  ('ea120000-0000-4000-9000-000000000001', 'ea100000-0000-4000-9000-000000000001', 'Old pump', 'pump_generator'),
  ('ea120000-0000-4000-9000-000000000002', 'ea100000-0000-4000-9000-000000000001', 'Bakkie', 'bakkie'),
  ('ea120000-0000-4000-9000-000000000009', 'ea100000-0000-4000-9000-000000000002', 'Rival pump', 'pump_generator');
do $t$ begin
  if exists (select 1 from public.machines where profile <> 'full') then
    raise exception 'an existing asset did not default to the full profile';
  end if;
end $t$;

select pg_temp.as_user('ea110000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$ begin
  -- Eligible kinds take the profile at once, no approval needed.
  insert into public.machines (id, farm_id, name, type, profile) values
    ('ea120000-0000-4000-9000-000000000003', 'ea100000-0000-4000-9000-000000000001', 'Compressor', 'compressor', 'equipment'),
    ('ea120000-0000-4000-9000-000000000004', 'ea100000-0000-4000-9000-000000000001', 'Trailer', 'trailer', 'equipment');
  if (select count(*) from public.asset_classification_reviews) <> 0 then
    raise exception 'ordinary equipment was sent for review';
  end if;

  -- A vehicle cannot, however it is described.
  begin
    insert into public.machines (farm_id, name, type, profile) values
      ('ea100000-0000-4000-9000-000000000001', 'Cheap truck', 'truck', 'equipment');
    raise exception 'a truck took the equipment profile';
  exception when invalid_parameter_value then
    if sqlerrm <> 'equipment-type-not-eligible' then raise; end if;
  end;

  -- Renaming the trailer a truck keeps it a vehicle that must convert first.
  begin
    update public.machines set type = 'truck' where id = 'ea120000-0000-4000-9000-000000000004';
    raise exception 'an equipment trailer became an equipment truck';
  exception when invalid_parameter_value then null;
  end;
  update public.machines set name = 'Flatbed trailer' where id = 'ea120000-0000-4000-9000-000000000004';

  -- The profile itself changes only through the priced conversion.
  begin
    update public.machines set profile = 'equipment' where id = 'ea120000-0000-4000-9000-000000000001';
    raise exception 'a browser changed an asset''s profile directly';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.machines set profile = 'full' where id = 'ea120000-0000-4000-9000-000000000003';
    raise exception 'a browser changed an asset''s profile directly';
  exception when insufficient_privilege then null;
  end;

  -- Other equipment opens a review by itself; it still works meanwhile.
  insert into public.machines (id, farm_id, name, type, profile) values
    ('ea120000-0000-4000-9000-000000000005', 'ea100000-0000-4000-9000-000000000001', 'Welder rig', 'other_equipment', 'equipment');
  if (select count(*) from public.asset_classification_reviews
       where machine_id = 'ea120000-0000-4000-9000-000000000005' and source = 'automatic' and status = 'open') <> 1 then
    raise exception 'other equipment did not open a review';
  end if;

  -- The owner may ask about any asset; asking twice reuses the open review.
  if public.request_asset_classification_review('ea120000-0000-4000-9000-000000000001', 'It is a borehole pump on a skid')
     <> public.request_asset_classification_review('ea120000-0000-4000-9000-000000000001', 'again') then
    raise exception 'a second request opened a second review';
  end if;
  begin
    perform public.request_asset_classification_review('ea120000-0000-4000-9000-000000000002', '   ');
    raise exception 'a review was asked for with no reason';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.request_asset_classification_review('ea120000-0000-4000-9000-000000000009', 'not mine');
    raise exception 'an owner asked about another business''s asset';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.decide_asset_classification_review(
      (select id from public.asset_classification_reviews where machine_id = 'ea120000-0000-4000-9000-000000000005'), 'confirmed', null);
    raise exception 'an owner decided their own review';
  exception when insufficient_privilege then null;
  end;

  -- The read-only preview lists the old pump, not the bakkie and not what is already equipment.
  if (select array_agg(machine_id::text order by name) from public.equipment_profile_candidates('ea100000-0000-4000-9000-000000000001'))
     <> array['ea120000-0000-4000-9000-000000000001'] then
    raise exception 'the migration preview listed the wrong assets';
  end if;
  begin
    perform public.equipment_profile_candidates(null);
    raise exception 'an owner listed every business''s candidates';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.equipment_profile_candidates('ea100000-0000-4000-9000-000000000002');
    raise exception 'an owner listed another business''s assets';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

-- An operator neither asks nor sees the list; a stranger sees nothing.
select pg_temp.as_user('ea110000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.asset_classification_reviews) <> 0 then
    raise exception 'an operator can read the review list';
  end if;
  begin
    perform public.request_asset_classification_review('ea120000-0000-4000-9000-000000000001', 'odd');
    raise exception 'an operator asked for a review';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

select pg_temp.as_user('ea110000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if (select count(*) from public.asset_classification_reviews) <> 0 then
    raise exception 'another business can read this review list';
  end if;
end $t$;
reset role;

-- Rapid Rise, with its second factor, answers; the answer changes no profile.
select pg_temp.as_user('ea110000-0000-4000-9000-000000000004', 'aal2');
set local role authenticated;
do $t$
declare v_review uuid;
begin
  if (select count(*) from public.equipment_profile_candidates(null)) < 2 then
    raise exception 'Rapid Rise does not see every business''s candidates';
  end if;
  select id into v_review from public.asset_classification_reviews where machine_id = 'ea120000-0000-4000-9000-000000000005';
  perform public.decide_asset_classification_review(v_review, 'declined', 'Looks like a vehicle; talk to the customer');
  if (select status from public.asset_classification_reviews where id = v_review) <> 'declined' then
    raise exception 'the decision was not recorded';
  end if;
  begin
    perform public.decide_asset_classification_review(v_review, 'confirmed', null);
    raise exception 'a closed review was decided again';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.decide_asset_classification_review(
      (select id from public.asset_classification_reviews where status = 'open' limit 1), 'maybe', null);
    raise exception 'a review was given a made-up answer';
  exception when invalid_parameter_value then null;
  end;
end $t$;
reset role;
do $t$ begin
  if (select profile from public.machines where id = 'ea120000-0000-4000-9000-000000000005') <> 'equipment' then
    raise exception 'a review decision changed the asset''s profile';
  end if;
end $t$;

-- The service key cannot change a profile directly either.
set local role service_role;
do $t$
declare v_rows integer;
begin
  begin
    update public.machines set profile = 'equipment' where id = 'ea120000-0000-4000-9000-000000000001';
    get diagnostics v_rows = row_count;
    -- PGlite does not honour BYPASSRLS, so there the row is simply not reached.
    if v_rows > 0 then raise exception 'the service key changed a profile without the conversion'; end if;
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

rollback;
