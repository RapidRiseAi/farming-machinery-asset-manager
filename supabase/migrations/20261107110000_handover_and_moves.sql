-- 20261107110000_handover_and_moves.sql
-- Handing a business to a new owner, and moving a vehicle between your own sites (H8).
--
-- == Handover ==================================================================
-- The owner offers it to somebody on the team, and only that person can accept: the new owner
-- takes on the bill, so it cannot be put on them. On acceptance they become the owner and the
-- old owner a manager. The server then takes the old owner's card off the account, or the next
-- renewal would charge somebody who no longer runs the business.
--
-- == Moving a vehicle ==========================================================
-- A vehicle's history points at things that stay behind: fuel tanks, stores, budgets, people.
-- So nothing is rewritten. The vehicle starts a new record at the new site, linked both ways
-- to the old one, which is kept as its history. Its service plan and licences come with it,
-- and so does its QR sticker. Cost and finance figures stay where they were booked.
--
-- All of this is called by the server after its own checks, so the role guards on `users` and
-- `machines`, which trust a call with no session, let it through; each function checks the
-- person it is told about.

alter table public.machines
  add column if not exists previous_machine_id uuid references public.machines(id) on delete set null,
  add column if not exists moved_to_machine_id uuid references public.machines(id) on delete set null;

grant select (previous_machine_id, moved_to_machine_id) on public.machines to authenticated;

create table if not exists public.farm_ownership_transfers (
  id         uuid primary key default gen_random_uuid(),
  farm_id    uuid not null references public.farms(id),
  from_user  uuid not null references public.users(id),
  to_user    uuid not null references public.users(id),
  status     text not null default 'pending',
  expires_at timestamptz not null default now() + interval '14 days',
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint farm_ownership_transfers_status_ck check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  constraint farm_ownership_transfers_people_ck check (from_user <> to_user)
);

create unique index if not exists farm_ownership_transfers_one_open_idx
  on public.farm_ownership_transfers (farm_id) where status = 'pending';

alter table public.farm_ownership_transfers enable row level security;
alter table public.farm_ownership_transfers force row level security;

create policy farm_ownership_transfers_sel on public.farm_ownership_transfers for select to authenticated
  using (app.is_rr_admin() or from_user = auth.uid() or to_user = auth.uid());

revoke all on public.farm_ownership_transfers from public, anon, authenticated;
grant select on public.farm_ownership_transfers to authenticated;
grant all on public.farm_ownership_transfers to service_role;

create trigger farm_ownership_transfers_audit
  after insert or update or delete on public.farm_ownership_transfers
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('farm_ownership_transfers', 'farm', 'who was offered the business, and what they answered')
on conflict (table_name) do nothing;

create or replace function public.offer_ownership(p_farm uuid, p_from uuid, p_to uuid)
returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v_id uuid;
begin
  if app.effective_farm_role(p_from, p_farm)::text is distinct from 'owner' then
    raise exception 'only the owner can hand over the business' using errcode = '42501';
  end if;
  if p_from = p_to then
    raise exception 'you already own this' using errcode = '22023';
  end if;
  if app.effective_farm_role(p_to, p_farm) is null
     or not exists (select 1 from public.users u where u.id = p_to and u.active and u.deleted_at is null) then
    raise exception 'that person is not on the team' using errcode = '22023';
  end if;

  update public.farm_ownership_transfers set status = 'cancelled', decided_at = now()
   where farm_id = p_farm and status = 'pending';

  insert into public.farm_ownership_transfers (farm_id, from_user, to_user)
  values (p_farm, p_from, p_to) returning id into v_id;
  return v_id;
end $$;

create or replace function public.accept_ownership(p_transfer uuid, p_by uuid)
returns uuid
language plpgsql set search_path = public, pg_temp as $$
declare
  v public.farm_ownership_transfers%rowtype;
begin
  select * into v from public.farm_ownership_transfers where id = p_transfer for update;
  if not found or v.to_user <> p_by then
    raise exception 'this offer is not for you' using errcode = '42501';
  end if;
  if v.status <> 'pending' or v.expires_at <= now() then
    raise exception 'this offer has ended' using errcode = '22023';
  end if;
  -- It may have sat for days: the person offering must still be the one who can give it.
  if app.effective_farm_role(v.from_user, v.farm_id)::text is distinct from 'owner' then
    raise exception 'this offer has ended' using errcode = '22023';
  end if;

  insert into public.user_farm_memberships (user_id, farm_id, role, active)
  values (v.to_user, v.farm_id, 'owner', true), (v.from_user, v.farm_id, 'manager', true)
  on conflict (user_id, farm_id) do update
    set role = excluded.role, active = true, deleted_at = null, deleted_by = null;

  update public.users set role = 'owner' where id = v.to_user and farm_id = v.farm_id;
  update public.users set role = 'manager' where id = v.from_user and farm_id = v.farm_id;

  update public.farms f set billing_email = u.email
    from public.users u where u.id = v.to_user and f.id = v.farm_id;

  update public.farm_ownership_transfers set status = 'accepted', decided_at = now() where id = v.id;
  return v.farm_id;
end $$;

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
  if coalesce(app.effective_farm_role(p_by, m.farm_id)::text, '') not in ('owner', 'manager')
     or coalesce(app.effective_farm_role(p_by, p_to)::text, '') not in ('owner', 'manager') then
    raise exception 'you need to run both sites to move a vehicle' using errcode = '42501';
  end if;

  -- The sticker stays on the vehicle, so its token goes with it; the old record gets a new one
  -- and stops counting towards this site's slots.
  update public.machines
     set public_token = gen_random_uuid(), status = 'retired', assigned_operator_id = null
   where id = p_machine;

  insert into public.machines (
    farm_id, public_token, name, type, make, model, year, serial_no, reg_no, meter_type, status,
    current_reading, current_reading_date, purchase_date, supplier, warranty_expiry_date,
    warranty_expiry_hours, notes, previous_machine_id
  ) values (
    p_to, m.public_token, m.name, m.type, m.make, m.model, m.year, m.serial_no, m.reg_no, m.meter_type, m.status,
    m.current_reading, m.current_reading_date, m.purchase_date, m.supplier, m.warranty_expiry_date,
    m.warranty_expiry_hours, m.notes, m.id
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

revoke all on function public.offer_ownership(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.accept_ownership(uuid, uuid) from public, anon, authenticated;
revoke all on function public.move_machine_to_site(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.offer_ownership(uuid, uuid, uuid) to service_role;
grant execute on function public.accept_ownership(uuid, uuid) to service_role;
grant execute on function public.move_machine_to_site(uuid, uuid, uuid) to service_role;
