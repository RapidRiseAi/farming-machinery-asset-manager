-- 0007_fuel.sql
-- Diesel & fuel module tables (Scope §9, v1.5). Created now so the full Section 6
-- schema exists and RLS + isolation tests cover every table. NO fuel features/UI
-- are built until v1.5 — these tables are dormant in v1.

create table fuel_tanks (
  id         uuid primary key default gen_random_uuid(),
  farm_id    uuid not null references farms(id),
  name       text not null,
  capacity_l numeric(12,1),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint fuel_tanks_id_farm_uq unique (id, farm_id)
);
create index fuel_tanks_farm_idx on fuel_tanks(farm_id);

create table fuel_deliveries (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null,
  tank_id           uuid not null,
  date              date not null default current_date,
  supplier          text,
  invoice_no        text,
  litres            numeric(12,1),
  price_per_l_cents bigint,   -- money in integer cents, ex-VAT
  doc_url           text,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint fuel_deliveries_tank_fk foreign key (tank_id, farm_id) references fuel_tanks(id, farm_id),
  constraint fuel_deliveries_farm_fk foreign key (farm_id) references farms(id)
);
create index fuel_deliveries_farm_idx on fuel_deliveries(farm_id);
create index fuel_deliveries_tank_idx on fuel_deliveries(tank_id);

create table fuel_issues (
  id            uuid primary key default gen_random_uuid(),
  farm_id       uuid not null,
  tank_id       uuid not null,
  machine_id    uuid,
  date          date not null default current_date,
  litres        numeric(12,1),
  meter_reading numeric(12,1),
  activity      text,
  by_user       uuid references users(id),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid,
  constraint fuel_issues_tank_fk    foreign key (tank_id, farm_id)    references fuel_tanks(id, farm_id),
  constraint fuel_issues_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint fuel_issues_farm_fk    foreign key (farm_id) references farms(id)
);
create index fuel_issues_farm_idx    on fuel_issues(farm_id);
create index fuel_issues_tank_idx    on fuel_issues(tank_id);
create index fuel_issues_machine_idx on fuel_issues(machine_id);
