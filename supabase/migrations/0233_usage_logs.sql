-- 0233_usage_logs.sql  (F3 · FR-13.1 — AARTO driver-usage log)
-- Records WHICH driver operated WHICH vehicle and WHEN — the basis for AARTO
-- nominations ("who was driving asset X on date D?"). A usage_log is written when a
-- reading is captured by a known user, when a job card completes (0236), and from
-- the public QR capture (driver picked / named at capture). Fully tenant-isolated,
-- audited and soft-deletable like every other business table.

create table usage_logs (
  id             uuid primary key default gen_random_uuid(),
  farm_id        uuid not null,
  machine_id     uuid not null,
  driver_user_id uuid references users(id),  -- a known signed-in operator, or…
  driver_name    text,                        -- …a free-text name (anonymous QR / other)
  occurred_on    date not null default current_date,
  meter_reading  numeric(12,1),               -- meter at time of use, if captured
  source         meter_source not null,       -- app | qr | job | manual | whatsapp
  note           text,
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid,
  constraint usage_logs_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint usage_logs_farm_fk    foreign key (farm_id) references farms(id)
);
create index usage_logs_farm_idx    on usage_logs(farm_id);
create index usage_logs_machine_idx on usage_logs(machine_id, occurred_on desc);
create index usage_logs_driver_idx  on usage_logs(driver_user_id);

-- ── RLS (copy of the 0101 farm-scoped loop for a single table) ──────
alter table usage_logs enable row level security;
alter table usage_logs force  row level security;
create policy usage_logs_sel on usage_logs for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null);
create policy usage_logs_ins on usage_logs for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy usage_logs_upd on usage_logs for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy usage_logs_del on usage_logs for delete to authenticated
  using (app.has_farm_access(farm_id));

-- ── Grants (explicit, mirroring 0102) — anon gets ZERO access ───────
grant select, insert, update, delete on usage_logs to authenticated;
grant all on usage_logs to service_role;
revoke all on usage_logs from anon;

-- ── Audit trigger (append-only diff log) ────────────────────────────
create trigger usage_logs_audit
  after insert or update or delete on public.usage_logs
  for each row execute function app_audit();
