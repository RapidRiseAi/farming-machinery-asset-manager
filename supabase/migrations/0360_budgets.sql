-- 0360_budgets.sql
-- Budgets & budget-vs-actual — feature G1 (FR-10.4).
--
-- A `budget` sets a spending target (ex-VAT integer cents, Scope §6) for a period,
-- optionally narrowed to one machine and/or one cost category. "Actual" is never stored:
-- it is summed live from `cost_entries` (0210) for the same scope + period, so a budget
-- and its actual can never drift. Tenancy is the usual denormalized farm_id + composite
-- FK to machines(id, farm_id); RLS via app.has_farm_access is the sole isolation
-- guarantor (proven in supabase/tests/rls_isolation.sql). Soft-delete + audit per the
-- global conventions.
--
-- Scope combinations (both nullable, like cost_entries.machine_id):
--   * machine_id null + category null  → whole-farm, all-categories budget
--   * machine_id set  + category null  → one machine, all categories
--   * machine_id null + category set   → whole farm, one cost category
--   * machine_id set  + category set   → one machine, one cost category

-- The granularity a budget covers. period_start/period_end are stored explicitly so the
-- actual query is a plain date-range sum (app + SQL agree without re-deriving bounds);
-- period_type is kept for display/labels only.
create type budget_period as enum ('month', 'quarter', 'year');

create table budgets (
  id            uuid primary key default gen_random_uuid(),
  farm_id       uuid not null,
  machine_id    uuid,                         -- null = whole-farm budget
  category      cost_entry_type,              -- null = all cost categories combined
  period_type   budget_period not null default 'month',
  period_start  date not null,
  period_end    date not null,
  amount_cents  bigint not null default 0,    -- the target, ex-VAT integer cents
  note          text,
  created_by    uuid references users(id),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  deleted_by    uuid,
  constraint budgets_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint budgets_farm_fk    foreign key (farm_id) references farms(id),
  constraint budgets_period_ck  check (period_end >= period_start)
);
create index budgets_farm_idx    on budgets(farm_id);
create index budgets_machine_idx on budgets(machine_id, period_start);

-- One live budget per exact scope+period. NULLS NOT DISTINCT (PG15+) treats a
-- whole-farm (machine_id null) / all-category (category null) budget as a single distinct
-- scope, so duplicates are still rejected. Editing goes through the app (update), not a
-- second row.
create unique index budgets_scope_uq
  on budgets (farm_id, machine_id, category, period_start, period_end)
  nulls not distinct
  where deleted_at is null;

-- ── RLS + grants (mirror the standard farm-scoped pattern, 0101/0102) ──
alter table budgets enable row level security;
alter table budgets force  row level security;
create policy budgets_sel on budgets for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null);
create policy budgets_ins on budgets for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy budgets_upd on budgets for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy budgets_del on budgets for delete to authenticated
  using (app.has_farm_access(farm_id));

grant select, insert, update, delete on budgets to authenticated;
grant all on budgets to service_role;
-- anon gets ZERO access (default privileges in 0102 revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ────────────────────────
create trigger budgets_audit
  after insert or update or delete on budgets
  for each row execute function app_audit();
