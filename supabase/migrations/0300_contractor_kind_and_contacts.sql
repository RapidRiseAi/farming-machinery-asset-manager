-- 0300_contractor_kind_and_contacts.sql
-- Contractor spine (F12a). A contractor/supplier is a `workshop` (0002) whose staff
-- are `workshop`-role users reaching linked farms through `workshop_links` (0100/0101).
-- To drive tailored per-kind views later (F12c) and provider-free quick-contact
-- (tel/wa.me/mailto) now, we classify each workshop by `kind` and capture structured
-- contact fields. The same `contractor_kind` enum classifies rows in the `partners`
-- directory (0301) so the two stay in lockstep.
--
-- Additive only: existing workshops default to kind 'other'; new contact columns are
-- nullable. RLS/audit on `workshops` are unchanged (0101 workshops_* policies still
-- apply; the 0008 workshops_audit trigger already covers the new columns).

-- ── Contractor / supplier type ────────────────────────────────────
create type contractor_kind as enum (
  'mechanic', 'auto_electrician', 'parts_supplier',
  'panel_beater', 'tyre', 'towing', 'other'
);

-- ── Classify + structured contacts on workshops ───────────────────
alter table workshops
  add column kind     contractor_kind not null default 'other',
  add column phone    text,
  add column whatsapp text,   -- E.164 preferred (drives https://wa.me/<e164>)
  add column email    text,
  add column area     text;   -- free-text service area / town

comment on column workshops.kind is
  'Contractor/supplier type — drives tailored per-kind views (F12c).';
comment on column workshops.whatsapp is
  'WhatsApp number, E.164 preferred (e.g. +27821234567) for wa.me deep links.';
