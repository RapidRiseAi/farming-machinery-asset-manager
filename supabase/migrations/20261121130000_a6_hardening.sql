-- 20261121130000_a6_hardening.sql
-- Task A6 (security read): a vehicle moves only between sites of the same customer.
--
-- public.move_machine_to_site (20261114090400) let an owner or manager who runs two sites move a
-- vehicle between them even when the sites belong to different customers, which silently moved
-- the vehicle's space to the other customer's bill. The function is unchanged except for one check:
-- both sites must share a billing root (app.billing_root). Moving to another business stays the
-- handover flow (20261107110000). Forward-only: the function is re-created, nothing is dropped,
-- and its signature and grants are the same.

create or replace function public.move_machine_to_site(p_machine uuid, p_to uuid, p_by uuid)
returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  m     public.machines%rowtype;
  v_new uuid;
begin
  select * into m from public.machines where id = p_machine and deleted_at is null for update;
  if not found then raise exception 'no such vehicle' using errcode = 'P0002'; end if;
  if m.farm_id = p_to then raise exception 'it is already there' using errcode = '22023'; end if;
  if m.moved_to_machine_id is not null or m.status in ('retired', 'sold') then
    raise exception 'this vehicle has left this site' using errcode = '22023';
  end if;
  if coalesce(app.role_on_farm(p_by, m.farm_id), '') not in ('owner', 'manager')
     or coalesce(app.role_on_farm(p_by, p_to), '') not in ('owner', 'manager') then
    raise exception 'you need to run both sites to move a vehicle' using errcode = '42501';
  end if;
  -- A move stays inside one customer (A6, register R-032). Another customer's site is a handover,
  -- which is explicit and priced on both sides; a move would quietly change who pays for it.
  if app.billing_root(m.farm_id) is distinct from app.billing_root(p_to) then
    raise exception 'machine-move-other-customer' using errcode = '22023';
  end if;

  -- The sticker stays on the vehicle, so its token goes with it; the old record gets a new one
  -- and stops counting towards this site's slots.
  update public.machines
     set public_token = gen_random_uuid(), status = 'retired', assigned_operator_id = null
   where id = p_machine;

  insert into public.machines (
    farm_id, public_token, name, type, make, model, year, serial_no, reg_no, meter_type, status,
    current_reading, current_reading_date, purchase_date, supplier, warranty_expiry_date,
    warranty_expiry_hours, notes, previous_machine_id, profile
  ) values (
    p_to, m.public_token, m.name, m.type, m.make, m.model, m.year, m.serial_no, m.reg_no, m.meter_type, m.status,
    m.current_reading, m.current_reading_date, m.purchase_date, m.supplier, m.warranty_expiry_date,
    m.warranty_expiry_hours, m.notes, m.id, m.profile
  ) returning id into v_new;

  update public.machines set moved_to_machine_id = v_new where id = p_machine;

  insert into public.service_plan_lines (farm_id, machine_id, task, interval_hours, interval_months,
                                         last_done_reading, last_done_date, next_due_reading, next_due_date, status)
  select p_to, v_new, l.task, l.interval_hours, l.interval_months,
         l.last_done_reading, l.last_done_date, l.next_due_reading, l.next_due_date, l.status
    from public.service_plan_lines l
   where l.machine_id = p_machine and l.deleted_at is null;

  insert into public.licences (farm_id, machine_id, type, number, expiry_date, reminder_lead_days, notes, created_by)
  select p_to, v_new, l.type, l.number, l.expiry_date, l.reminder_lead_days, l.notes, p_by
    from public.licences l
   where l.machine_id = p_machine and l.deleted_at is null;

  return v_new;
end $$;
revoke all on function public.move_machine_to_site(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.move_machine_to_site(uuid, uuid, uuid) to service_role;
