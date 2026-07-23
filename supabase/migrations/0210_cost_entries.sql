-- 0210_cost_entries.sql
-- Cost & True-Cost-of-Ownership (TCO) spine — feature F1 (FR-10.1/10.2/10.3, FR-8.4).
--
-- `cost_entries` is the single unified ledger of every cost that contributes to an
-- asset's (or the farm's) total cost of ownership: the purchase price, finance
-- interest, fuel, and the parts/labour/other/invoice lines that flow off job cards.
-- Money is integer cents, ex-VAT (Scope §6). Tenancy is the usual denormalized
-- farm_id + composite FK; RLS is the sole isolation guarantor (proven in
-- supabase/tests/rls_isolation.sql). The sync triggers that keep this table in step
-- with job_card_lines / machines / fuel_deliveries live in 0211.

create type cost_entry_type as enum
  ('purchase','finance','fuel','parts','labour','invoice','other');

create table cost_entries (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  -- machine_id is NULLABLE on purpose: some costs are farm-level rather than tied to
  -- one asset (e.g. a bulk fuel-tank delivery). The composite FK below is MATCH SIMPLE,
  -- so it is enforced only when machine_id is present; tenancy still holds via farm_id.
  machine_id   uuid,
  type         cost_entry_type not null,
  amount_cents bigint not null default 0,     -- ex-VAT, integer cents (Scope §6)
  vat_rate_bps int,                           -- VAT rate captured at entry (basis points)
  source_type  text,                          -- machine | machine_finance | job_card_line | job_card | fuel_delivery | manual
  source_id    uuid,                          -- originating row; (source_type, source_id) is the dedupe key for synced rows
  occurred_on  date not null default current_date,
  note         text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint cost_entries_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint cost_entries_farm_fk    foreign key (farm_id) references farms(id)
);
create index cost_entries_farm_idx    on cost_entries(farm_id);
create index cost_entries_machine_idx on cost_entries(machine_id, occurred_on);
create index cost_entries_source_idx  on cost_entries(source_type, source_id);

-- ── Machine finance details (FR-3.2) ─────────────────────────────
-- Captured for display + to derive a finance-interest cost entry (0211). Money in
-- integer cents, ex-VAT; interest rate in basis points.
alter table machines
  add column finance_provider      text,
  add column finance_total_cents   bigint,   -- total amount financed (principal), ex-VAT
  add column finance_monthly_cents bigint,   -- monthly instalment, ex-VAT
  add column finance_term_months   int,
  add column finance_interest_bps  int;      -- annual interest rate, basis points

-- ── RLS + grants (mirror the standard farm-scoped pattern, 0101/0102) ──
alter table cost_entries enable row level security;
alter table cost_entries force  row level security;
create policy cost_entries_sel on cost_entries for select to authenticated
  using (app.has_farm_access(farm_id) and deleted_at is null);
create policy cost_entries_ins on cost_entries for insert to authenticated
  with check (app.has_farm_access(farm_id));
create policy cost_entries_upd on cost_entries for update to authenticated
  using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id));
create policy cost_entries_del on cost_entries for delete to authenticated
  using (app.has_farm_access(farm_id));

grant select, insert, update, delete on cost_entries to authenticated;
grant all on cost_entries to service_role;
-- anon gets ZERO access (default privileges in 0102 revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ────────────────────────
create trigger cost_entries_audit
  after insert or update or delete on cost_entries
  for each row execute function app_audit();
