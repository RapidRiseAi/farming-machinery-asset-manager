-- 0270_parts_catalogue.sql
-- Service kits & parts catalogue — feature F9 (FR-5.2/5.3).
--
-- `parts_catalogue` is the manually-maintained list of parts a farm (or the global
-- RR-seeded library) buys: engine-oil / gearbox-oil / filter part numbers, their
-- supplier, category and a typical ex-VAT price. Mechanics / parts dealers add + edit
-- rows by hand today (AI later). It feeds two things:
--   * "Add from catalogue" on a job-card part line (prefill part_no/description/cost);
--   * service-kit items (0271) that reference a catalogue part.
--
-- Tenancy mirrors `service_templates` (0004/0101): a NULL farm_id is a GLOBAL row
-- readable by every authenticated user; a non-null farm_id is a per-farm row governed
-- by app.has_farm_access. Money is integer cents, ex-VAT (Scope §6). RLS is the sole
-- isolation guarantor (proven in supabase/tests/rls_isolation.sql).

create table parts_catalogue (
  id                 uuid primary key default gen_random_uuid(),
  farm_id            uuid references farms(id),   -- null = GLOBAL catalogue (RR-seeded)
  part_no            text not null,
  description        text,
  supplier           text,
  category           text,
  typical_cost_cents bigint,                      -- ex-VAT, integer cents (Scope §6)
  created_by         uuid references users(id),
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz,
  deleted_by         uuid
);
create index parts_catalogue_farm_idx    on parts_catalogue(farm_id);
create index parts_catalogue_part_no_idx on parts_catalogue(part_no);

-- ── RLS + grants (mirror service_templates: global rows readable by all) ──
alter table parts_catalogue enable row level security;
alter table parts_catalogue force  row level security;
create policy parts_catalogue_sel on parts_catalogue for select to authenticated
  using ((farm_id is null or app.has_farm_access(farm_id)) and deleted_at is null);
create policy parts_catalogue_ins on parts_catalogue for insert to authenticated
  with check (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id));
create policy parts_catalogue_upd on parts_catalogue for update to authenticated
  using (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id))
  with check (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id));
create policy parts_catalogue_del on parts_catalogue for delete to authenticated
  using (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id));

grant select, insert, update, delete on parts_catalogue to authenticated;
grant all on parts_catalogue to service_role;
-- anon gets ZERO access (0102 default privileges revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ────────────────────────
create trigger parts_catalogue_audit
  after insert or update or delete on parts_catalogue
  for each row execute function app_audit();
