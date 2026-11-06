-- 20261107130000_trips.sql
-- The work a vehicle does, for any business that moves goods or people.
--
-- A truck run, a delivery round, a shuttle and a game drive are the same shape: a vehicle and
-- a driver going somewhere, carrying things or people for somebody. So this is one module,
-- and the words change by company type ("drive" and "booking" for a game lodge, "run" and
-- "delivery" for a courier). A trip has jobs on it: a load, a drop or a group of guests, and
-- each can be signed for at the other end.
--
-- Money stays out of `trips`: income and expenses are their own tables, which only an owner or
-- manager can read, so a driver can see their work without seeing what it earns.
--
-- Trailers are vehicles, so which trailer was behind which horse is the trip's own record.

create table if not exists public.trips (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null references public.farms(id),
  number            integer not null,
  status            text not null default 'planned',
  machine_id        uuid not null,
  trailer_id        uuid,
  second_trailer_id uuid,
  driver_id         uuid references public.users(id) on delete set null,
  origin            text,
  destination       text,
  planned_start     timestamptz,
  started_at        timestamptz,
  ended_at          timestamptz,
  opening_reading   numeric(12,1),
  closing_reading   numeric(12,1),
  notes             text,
  created_by        uuid references public.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  unique (id, farm_id),
  unique (farm_id, number),
  foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  foreign key (trailer_id, farm_id) references public.machines(id, farm_id),
  foreign key (second_trailer_id, farm_id) references public.machines(id, farm_id),
  constraint trips_status_ck check (status in ('planned', 'underway', 'completed', 'cancelled')),
  constraint trips_times_ck check (ended_at is null or started_at is null or ended_at >= started_at),
  constraint trips_readings_ck check (closing_reading is null or opening_reading is null or closing_reading >= opening_reading),
  constraint trips_lengths_ck check (coalesce(length(origin), 0) <= 200 and coalesce(length(destination), 0) <= 200 and coalesce(length(notes), 0) <= 2000)
);

-- A vehicle and a driver are in one place at a time.
create unique index if not exists trips_one_underway_machine_idx on public.trips (machine_id) where status = 'underway' and deleted_at is null;
create unique index if not exists trips_one_underway_driver_idx on public.trips (driver_id) where status = 'underway' and deleted_at is null;
create index if not exists trips_farm_idx on public.trips (farm_id, created_at desc);
create index if not exists trips_driver_idx on public.trips (driver_id, created_at desc);

create table if not exists public.trip_jobs (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null,
  trip_id            uuid not null,
  customer           text not null,
  reference          text,
  description        text,
  weight_kg          numeric(12,2),
  passengers         integer,
  seal_no            text,
  pickup             text,
  dropoff            text,
  status             text not null default 'pending',
  delivered_at       timestamptz,
  received_by        text,
  pod_note           text,
  pod_photo_path     text,
  pod_signature_path text,
  pod_lat            double precision,
  pod_lng            double precision,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  foreign key (trip_id, farm_id) references public.trips(id, farm_id),
  constraint trip_jobs_status_ck check (status in ('pending', 'delivered', 'failed')),
  constraint trip_jobs_customer_ck check (length(customer) between 1 and 200),
  constraint trip_jobs_lengths_ck check (
    coalesce(length(reference), 0) <= 100 and coalesce(length(description), 0) <= 1000
    and coalesce(length(seal_no), 0) <= 100 and coalesce(length(pickup), 0) <= 200
    and coalesce(length(dropoff), 0) <= 200 and coalesce(length(received_by), 0) <= 200
    and coalesce(length(pod_note), 0) <= 1000),
  constraint trip_jobs_delivered_ck check (status <> 'delivered' or (received_by is not null and delivered_at is not null))
);
create index if not exists trip_jobs_trip_idx on public.trip_jobs (trip_id);

create table if not exists public.trip_income (
  trip_id      uuid primary key,
  farm_id      uuid not null,
  amount_cents bigint not null check (amount_cents >= 0),
  invoice_ref  text check (coalesce(length(invoice_ref), 0) <= 100),
  created_by   uuid references public.users(id) on delete set null,
  updated_at   timestamptz not null default now(),
  foreign key (trip_id, farm_id) references public.trips(id, farm_id)
);

create table if not exists public.trip_expenses (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  trip_id      uuid not null,
  kind         text not null,
  amount_cents bigint not null check (amount_cents >= 0),
  note         text check (coalesce(length(note), 0) <= 500),
  created_by   uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  foreign key (trip_id, farm_id) references public.trips(id, farm_id),
  constraint trip_expenses_kind_ck check (kind in ('toll', 'accommodation', 'meals', 'repair', 'other'))
);
create index if not exists trip_expenses_trip_idx on public.trip_expenses (trip_id);

-- A readable number per business. Locked, so two people adding at once cannot share one.
create or replace function app.trips_number() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('trips:' || new.farm_id::text, 0));
  select coalesce(max(t.number), 0) + 1 into new.number from public.trips t where t.farm_id = new.farm_id;
  return new;
end $$;
revoke all on function app.trips_number() from public, anon, authenticated;
create trigger trips_number before insert on public.trips for each row execute function app.trips_number();

alter table public.trips enable row level security;
alter table public.trips force row level security;
alter table public.trip_jobs enable row level security;
alter table public.trip_jobs force row level security;
alter table public.trip_income enable row level security;
alter table public.trip_income force row level security;
alter table public.trip_expenses enable row level security;
alter table public.trip_expenses force row level security;

-- Who runs trips here. A contractor's link gives no sight of them.
create or replace function app.trips_manager(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_rr_admin() or coalesce(app.effective_farm_role(auth.uid(), p_farm)::text, '') in ('owner', 'manager');
$$;
create or replace function app.trips_office(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_rr_admin() or coalesce(app.effective_farm_role(auth.uid(), p_farm)::text, '') in ('owner', 'manager', 'mechanic');
$$;
revoke all on function app.trips_manager(uuid), app.trips_office(uuid) from public, anon;
grant execute on function app.trips_manager(uuid), app.trips_office(uuid) to authenticated, service_role;

create policy trips_sel on public.trips for select to authenticated
  using (app.trips_office(farm_id) or driver_id = auth.uid());
create policy trips_ins on public.trips for insert to authenticated with check (app.trips_manager(farm_id));
create policy trips_upd on public.trips for update to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));

create policy trip_jobs_sel on public.trip_jobs for select to authenticated using (
  app.trips_office(farm_id)
  or exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = auth.uid())
);
create policy trip_jobs_ins on public.trip_jobs for insert to authenticated with check (app.trips_manager(farm_id));
create policy trip_jobs_upd on public.trip_jobs for update to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));

create policy trip_income_all on public.trip_income for all to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));
create policy trip_expenses_all on public.trip_expenses for all to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));

revoke all on public.trips, public.trip_jobs, public.trip_income, public.trip_expenses from public, anon, authenticated;
grant select, insert, update on public.trips, public.trip_jobs to authenticated;
grant select, insert, update, delete on public.trip_income, public.trip_expenses to authenticated;
grant all on public.trips, public.trip_jobs, public.trip_income, public.trip_expenses to service_role;

create trigger trips_audit after insert or update or delete on public.trips for each row execute function public.app_audit();
create trigger trip_jobs_audit after insert or update or delete on public.trip_jobs for each row execute function public.app_audit();
create trigger trip_income_audit after insert or update or delete on public.trip_income for each row execute function public.app_audit();
create trigger trip_expenses_audit after insert or update or delete on public.trip_expenses for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('trips', 'farm', 'the work a vehicle did'),
  ('trip_jobs', 'farm', 'what was carried, and who signed for it'),
  ('trip_income', 'farm', 'what a trip earned'),
  ('trip_expenses', 'farm', 'what a trip cost')
on conflict (table_name) do nothing;

-- What a driver may do to their own trip. A driver has no write access to these tables, so
-- this is the whole of it, and a manager can do it on their behalf.
create or replace function public.trip_start(p_trip uuid, p_reading numeric)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.trips%rowtype;
begin
  select * into v from public.trips where id = p_trip and deleted_at is null for update;
  if not found then raise exception 'no such trip' using errcode = 'P0002'; end if;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  if v.status <> 'planned' then raise exception 'this trip has already started' using errcode = '22023'; end if;
  update public.trips set status = 'underway', started_at = now(), opening_reading = p_reading where id = p_trip;
end $$;

create or replace function public.trip_finish(p_trip uuid, p_reading numeric)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.trips%rowtype;
begin
  select * into v from public.trips where id = p_trip and deleted_at is null for update;
  if not found then raise exception 'no such trip' using errcode = 'P0002'; end if;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  if v.status <> 'underway' then raise exception 'this trip is not underway' using errcode = '22023'; end if;
  if p_reading is not null and v.opening_reading is not null and p_reading < v.opening_reading then
    raise exception 'the closing reading is below the opening reading' using errcode = '22023';
  end if;
  update public.trips set status = 'completed', ended_at = now(), closing_reading = p_reading where id = p_trip;
end $$;

create or replace function public.trip_job_deliver(
  p_job uuid, p_status text, p_received_by text, p_note text,
  p_photo text, p_signature text, p_lat double precision, p_lng double precision
)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  j public.trip_jobs%rowtype;
  v public.trips%rowtype;
begin
  select * into j from public.trip_jobs where id = p_job and deleted_at is null for update;
  if not found then raise exception 'no such job' using errcode = 'P0002'; end if;
  select * into v from public.trips where id = j.trip_id;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  if j.status <> 'pending' then raise exception 'this has already been closed' using errcode = '22023'; end if;
  if p_status not in ('delivered', 'failed') then raise exception 'unknown outcome' using errcode = '22023'; end if;
  if p_status = 'delivered' and coalesce(btrim(p_received_by), '') = '' then
    raise exception 'say who received it' using errcode = '22023';
  end if;
  update public.trip_jobs
     set status = p_status, delivered_at = now(), received_by = nullif(btrim(p_received_by), ''),
         pod_note = nullif(btrim(p_note), ''), pod_photo_path = p_photo, pod_signature_path = p_signature,
         pod_lat = p_lat, pod_lng = p_lng
   where id = p_job;
end $$;

revoke all on function public.trip_start(uuid, numeric) from public, anon;
revoke all on function public.trip_finish(uuid, numeric) from public, anon;
revoke all on function public.trip_job_deliver(uuid, text, text, text, text, text, double precision, double precision) from public, anon;
grant execute on function public.trip_start(uuid, numeric) to authenticated, service_role;
grant execute on function public.trip_finish(uuid, numeric) to authenticated, service_role;
grant execute on function public.trip_job_deliver(uuid, text, text, text, text, text, double precision, double precision) to authenticated, service_role;
