-- 0234_faults_fields.sql  (F3 · FR-7.3 assignee + FR-7.2 location)
-- Additive columns on `faults`:
--   * assigned_to — the user responsible for the fault (lifecycle assignee).
--   * lat / lng   — optional geolocation captured (permission-gated) at report time.
-- No new RLS/audit wiring needed: `faults` already has both, and these columns ride
-- inside the existing row. FKs stay farm-safe (assigned_to → users, app-validated to
-- the fault's farm before it is set).

alter table faults add column if not exists assigned_to uuid references users(id);
alter table faults add column if not exists lat double precision;
alter table faults add column if not exists lng double precision;

create index if not exists faults_assigned_idx on faults(assigned_to);
