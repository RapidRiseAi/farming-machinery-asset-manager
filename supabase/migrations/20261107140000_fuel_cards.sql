-- 20261107140000_fuel_cards.sql
-- Fuel card statements: what a fleet's cards bought, checked against its vehicles.
--
-- A statement is imported as a file, because every bank's feed is different and a file works
-- with all of them. Each fill is matched to a vehicle by registration and checked: an unknown
-- vehicle, more than the tank holds, two fills too close together, an odometer going
-- backwards. That is the fraud check fleet managers pay for. The checks live in
-- src/lib/fuel-cards.ts, where they can be read and tested, and their answer is stored here.
--
-- A matched fill books a fuel cost to the vehicle, so cost per kilometre includes it. Importing
-- the same statement twice adds nothing: a fill is known by when, which card, and how much.

alter table public.machines add column if not exists fuel_tank_litres numeric(8,1);
grant select (fuel_tank_litres) on public.machines to authenticated;
grant update (fuel_tank_litres) on public.machines to authenticated;

create table if not exists public.fuel_card_statements (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references public.farms(id),
  file_name   text check (coalesce(length(file_name), 0) <= 200),
  uploaded_by uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (id, farm_id)
);

create table if not exists public.fuel_card_transactions (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  statement_id uuid not null,
  occurred_at  timestamptz not null,
  card_ref     text not null default '',
  vehicle_ref  text,
  machine_id   uuid,
  driver_ref   text,
  merchant     text,
  litres       numeric(10,2) not null check (litres >= 0),
  amount_cents bigint not null check (amount_cents >= 0),
  odometer     numeric(12,1),
  flags        text[] not null default '{}',
  checked_by   uuid references public.users(id) on delete set null,
  checked_at   timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (statement_id, farm_id) references public.fuel_card_statements(id, farm_id),
  foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  constraint fuel_card_transactions_once unique (farm_id, occurred_at, card_ref, litres, amount_cents)
);
create index if not exists fuel_card_transactions_farm_idx on public.fuel_card_transactions (farm_id, occurred_at desc);
create index if not exists fuel_card_transactions_machine_idx on public.fuel_card_transactions (machine_id, occurred_at desc);

alter table public.fuel_card_statements enable row level security;
alter table public.fuel_card_statements force row level security;
alter table public.fuel_card_transactions enable row level security;
alter table public.fuel_card_transactions force row level security;

-- Costs and a card's spending are owner and manager business, as elsewhere.
create policy fuel_card_statements_all on public.fuel_card_statements for all to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));
create policy fuel_card_transactions_all on public.fuel_card_transactions for all to authenticated
  using (app.trips_manager(farm_id)) with check (app.trips_manager(farm_id));

revoke all on public.fuel_card_statements, public.fuel_card_transactions from public, anon, authenticated;
grant select, insert on public.fuel_card_statements to authenticated;
grant select, insert, update on public.fuel_card_transactions to authenticated;
grant all on public.fuel_card_statements, public.fuel_card_transactions to service_role;

create trigger fuel_card_statements_audit after insert or update or delete on public.fuel_card_statements
  for each row execute function public.app_audit();
create trigger fuel_card_transactions_audit after insert or update or delete on public.fuel_card_transactions
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('fuel_card_statements', 'farm', 'a statement brought in'),
  ('fuel_card_transactions', 'farm', 'what a card bought, and who checked it')
on conflict (table_name) do nothing;

-- A matched fill is a fuel cost on that vehicle, by the same route as every other cost.
create or replace function app_cost_from_fuel_card() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.machine_id is null then return new; end if;
  insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on, note)
  values (new.farm_id, new.machine_id, 'fuel', new.amount_cents, 'fuel_card', new.id,
          (new.occurred_at at time zone 'Africa/Johannesburg')::date, new.merchant);
  return new;
end $$;
revoke execute on function app_cost_from_fuel_card() from anon, authenticated, public;

create trigger fuel_card_transactions_cost after insert on public.fuel_card_transactions
  for each row execute function app_cost_from_fuel_card();
