-- 0280_vehicle_capture_and_primary_image.sql
-- Feature F10 — Vehicle capture completeness + images (provider-spec §8, FR-3.2/3.4).
--
-- Adds:
--   * machines.cost_centre / machines.department — FR-3.4 grouping + filter dimensions.
--   * machines.primary_attachment_id — the one machine photo shown as the vehicle's
--     primary image on list cards + the detail header (null = graceful placeholder).
--
-- The primary reference is kept farm-isolated by a COMPOSITE FK to the SAME farm —
-- the house-rule tenancy pattern (mirrors machines_id_farm_uq / the child composite
-- FKs in 0003). `machines` already has farm_id RLS (0101), the audit trigger (0008)
-- and soft-delete columns, and those apply column-agnostically, so nothing else is
-- needed here. Plain, Supabase- and local-Postgres-compatible DDL.

-- ── FR-3.4 grouping / filter columns ─────────────────────────────
alter table machines
  add column if not exists cost_centre text,
  add column if not exists department  text;

comment on column machines.cost_centre is
  'FR-3.4 grouping/filter dimension (free text, e.g. a cost centre code).';
comment on column machines.department is
  'FR-3.4 grouping/filter dimension (free text, e.g. Lande / Vervoer / Werkswinkel).';

-- ── Composite uniqueness on attachments so a same-farm FK can target one ──
-- attachments.id is already the PK (unique); (id, farm_id) is therefore trivially
-- unique and just yields the index a composite FK requires as its reference target.
alter table attachments
  add constraint attachments_id_farm_uq unique (id, farm_id);

-- ── Primary vehicle image ────────────────────────────────────────
-- Composite FK ties (primary_attachment_id, farm_id) to an attachment of the SAME
-- farm: a machine can never point its primary image at another tenant's photo
-- (proven in rls_isolation.sql). Nullable → no primary set (UI shows a placeholder).
-- No ON DELETE action: attachments are soft-deleted in-app (an UPDATE, which never
-- fires the FK), so the reference is stable; a hard delete of a referenced photo is
-- blocked rather than allowed to dangle. The UI joins on `deleted_at is null`, so a
-- soft-deleted primary simply falls back to the placeholder.
alter table machines
  add column if not exists primary_attachment_id uuid;

alter table machines
  add constraint machines_primary_attachment_fk
    foreign key (primary_attachment_id, farm_id)
    references attachments (id, farm_id);

create index if not exists machines_primary_attachment_idx
  on machines (primary_attachment_id);

comment on column machines.primary_attachment_id is
  'The attachment (kind=photo, parent=this machine) shown as the vehicle''s primary image on cards + detail. Composite FK keeps it farm-isolated; the app validates parent_id/kind before setting it.';
