-- 0003_machines_and_readings.sql
-- Machine/vehicle registry and meter reading history.
-- machines carries `unique (id, farm_id)` so child tables can use a composite FK
-- that *guarantees* their denormalized farm_id matches the machine's farm.

create table machines (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references farms(id),
  public_token          uuid not null default gen_random_uuid(),  -- unguessable; used in QR URL
  name                  text not null,
  type                  machine_type   not null,
  make                  text,
  model                 text,
  year                  int,
  serial_no             text,
  reg_no                text,
  meter_type            meter_type     not null default 'hours',
  status                machine_status not null default 'active',
  current_reading       numeric(12,1),
  current_reading_date  date,
  purchase_date         date,
  purchase_price_cents  bigint,          -- money in integer cents, ex-VAT
  supplier              text,
  warranty_expiry_date  date,
  warranty_expiry_hours numeric(12,1),
  assigned_operator_id  uuid references users(id),
  location              text,
  notes                 text,
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid,
  constraint machines_public_token_uq unique (public_token),
  constraint machines_id_farm_uq      unique (id, farm_id)
);
create index machines_farm_idx        on machines(farm_id);
create index machines_farm_status_idx on machines(farm_id, status);
create index machines_farm_type_idx   on machines(farm_id, type);

create table meter_readings (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  machine_id   uuid not null,
  reading      numeric(12,1) not null,
  reading_date date not null default current_date,
  source       meter_source  not null,
  by_user      uuid references users(id),   -- null for anonymous QR submissions
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint meter_readings_machine_fk foreign key (machine_id, farm_id)
    references machines(id, farm_id),
  constraint meter_readings_farm_fk foreign key (farm_id) references farms(id)
);
create index meter_readings_farm_idx    on meter_readings(farm_id);
create index meter_readings_machine_idx on meter_readings(machine_id, reading_date desc);
