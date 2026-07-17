-- 0004_service.sql
-- Service template library (global + per-farm) and per-machine service plan lines.
-- The due-date engine (OK/due-soon/overdue calculation) is Week 2; here we only
-- store the structure and a status column defaulting to 'ok'.

create table service_templates (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid references farms(id),   -- null = global template (RR-seeded library)
  machine_type machine_type,
  name         text not null,
  lines        jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid
);
create index service_templates_farm_idx on service_templates(farm_id);

create table service_plan_lines (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null,
  machine_id        uuid not null,
  task              text not null,
  interval_hours    numeric(12,1),
  interval_months   int,
  last_done_reading numeric(12,1),
  last_done_date    date,
  next_due_reading  numeric(12,1),
  next_due_date     date,
  status            service_line_status not null default 'ok',
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint service_plan_lines_machine_fk foreign key (machine_id, farm_id)
    references machines(id, farm_id),
  constraint service_plan_lines_farm_fk foreign key (farm_id) references farms(id),
  constraint service_plan_lines_interval_ck check (interval_hours is not null or interval_months is not null)
);
create index service_plan_lines_farm_idx    on service_plan_lines(farm_id);
create index service_plan_lines_machine_idx on service_plan_lines(machine_id);
