-- 0271_service_kits.sql
-- Service kits — feature F9 (FR-5.1, P0).
--
-- A service kit is the exact bill-of-materials a machine needs at a service: the
-- engine-oil / gearbox-oil / hydraulic-oil / filter PART NUMBERS + quantities. Unlike
-- `service_plan_lines` (0004), which are tasks + intervals (WHEN to service), a kit is
-- the parts (WHAT to fit). A kit is scoped either to one machine (machine_id) or to a
-- whole machine_type (a reusable template, machine_id null) — the scope check enforces
-- exactly one is set.
--
-- `service_kit_items` are the kit's parts. An item may reference a catalogue part
-- (0270) OR carry a free part_no, plus a quantity and an ex-VAT unit cost. Applying a
-- kit to a scheduled-service job card inserts one job_card_line per item; those lines
-- flow to cost_entries/TCO + history via the EXISTING 0211 job_card_lines trigger — no
-- separate kit→cost path exists, so there is no double-count.
--
-- House rules: farm_id + composite FK (machine-scoped), soft-delete, RLS, audit; money
-- integer cents ex-VAT (Scope §6).

-- ── Service kits (per machine, or a machine_type template) ────────
create table service_kits (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  machine_id   uuid,                 -- machine-level kit; null → a machine_type template
  machine_type machine_type,         -- type-level kit (applies to all machines of a type)
  name         text not null,
  notes        text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint service_kits_machine_fk foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint service_kits_farm_fk    foreign key (farm_id) references farms(id),
  constraint service_kits_id_farm_uq unique (id, farm_id),
  -- exactly one scope: a specific machine, or a machine_type template
  constraint service_kits_scope_ck check (machine_id is not null or machine_type is not null)
);
create index service_kits_farm_idx    on service_kits(farm_id);
create index service_kits_machine_idx on service_kits(machine_id);

-- ── Kit items (a catalogue part or a free part_no + qty) ──────────
create table service_kit_items (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null,
  service_kit_id    uuid not null,
  part_catalogue_id uuid,                     -- optional link to parts_catalogue (0270)
  part_no           text,
  description       text,
  qty               numeric(12,2) not null default 1,
  unit_cost_cents   bigint,                   -- ex-VAT, integer cents; prefills the job line
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint service_kit_items_kit_fk foreign key (service_kit_id, farm_id)
    references service_kits(id, farm_id) on delete cascade,
  constraint service_kit_items_farm_fk foreign key (farm_id) references farms(id),
  -- reference by id only (the part may be a GLOBAL catalogue row, farm_id null); the app
  -- only ever offers parts the user can read (RLS), so tenancy still holds.
  constraint service_kit_items_part_fk foreign key (part_catalogue_id) references parts_catalogue(id)
);
create index service_kit_items_kit_idx  on service_kit_items(service_kit_id);
create index service_kit_items_farm_idx on service_kit_items(farm_id);

-- ── RLS + grants (standard farm-scoped pattern, 0101/0102) ────────
do $do$
declare t text;
begin
  foreach t in array array['service_kits','service_kit_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using (app.has_farm_access(farm_id) and deleted_at is null)', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (app.has_farm_access(farm_id))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app_audit()', t || '_audit', t);
  end loop;
end $do$;
