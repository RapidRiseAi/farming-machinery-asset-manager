\set ON_ERROR_STOP on
-- Handing over a business, and moving a vehicle between sites (20261107110000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period, billing_email) values
  ('e7000000-0000-4000-9000-000000000001', 'Site A', 'complete', 'active', 'monthly', 'old@handover.test'),
  ('e7000000-0000-4000-9000-000000000002', 'Site B', 'complete', 'active', 'monthly', 'old@handover.test'),
  ('e7000000-0000-4000-9000-000000000003', 'Stranger', 'complete', 'active', 'monthly', 'x@handover.test');
insert into auth.users (id, email) values
  ('e7100000-0000-4000-9000-000000000001', 'old@handover.test'),
  ('e7100000-0000-4000-9000-000000000002', 'new@handover.test'),
  ('e7100000-0000-4000-9000-000000000003', 'other@handover.test'),
  ('e7100000-0000-4000-9000-000000000004', 'outsider@handover.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('e7100000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 'owner', 'Old', 'old@handover.test', true),
  ('e7100000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001', 'manager', 'New', 'new@handover.test', true),
  ('e7100000-0000-4000-9000-000000000003', 'e7000000-0000-4000-9000-000000000001', 'operator', 'Other', 'other@handover.test', true),
  ('e7100000-0000-4000-9000-000000000004', 'e7000000-0000-4000-9000-000000000003', 'owner', 'Outsider', 'outsider@handover.test', true);
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('e7100000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 'owner', true),
  ('e7100000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000002', 'owner', true),
  ('e7100000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000001', 'manager', true),
  ('e7100000-0000-4000-9000-000000000003', 'e7000000-0000-4000-9000-000000000001', 'operator', true)
on conflict (user_id, farm_id) do update set role = excluded.role, active = true;

do $t$
declare
  a constant uuid := 'e7000000-0000-4000-9000-000000000001';
  old_owner constant uuid := 'e7100000-0000-4000-9000-000000000001';
  new_owner constant uuid := 'e7100000-0000-4000-9000-000000000002';
  other constant uuid := 'e7100000-0000-4000-9000-000000000003';
  outsider constant uuid := 'e7100000-0000-4000-9000-000000000004';
  v uuid;
begin
  -- Only the owner can offer, and only to their own team.
  begin
    perform public.offer_ownership(a, new_owner, other);
    raise exception 'a manager offered the business';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.offer_ownership(a, old_owner, outsider);
    raise exception 'a stranger was offered the business';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.offer_ownership(a, old_owner, old_owner);
    raise exception 'an owner offered it to themselves';
  exception when invalid_parameter_value then null;
  end;

  v := public.offer_ownership(a, old_owner, new_owner);

  -- Nothing has changed yet, and nobody but the person named can accept.
  if app.effective_farm_role(old_owner, a)::text <> 'owner' then raise exception 'an offer changed the owner'; end if;
  begin
    perform public.accept_ownership(v, other);
    raise exception 'the wrong person accepted';
  exception when insufficient_privilege then null;
  end;

  -- A newer offer replaces the last.
  perform public.offer_ownership(a, old_owner, other);
  if (select status from public.farm_ownership_transfers where id = v) <> 'cancelled' then
    raise exception 'the old offer stayed open';
  end if;
  begin
    perform public.accept_ownership(v, new_owner);
    raise exception 'a cancelled offer was accepted';
  exception when invalid_parameter_value then null;
  end;

  v := public.offer_ownership(a, old_owner, new_owner);
  if public.accept_ownership(v, new_owner) <> a then raise exception 'accept returned the wrong account'; end if;

  if app.effective_farm_role(new_owner, a)::text <> 'owner' then raise exception 'the new owner is not the owner'; end if;
  if app.effective_farm_role(old_owner, a)::text <> 'manager' then raise exception 'the old owner did not step down'; end if;
  if (select role from public.users where id = new_owner)::text <> 'owner' then raise exception 'the profile role was not moved'; end if;
  if (select billing_email from public.farms where id = a) <> 'new@handover.test' then raise exception 'the bills still go to the old owner'; end if;

  -- The old owner's other site is theirs still.
  if app.effective_farm_role(old_owner, 'e7000000-0000-4000-9000-000000000002')::text <> 'owner' then
    raise exception 'the handover reached another site';
  end if;

  -- Accepting twice does nothing.
  begin
    perform public.accept_ownership(v, new_owner);
    raise exception 'an offer was accepted twice';
  exception when invalid_parameter_value then null;
  end;
end $t$;

-- Moving a vehicle. The manager runs site A now; give them site B too.
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('e7100000-0000-4000-9000-000000000002', 'e7000000-0000-4000-9000-000000000002', 'manager', true)
on conflict (user_id, farm_id) do update set role = excluded.role, active = true;
insert into public.machines (id, farm_id, name, type, serial_no, reg_no, meter_type, current_reading, purchase_price_cents) values
  ('e7200000-0000-4000-9000-000000000001', 'e7000000-0000-4000-9000-000000000001', 'Truck 1', 'truck', 'VIN1', 'ABC 123', 'km', 1000, 500000);
insert into public.service_plan_lines (farm_id, machine_id, task, interval_hours) values
  ('e7000000-0000-4000-9000-000000000001', 'e7200000-0000-4000-9000-000000000001', 'Oil', 10000);
insert into public.licences (farm_id, machine_id, type, number, expiry_date) values
  ('e7000000-0000-4000-9000-000000000001', 'e7200000-0000-4000-9000-000000000001', 'cof', 'COF-1', current_date + 90);
insert into public.faults (farm_id, machine_id, description) values
  ('e7000000-0000-4000-9000-000000000001', 'e7200000-0000-4000-9000-000000000001', 'Old fault');

do $t$
declare
  truck constant uuid := 'e7200000-0000-4000-9000-000000000001';
  b constant uuid := 'e7000000-0000-4000-9000-000000000002';
  mover constant uuid := 'e7100000-0000-4000-9000-000000000002';
  v_token uuid := (select public_token from public.machines where id = truck);
  v_new uuid;
begin
  -- You must run both ends.
  begin
    perform public.move_machine_to_site(truck, 'e7000000-0000-4000-9000-000000000003', mover);
    raise exception 'a vehicle was moved to a stranger';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.move_machine_to_site(truck, b, 'e7100000-0000-4000-9000-000000000003');
    raise exception 'a driver moved a vehicle';
  exception when insufficient_privilege then null;
  end;

  v_new := public.move_machine_to_site(truck, b, mover);

  if not exists (select 1 from public.machines where id = v_new and farm_id = b and public_token = v_token
                   and serial_no = 'VIN1' and current_reading = 1000 and previous_machine_id = truck) then
    raise exception 'the new record is wrong';
  end if;
  if (select status from public.machines where id = truck)::text <> 'retired'
     or (select moved_to_machine_id from public.machines where id = truck) <> v_new
     or (select public_token from public.machines where id = truck) = v_token then
    raise exception 'the old record is wrong';
  end if;
  -- History stays where it happened; the plan and licence come along.
  if not exists (select 1 from public.faults where machine_id = truck) then raise exception 'history moved'; end if;
  if not exists (select 1 from public.service_plan_lines where machine_id = v_new and task = 'Oil') then raise exception 'the service plan stayed behind'; end if;
  if not exists (select 1 from public.licences where machine_id = v_new and number = 'COF-1') then raise exception 'the licence stayed behind'; end if;
  -- Money stays where it was booked.
  if (select purchase_price_cents from public.machines where id = v_new) is not null then raise exception 'a cost was copied'; end if;

  begin
    perform public.move_machine_to_site(truck, b, mover);
    raise exception 'a vehicle moved twice';
  exception when invalid_parameter_value then null;
  end;
end $t$;

do $t$
begin
  if has_function_privilege('authenticated', 'public.accept_ownership(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.move_machine_to_site(uuid,uuid,uuid)', 'EXECUTE') then
    raise exception 'these are for the server alone';
  end if;
end $t$;

rollback;
