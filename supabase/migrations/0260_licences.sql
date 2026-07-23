-- 0260_licences.sql
-- Compliance reminders — feature F6 (FR-13.3 licence/renewal, FR-4.7 warranty).
--
-- `licences` tracks per-machine, date-based renewals that carry legal / operational
-- consequences when they lapse: the annual vehicle licence disc, roadworthy, cross-border
-- permit, insurance, etc. Warranty already lives on `machines` (warranty_expiry_date /
-- warranty_expiry_hours) — this migration only adds the dedupe bookkeeping the expiry
-- engine (0263) needs there. Tenancy is the usual denormalized farm_id + composite FK to
-- machines(id, farm_id); RLS is the sole isolation guarantor (proven in
-- supabase/tests/rls_isolation.sql). Soft-delete + audit per the global conventions.

-- Status shared by warranty + licence expiry (UI badges and the notify engine both use it).
create type expiry_status as enum ('ok', 'expiring', 'expired');

-- The kinds of renewal a farm tracks. `other` keeps it open-ended without free-typing a
-- category (the human-readable name still lives in `number`/`notes`).
create type licence_type as enum
  ('vehicle_licence', 'roadworthy', 'permit', 'crossborder', 'insurance', 'other');

create table licences (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid not null,
  machine_id         uuid not null,
  type               licence_type not null default 'vehicle_licence',
  number             text,                        -- disc / policy / permit number
  expiry_date        date not null,
  reminder_lead_days int  not null default 30,    -- start reminding this many days before expiry
  notes              text,
  -- Dedupe bookkeeping for the 0263 expiry engine (mirrors service_plan_lines):
  -- the status we last notified on, so we fire only on a transition and re-fire weekly
  -- while expired.
  notified_status    expiry_status,
  last_notified_at   timestamptz,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid,
  constraint licences_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint licences_farm_fk    foreign key (farm_id) references farms(id)
);
create index licences_farm_idx    on licences(farm_id);
create index licences_machine_idx on licences(machine_id, expiry_date);
create index licences_expiry_idx  on licences(expiry_date) where deleted_at is null;

-- ── Warranty dedupe bookkeeping on machines (0263 engine) ─────────
-- Warranty data itself already exists (0003). These two columns let the expiry engine
-- dedupe warranty reminders the same way service_plan_lines dedupes service reminders.
alter table machines
  add column if not exists warranty_notified_status expiry_status,
  add column if not exists warranty_notified_at     timestamptz;

-- ── RLS + grants (mirror the standard farm-scoped pattern, 0101/0102) ──
alter table licences enable row level security;
alter table licences force  row level security;
create policy licences_sel on licences for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null);
create policy licences_ins on licences for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy licences_upd on licences for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy licences_del on licences for delete to authenticated
  using (app.has_farm_access(farm_id));

grant select, insert, update, delete on licences to authenticated;
grant all on licences to service_role;
-- anon gets ZERO access (default privileges in 0102 revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ────────────────────────
create trigger licences_audit
  after insert or update or delete on licences
  for each row execute function app_audit();
