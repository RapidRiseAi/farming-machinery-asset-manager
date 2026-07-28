-- 0370_fines.sql
-- AARTO fine workflow — feature G2 (FR-13.2; §23 "AARTO nominations pending & deadlines").
--
-- A `fines` row captures a traffic / AARTO infringement issued against a farm VEHICLE. The
-- law-imposed workflow is: a notice arrives naming the VEHICLE (not the driver); the owner
-- must NOMINATE the responsible driver before a statutory DEADLINE, or the registered owner
-- carries the penalty. FleetWise already records WHO drove WHICH vehicle WHEN (usage_logs,
-- F3 / FR-13.1) — so the capture UI auto-suggests the driver from usage_logs for the vehicle
-- on the offence date, and the nightly engine (0371) reminds owner/manager as the nomination
-- deadline approaches.
--
-- Tenancy is the house standard: denormalized farm_id + composite FK to machines(id, farm_id);
-- RLS is the sole isolation guarantor (proven in supabase/tests/rls_isolation.sql). Money is
-- integer cents, ex-VAT (a fine is not VATable — amount_cents is the full penalty). Soft-delete
-- + append-only audit per the global conventions. Amounts are deliberately NOT booked into
-- cost_entries/TCO: a fine is a driver-accountability penalty, not a machine operating cost.

-- Lifecycle: received -> driver_identified -> nominated -> paid | disputed -> closed.
create type fine_status as enum
  ('received', 'driver_identified', 'nominated', 'paid', 'disputed', 'closed');

create table fines (
  id                         uuid primary key default gen_random_uuid(),
  farm_id                    uuid not null,
  machine_id                 uuid not null,
  notice_number              text,                    -- the infringement / notice number
  authority                  text,                    -- issuing authority (e.g. "JMPD", "RTMC")
  offence                    text,                    -- description of the offence
  offence_date               date,                    -- when the offence occurred (the nomination basis)
  fine_date                  date not null default current_date,  -- when the notice was received / dated
  amount_cents               bigint,                  -- penalty, ex-VAT integer cents (fines are not VATable)
  nomination_deadline        date,                    -- statutory deadline to nominate the driver
  status                     fine_status not null default 'received',
  driver_user_id             uuid references users(id),  -- the identified driver (a known operator), or…
  driver_name                text,                        -- …a free-text name
  notes                      text,
  -- Dedupe bookkeeping for the 0371 nomination-deadline engine (mirrors licences 0260):
  -- the expiry_status we last notified on, so we fire only on a transition and re-fire
  -- weekly while overdue.
  nomination_notified_status expiry_status,
  nomination_notified_at     timestamptz,
  created_by                 uuid references users(id),
  created_at                 timestamptz not null default now(),
  deleted_at                 timestamptz,
  deleted_by                 uuid,
  constraint fines_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint fines_farm_fk    foreign key (farm_id) references farms(id)
);
create index fines_farm_idx     on fines(farm_id);
create index fines_machine_idx  on fines(machine_id, offence_date desc);
create index fines_deadline_idx on fines(nomination_deadline) where deleted_at is null;
create index fines_driver_idx   on fines(driver_user_id);

-- ── RLS ────────────────────────────────────────────────────────────
-- SELECT is role-aware (0341 pattern for machine-keyed tables): operators see only fines on
-- the machines assigned to them; owner/manager/mechanic keep full farm access. Writes are
-- farm-scoped (the app restricts capture/transition to owner/manager via requireRole).
alter table fines enable row level security;
alter table fines force  row level security;
create policy fines_sel on fines for select to authenticated
  using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id));
create policy fines_ins on fines for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy fines_upd on fines for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy fines_del on fines for delete to authenticated
  using (app.has_farm_access(farm_id));

-- ── Grants (explicit, mirroring 0102) — anon gets ZERO access ───────
grant select, insert, update, delete on fines to authenticated;
grant all on fines to service_role;
revoke all on fines from anon;

-- ── Audit trigger (append-only diff log) ────────────────────────────
create trigger fines_audit
  after insert or update or delete on public.fines
  for each row execute function app_audit();
