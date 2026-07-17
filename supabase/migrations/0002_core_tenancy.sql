-- 0002_core_tenancy.sql
-- Tenants (farms), external workshops, user profiles, and workshop→farm grants.
-- Every business table below carries soft-delete columns; audit + RLS come later.

-- ── Farms (tenants) ───────────────────────────────────────────────
create table farms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  tier        farm_tier   not null default 'starter',
  status      farm_status not null default 'trial',
  settings    jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid
);
comment on column farms.settings is
  'Documented keys: vat_rate_bps (int, default 1500 = 15%), vat_inclusive_entry (bool), '
  'currency (text, "ZAR"), default_language (en|af), due_soon_hours (int, 25), '
  'due_soon_days (int, 14), stale_reading_days (int, 30), approval_required (bool), '
  'cost_visible_to_operators (bool), quiet_hours_start (int, 20), quiet_hours_end (int, 5).';

-- ── Workshops (external mechanic businesses; NOT farm-scoped) ──────
create table workshops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  contact     text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid
);

-- ── Users (profile rows; PK == auth.users.id) ─────────────────────
create table users (
  id              uuid primary key references auth.users(id) on delete cascade,
  farm_id         uuid references farms(id),
  workshop_id     uuid references workshops(id),
  role            user_role   not null,
  name            text        not null,
  phone           text,
  email           text,
  language        app_language not null default 'en',
  whatsapp_opt_in boolean     not null default false,
  active          boolean     not null default true,
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  -- role determines which scope column must be set
  constraint users_scope_ck check (
    (role = 'rr_admin' and farm_id is null and workshop_id is null) or
    (role = 'workshop' and farm_id is null and workshop_id is not null) or
    (role in ('owner','manager','mechanic','operator') and farm_id is not null and workshop_id is null)
  )
);
create index users_farm_idx     on users(farm_id);
create index users_workshop_idx on users(workshop_id);

-- ── Workshop links (grant a workshop scoped access to a farm) ─────
create table workshop_links (
  id          uuid primary key default gen_random_uuid(),
  workshop_id uuid not null references workshops(id),
  farm_id     uuid not null references farms(id),
  status      workshop_link_status not null default 'pending',
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  constraint workshop_links_uq unique (workshop_id, farm_id)
);
create index workshop_links_farm_idx     on workshop_links(farm_id);
create index workshop_links_workshop_idx on workshop_links(workshop_id);
