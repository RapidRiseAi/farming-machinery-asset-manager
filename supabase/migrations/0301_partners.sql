-- 0301_partners.sql
-- Partners directory (F12a). A `partner` is a contractor/supplier a farm can find,
-- add, quick-contact (tel/wa.me/mailto) and — once they accept — connect to as a
-- proper `workshop` (via the invite flow: workshop + active workshop_link + a
-- workshop-role user; the partner then carries `workshop_id`).
--
-- Two flavours share one table (tenancy mirrors `service_templates`/`parts_catalogue`):
--   * GLOBAL suggested partners  → farm_id IS NULL, is_suggested = true, RR-curated,
--       readable by every authenticated user (the "suggested partners" catalogue);
--   * FARM-OWNED partners        → farm_id set, is_suggested = false, governed by
--       app.has_farm_access; mutable only by that farm's owner/manager (or RR admin).
--
-- The (farm_id IS NULL) = is_suggested invariant is enforced by a check constraint so
-- the two flavours can never be confused. `workshop_id` is a nullable link to the
-- workshop created once the partner joins (workshops are NOT farm-scoped, so a plain
-- FK is correct — a farm reaches that workshop's data only through workshop_links/RLS,
-- never through this pointer). Soft-delete + audit + anon-zero-DB per house rules.

create table partners (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid references farms(id),          -- null = GLOBAL suggested (RR-curated)
  name         text not null,
  kind         contractor_kind not null default 'other',
  phone        text,
  whatsapp     text,                               -- E.164 preferred (wa.me deep links)
  email        text,
  area         text,                               -- free-text service area / town
  is_suggested boolean not null default false,     -- true iff a GLOBAL row (farm_id null)
  workshop_id  uuid references workshops(id),      -- set once the partner is invited/joins
  notes        text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  -- A GLOBAL row is exactly a suggested row, and vice-versa.
  constraint partners_scope_ck check ((farm_id is null) = is_suggested)
);
create index partners_farm_idx     on partners(farm_id);
create index partners_kind_idx     on partners(kind);
create index partners_workshop_idx on partners(workshop_id);

-- ── RLS + grants (global rows readable by all; farm rows via has_farm_access;
--    mutation restricted to the owning farm's owner/manager, or RR admin) ──
alter table partners enable row level security;
alter table partners force  row level security;

create policy partners_sel on partners for select to authenticated
  using ((farm_id is null or app.has_farm_access(farm_id)) and deleted_at is null);

create policy partners_ins on partners for insert to authenticated
  with check (
    app.is_rr_admin()
    or (farm_id is not null
        and app.user_farm_id() = farm_id
        and app.current_app_role() in ('owner','manager'))
  );

create policy partners_upd on partners for update to authenticated
  using (
    app.is_rr_admin()
    or (farm_id is not null
        and app.user_farm_id() = farm_id
        and app.current_app_role() in ('owner','manager'))
  )
  with check (
    app.is_rr_admin()
    or (farm_id is not null
        and app.user_farm_id() = farm_id
        and app.current_app_role() in ('owner','manager'))
  );

create policy partners_del on partners for delete to authenticated
  using (
    app.is_rr_admin()
    or (farm_id is not null
        and app.user_farm_id() = farm_id
        and app.current_app_role() in ('owner','manager'))
  );

grant select, insert, update, delete on partners to authenticated;
grant all on partners to service_role;
-- anon gets ZERO access (0102 default privileges revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ────────────────────────
create trigger partners_audit
  after insert or update or delete on partners
  for each row execute function app_audit();
