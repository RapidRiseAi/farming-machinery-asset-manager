-- 0005_faults_and_job_cards.sql
-- Fault reports, job cards, job-card cost lines, and watch items.
-- faults <-> job_cards is a circular reference; the faults.job_card_id FK is added
-- after job_cards exists.

create table faults (
  id            uuid primary key default gen_random_uuid(),
  farm_id       uuid not null,
  machine_id    uuid not null,
  reported_by   uuid references users(id),   -- null for anonymous QR submissions
  reporter_name text,                        -- optional free-text name on public form
  description   text,
  category      text,
  urgency       fault_urgency,
  status        fault_status not null default 'open',
  job_card_id   uuid,                        -- FK added below
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  deleted_at    timestamptz,
  deleted_by    uuid,
  constraint faults_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint faults_farm_fk    foreign key (farm_id) references farms(id)
);
create index faults_farm_idx        on faults(farm_id);
create index faults_machine_idx     on faults(machine_id);
create index faults_farm_status_idx on faults(farm_id, status);

create table job_cards (
  id                    uuid primary key default gen_random_uuid(),
  farm_id               uuid not null references farms(id),
  machine_id            uuid not null,
  created_from_fault_id uuid references faults(id),
  type                  job_card_type   not null,
  status                job_card_status not null default 'open',
  date_in               date,
  date_out              date,
  meter_reading         numeric(12,1),
  reported_problem      text,
  diagnosis             text,
  work_performed        text,
  recommendations       text,
  mechanic_user_id      uuid references users(id),
  workshop_id           uuid references workshops(id),
  vat_rate_bps          int    not null default 1500,   -- 15% VAT in basis points
  parts_total_cents     bigint not null default 0,       -- all money ex-VAT, integer cents
  labour_total_cents    bigint not null default 0,
  other_total_cents     bigint not null default 0,
  total_cents           bigint not null default 0,
  approved_by           uuid references users(id),
  approved_at           timestamptz,
  locked                boolean not null default false,  -- true after approval; blocks edits
  created_at            timestamptz not null default now(),
  deleted_at            timestamptz,
  deleted_by            uuid,
  constraint job_cards_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint job_cards_id_farm_uq unique (id, farm_id)
);
create index job_cards_farm_idx        on job_cards(farm_id);
create index job_cards_machine_idx     on job_cards(machine_id);
create index job_cards_farm_status_idx on job_cards(farm_id, status);

alter table faults
  add constraint faults_job_card_fk foreign key (job_card_id) references job_cards(id);

create table job_card_lines (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null,
  job_card_id     uuid not null,
  kind            job_line_kind not null,
  description     text,
  part_no         text,
  qty             numeric(12,2),
  unit_cost_cents bigint,   -- part unit cost / flat 'other' amount (ex-VAT cents)
  hours           numeric(12,2),
  rate_cents      bigint,   -- labour rate per hour (ex-VAT cents)
  total_cents     bigint not null default 0,   -- computed by trigger (see 0008)
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  constraint job_card_lines_jc_fk foreign key (job_card_id, farm_id)
    references job_cards(id, farm_id) on delete cascade,
  constraint job_card_lines_farm_fk foreign key (farm_id) references farms(id)
);
create index job_card_lines_jc_idx   on job_card_lines(job_card_id);
create index job_card_lines_farm_idx on job_card_lines(farm_id);

create table watch_items (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null,
  machine_id         uuid not null,
  source_job_card_id uuid references job_cards(id),
  text               text not null,
  status             watch_item_status not null default 'open',
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid,
  constraint watch_items_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint watch_items_farm_fk    foreign key (farm_id) references farms(id)
);
create index watch_items_farm_idx    on watch_items(farm_id);
create index watch_items_machine_idx on watch_items(machine_id);
