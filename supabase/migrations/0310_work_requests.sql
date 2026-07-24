-- 0310_work_requests.sql
-- Work-request flow (F12b) — the heart of the contractor value (spec §3).
--
-- A `work_request` is a farmer-initiated job sent to an assigned contractor (a
-- `workshop`, 0002/0300). It is pre-filled with the vehicle it concerns and moves
-- through a fixed status lifecycle:
--   requested → viewed → quoted → accepted → in_progress → completed → invoiced → closed
-- Each transition (plus free-text progress notes) is recorded in `work_request_events`
-- for the timeline. Quote/invoice amounts are captured ex-VAT cents; the invoice amount
-- flows into the machine's TCO ledger via the sync trigger in 0311 (the ONLY costed
-- path — no double-count).
--
-- Tenancy is the usual denormalized farm_id + composite FK. RLS uses
-- app.has_farm_access(farm_id), which already grants access to BOTH the farm's crew AND
-- a workshop linked to that farm through an active workshop_link (0100/0101) — so the
-- assigned contractor can see and update exactly the farms they serve, nothing else.
-- Audit + soft-delete + anon-zero-DB per house rules.

-- ── Enums ─────────────────────────────────────────────────────────
create type work_request_kind     as enum ('repair','quote','inspection','parts','other');
create type work_request_status   as enum
  ('requested','viewed','quoted','accepted','in_progress','completed','invoiced','closed');
create type work_request_priority as enum ('low','normal','high','urgent');

-- ── work_requests ─────────────────────────────────────────────────
create table work_requests (
  id                   uuid primary key default gen_random_uuid(),
  farm_id              uuid not null,
  machine_id           uuid not null,
  workshop_id          uuid references workshops(id),   -- assigned contractor (nullable pre-assign)
  kind                 work_request_kind     not null default 'repair',
  status               work_request_status   not null default 'requested',
  priority             work_request_priority not null default 'normal',
  title                text,
  description          text,
  quote_amount_cents   bigint,   -- ex-VAT cents; recorded, NOT costed until invoiced
  invoice_amount_cents bigint,   -- ex-VAT cents; the single costed path (0311 trigger)
  vat_rate_bps         int,      -- VAT rate captured for VAT-inclusive → ex-VAT conversion
  job_card_id          uuid,     -- set when converted/attached to a job card (0311 keeps costs unified)
  created_by           uuid references users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  deleted_by           uuid,
  constraint work_requests_machine_fk  foreign key (machine_id, farm_id) references machines(id, farm_id),
  constraint work_requests_jobcard_fk  foreign key (job_card_id, farm_id) references job_cards(id, farm_id),
  constraint work_requests_farm_fk     foreign key (farm_id) references farms(id),
  constraint work_requests_id_farm_uq  unique (id, farm_id)
);
create index work_requests_farm_idx        on work_requests(farm_id);
create index work_requests_machine_idx     on work_requests(machine_id);
create index work_requests_workshop_idx    on work_requests(workshop_id);
create index work_requests_farm_status_idx on work_requests(farm_id, status);

-- ── work_request_events (status-change history + progress notes) ───
create table work_request_events (
  id              uuid primary key default gen_random_uuid(),
  farm_id         uuid not null,
  work_request_id uuid not null,
  from_status     work_request_status,           -- null for the opening event
  to_status       work_request_status not null,
  note            text,
  by_user         uuid references users(id),
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  deleted_by      uuid,
  constraint work_request_events_wr_fk   foreign key (work_request_id, farm_id) references work_requests(id, farm_id) on delete cascade,
  constraint work_request_events_farm_fk foreign key (farm_id) references farms(id)
);
create index work_request_events_wr_idx   on work_request_events(work_request_id, created_at);
create index work_request_events_farm_idx on work_request_events(farm_id);

-- ── RLS + grants (standard farm-scoped pattern, 0101/0102) ────────
-- app.has_farm_access(farm_id) already resolves the linked-workshop side, so the
-- assigned contractor gets exactly the same row visibility/mutation as the farm crew
-- for the farms they serve — nothing cross-tenant.
do $do$
declare t text;
begin
  foreach t in array array['work_requests','work_request_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated using (app.has_farm_access(farm_id) and deleted_at is null)', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated using (app.has_farm_access(farm_id)) with check (app.has_farm_access(farm_id))', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated using (app.has_farm_access(farm_id))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $do$;
-- anon gets ZERO access (0102 default privileges revoke it; no anon policy exists).

-- ── Audit (append-only history, per 0008) ─────────────────────────
create trigger work_requests_audit
  after insert or update or delete on work_requests
  for each row execute function app_audit();
create trigger work_request_events_audit
  after insert or update or delete on work_request_events
  for each row execute function app_audit();

-- ── Allow work-request media in `attachments` (proof/quote/invoice) ─
-- Proof photos + quote/invoice files reuse the F1 attachments + jobcard-photos storage
-- pattern; widen the parent_type whitelist to admit 'work_request'.
alter table attachments drop constraint attachments_parent_type_ck;
alter table attachments add  constraint attachments_parent_type_ck
  check (parent_type in ('machine','fault','job_card','job_card_line','checklist_instance','work_request'));
