-- 0290_checklists.sql
-- Feature F11 — Vehicle checklists + template builder (provider-spec §7).
--
-- Mirrors RapidRiseAi/TJ-autovault's inspection template → report pattern
-- (inspection_templates / inspection_template_fields / inspection_reports), adapted to
-- FleetWise house rules: farm_id tenancy + composite FKs, RLS as the sole isolation
-- guarantor, the append-only audit trigger, and soft-delete on every table.
--
-- Four tables:
--   * checklist_templates       — a named, reusable checklist. FARM-owned, or GLOBAL
--     (RR-seeded library) when farm_id is null — visibility mirrors service_templates
--     (0004/0101): a global row is readable by every authenticated user; a farm row is
--     governed by app.has_farm_access.
--   * checklist_template_fields — the template's ordered fields. Field types:
--     checkbox / text / number / photo / rating / section_break. farm_id MIRRORS the
--     parent template (null for a global template); a composite FK keeps a FARM
--     template's fields farm-isolated.
--   * checklist_instances       — a FILLED checklist ("report") for one machine:
--     pre-use inspection, service sign-off, condition report. Optionally tied to a job
--     card (and, later, a contractor work request — F12).
--   * checklist_instance_values — one row per template field at fill time (value + note +
--     optional photo attachment). The field's label/type/order are SNAPSHOTTED so a
--     completed checklist renders faithfully even if the template later changes.
--
-- Photo-type fields reuse the polymorphic `attachments` table (kind=photo,
-- parent_type=checklist_instance) written to the farm-scoped `checklist-photos` bucket
-- (0291). A value points at its photo through a composite FK to attachments(id, farm_id)
-- — the same-farm reference key added in 0280 — so a value can never cite another
-- tenant's photo. Plain, Supabase- and local-Postgres-compatible DDL.

-- ── checklist_templates (farm-owned, or GLOBAL when farm_id is null) ──
create table checklist_templates (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid references farms(id),   -- null = GLOBAL (RR-seeded library)
  machine_type machine_type,                -- optional: suggest for a machine type
  name         text not null,
  description  text,
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  -- (id, farm_id) is trivially unique (id is the PK) and gives the child composite FK
  -- its required reference target.
  constraint checklist_templates_id_farm_uq unique (id, farm_id)
);
create index checklist_templates_farm_idx on checklist_templates(farm_id);

-- ── checklist_template_fields (ordered fields of a template) ──────
create table checklist_template_fields (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null,
  farm_id     uuid,                          -- MIRRORS the template (null for a global one)
  sort_order  int  not null default 0,
  field_type  text not null,
  label       text not null,
  required    boolean not null default false,
  help_text   text,
  config      jsonb,                         -- field extras, e.g. {"max":5} for a rating
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  constraint checklist_template_fields_type_ck
    check (field_type in ('checkbox','text','number','photo','rating','section_break')),
  -- Referential integrity + cascade for ALL rows (global and farm): a hard delete of a
  -- template removes its fields.
  constraint checklist_template_fields_template_fk
    foreign key (template_id) references checklist_templates(id) on delete cascade,
  -- Tenant isolation for FARM templates: a farm field must reference a template of the
  -- SAME farm. (For a global template both farm_ids are null → MATCH SIMPLE skips the
  -- check; global rows are RR-admin-managed only, enforced by RLS.)
  constraint checklist_template_fields_template_farm_fk
    foreign key (template_id, farm_id) references checklist_templates(id, farm_id)
);
create index checklist_template_fields_template_idx on checklist_template_fields(template_id);
create index checklist_template_fields_farm_idx on checklist_template_fields(farm_id);

-- ── checklist_instances (a filled checklist for one machine) ──────
create table checklist_instances (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null,
  machine_id      uuid not null,
  template_id     uuid,                       -- source template (may be global); snapshot below
  template_name   text not null,              -- snapshot of the template name at fill time
  job_card_id     uuid,                        -- optional link to a job card
  work_request_id uuid,                        -- optional link to a contractor work request (F12; no FK yet)
  status          text not null default 'completed',
  meter_reading   numeric(12,1),              -- optional meter capture at inspection time
  notes           text,
  performed_by    uuid references users(id),
  completed_at    timestamptz,
  created_by      uuid references users(id),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  constraint checklist_instances_status_ck check (status in ('draft','completed')),
  constraint checklist_instances_machine_fk foreign key (machine_id, farm_id)
    references machines(id, farm_id),
  constraint checklist_instances_jobcard_fk foreign key (job_card_id, farm_id)
    references job_cards(id, farm_id),
  constraint checklist_instances_template_fk foreign key (template_id)
    references checklist_templates(id) on delete set null,
  constraint checklist_instances_farm_fk foreign key (farm_id) references farms(id),
  constraint checklist_instances_id_farm_uq unique (id, farm_id)
);
create index checklist_instances_farm_idx    on checklist_instances(farm_id);
create index checklist_instances_machine_idx on checklist_instances(machine_id);
create index checklist_instances_jobcard_idx on checklist_instances(job_card_id);

-- ── checklist_instance_values (one row per field at fill time) ────
create table checklist_instance_values (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null,
  instance_id       uuid not null,
  template_field_id uuid,                     -- source field (may later be gone); snapshot below
  sort_order        int  not null default 0,
  field_type        text not null,            -- snapshot
  label             text not null,            -- snapshot
  value_text        text,                     -- serialized value (checkbox true/false, number, rating, text)
  notes             text,                     -- per-field note
  attachment_id     uuid,                     -- photo fields: a farm-isolated attachment
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint checklist_instance_values_field_type_ck
    check (field_type in ('checkbox','text','number','photo','rating','section_break')),
  constraint checklist_instance_values_instance_fk foreign key (instance_id, farm_id)
    references checklist_instances(id, farm_id) on delete cascade,
  constraint checklist_instance_values_field_fk foreign key (template_field_id)
    references checklist_template_fields(id) on delete set null,
  -- The photo must belong to the SAME farm (0280 gave attachments a (id, farm_id) key).
  constraint checklist_instance_values_attachment_fk foreign key (attachment_id, farm_id)
    references attachments(id, farm_id),
  constraint checklist_instance_values_farm_fk foreign key (farm_id) references farms(id)
);
create index checklist_instance_values_instance_idx on checklist_instance_values(instance_id);
create index checklist_instance_values_farm_idx     on checklist_instance_values(farm_id);

-- ── attachments: allow checklist photos as a parent type ──────────
alter table attachments drop constraint attachments_parent_type_ck;
alter table attachments add constraint attachments_parent_type_ck
  check (parent_type in ('machine','fault','job_card','job_card_line','checklist_instance'));

-- ── RLS: templates + fields mirror service_templates (global readable by all) ──
do $do$
declare t text;
begin
  foreach t in array array['checklist_templates','checklist_template_fields'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using ((farm_id is null or app.has_farm_access(farm_id)) and deleted_at is null)', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id))', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id)) with check (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id))', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (app.is_rr_admin() or (farm_id is not null and app.user_farm_id() = farm_id))', t);
  end loop;
end $do$;

-- ── RLS: instances + values are the standard farm-scoped pattern (0101) ──
do $do$
declare t text;
begin
  foreach t in array array['checklist_instances','checklist_instance_values'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using (app.has_farm_access(farm_id) and deleted_at is null)', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (app.has_farm_access(farm_id))', t);
  end loop;
end $do$;

-- ── Grants + audit for all four tables (anon stays at ZERO — 0102 default revoke) ──
do $do$
declare t text;
begin
  foreach t in array array['checklist_templates','checklist_template_fields','checklist_instances','checklist_instance_values'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app_audit()', t || '_audit', t);
  end loop;
end $do$;
