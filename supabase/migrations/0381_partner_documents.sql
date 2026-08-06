-- 0381_partner_documents.sql
-- F14b — Quotes & invoices with real line items, the largest thing AutoVault had and
-- FleetWise did not. Until now a work request carried `quote_amount_cents` and
-- `invoice_amount_cents`: two integers, no document, nothing a farmer could be handed.
--
-- ONE TABLE, TWO KINDS. AutoVault kept `quotes`/`quote_items` and `invoices`/
-- `invoice_items` as separate pairs, then spent five later migrations dragging the two
-- back into step (issue_date, discounts, snapshots, tax on lines — added to both, twice).
-- A quote and an invoice differ in their status vocabulary and in one link (an invoice
-- may descend from a quote); everything else is identical. So: one `partner_documents`
-- table with a `kind`, one line table, and a status enum that spans both. Converting a
-- quote to an invoice becomes a copy, not a translation between two schemas.
--
-- BUILT OR UPLOADED — the partner chooses. `source = 'built'` means the partner used
-- FleetWise to build the document and we own the lines and totals. `source = 'uploaded'`
-- means they run Sage/Xero/a paper book and simply handed us the finished PDF; we store
-- the file and the total so the farmer sees it and the cost lands in the ledger, and we
-- do not pretend to know the line items. A partner is never forced onto our invoicing to
-- be useful to their customers.
--
-- MONEY follows the house rule: integer cents, ex-VAT, with `vat_rate_bps` captured.
-- Lines are ex-VAT; the document's VAT and inclusive total are derived by trigger, never
-- typed. Partial payments are recorded rows, not a mutated balance.
--
-- TENANCY. `farm_id` is the CUSTOMER farm, `workshop_id` the ISSUING partner. RLS is the
-- usual `app.has_farm_access(farm_id)` — which already admits a linked workshop — NARROWED
-- for the workshop role to its own documents (F7's rule, so two contractors serving one
-- farm never see each other's pricing) and closed to operators (a driver has no business
-- in the farm's payables).

-- ── Enums ─────────────────────────────────────────────────────────
create type partner_doc_kind   as enum ('quote', 'invoice');
create type partner_doc_source as enum ('built', 'uploaded');

-- One vocabulary across both kinds. A quote walks draft→sent→accepted|declined; an
-- invoice walks draft→sent→(part_paid)→paid. `cancelled` and `expired` end either.
create type partner_doc_status as enum
  ('draft', 'sent', 'accepted', 'declined', 'part_paid', 'paid', 'cancelled', 'expired');

-- ── partner_documents ─────────────────────────────────────────────
create table partner_documents (
  id                uuid primary key default gen_random_uuid(),
  farm_id           uuid not null,                  -- the customer
  workshop_id       uuid not null references workshops(id),  -- the issuer
  machine_id        uuid,                           -- optional: the vehicle it concerns
  work_request_id   uuid,                           -- optional: the job it came from
  quote_id          uuid,                           -- an invoice's originating quote
  kind              partner_doc_kind   not null,
  status            partner_doc_status not null default 'draft',
  source            partner_doc_source not null default 'built',
  number            text not null,                  -- e.g. INV-0007, per-partner sequence
  subject           text,
  issue_date        date not null default current_date,
  due_date          date,                           -- invoice due date / quote valid until
  currency          text not null default 'ZAR',
  -- Totals. Derived from the lines by trigger for `built` documents; typed once (into
  -- subtotal + vat) for `uploaded` ones, where there are no lines to derive from.
  subtotal_cents    bigint not null default 0,      -- ex-VAT, before document discount
  discount_cents    bigint not null default 0,      -- ex-VAT, whole-document discount
  vat_cents         bigint not null default 0,
  total_cents       bigint not null default 0,      -- VAT-inclusive: what the farmer pays
  vat_rate_bps      int    not null default 1500,
  amount_paid_cents bigint not null default 0,      -- maintained from partner_payments
  notes             text,                           -- shown to the customer
  terms             text,                           -- snapshot of the partner's terms
  declined_reason   text,
  -- The letterhead as it was when the document was issued. A partner who rebrands next
  -- year must not silently restate last year's invoice, and a farmer must be able to
  -- reprint exactly what they were sent. Same reasoning as AutoVault's
  -- `workshop_snapshot`/`customer_snapshot`.
  issuer_snapshot   jsonb,
  customer_snapshot jsonb,
  upload_path       text,                           -- object key when source='uploaded'
  sent_at           timestamptz,
  accepted_at       timestamptz,
  declined_at       timestamptz,
  paid_at           timestamptz,
  created_by        uuid references users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,
  constraint partner_documents_machine_fk foreign key (machine_id, farm_id)      references machines(id, farm_id),
  constraint partner_documents_wr_fk      foreign key (work_request_id, farm_id) references work_requests(id, farm_id),
  constraint partner_documents_quote_fk   foreign key (quote_id, farm_id)        references partner_documents(id, farm_id),
  constraint partner_documents_farm_fk    foreign key (farm_id) references farms(id),
  constraint partner_documents_id_farm_uq unique (id, farm_id),
  -- A number is unique within the issuing partner and kind, never globally.
  constraint partner_documents_number_uq  unique (workshop_id, kind, number),
  constraint partner_documents_vat_ck     check (vat_rate_bps between 0 and 10000),
  -- An uploaded document is only meaningful with the file attached to it.
  constraint partner_documents_upload_ck  check (source <> 'uploaded' or upload_path is not null)
);
create index partner_documents_farm_idx     on partner_documents(farm_id, kind, status);
create index partner_documents_workshop_idx on partner_documents(workshop_id, status);
create index partner_documents_machine_idx  on partner_documents(machine_id);
create index partner_documents_wr_idx       on partner_documents(work_request_id);

-- ── partner_document_lines ────────────────────────────────────────
-- Quantity is numeric, not int: half an hour of labour and 2.5 litres of oil are both
-- ordinary. (AutoVault shipped `qty int` and needed two later migrations to widen it.)
create table partner_document_lines (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null,          -- mirrored for the composite FK + RLS
  document_id      uuid not null,
  sort_order       int  not null default 0,
  kind             job_line_kind not null default 'part',  -- reuses the job-card vocabulary
  part_no          text,
  description      text not null,
  qty              numeric(12,3) not null default 1,
  unit_price_cents bigint not null default 0,   -- ex-VAT
  discount_cents   bigint not null default 0,   -- ex-VAT, this line only
  line_total_cents bigint not null default 0,   -- ex-VAT; derived, never typed
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  deleted_by       uuid,
  constraint partner_document_lines_doc_fk  foreign key (document_id, farm_id)
    references partner_documents(id, farm_id) on delete cascade,
  constraint partner_document_lines_farm_fk foreign key (farm_id) references farms(id),
  constraint partner_document_lines_qty_ck  check (qty >= 0)
);
create index partner_document_lines_doc_idx on partner_document_lines(document_id, sort_order);

-- ── partner_payments ──────────────────────────────────────────────
-- Payments are rows, so "R5 000 of R12 000, EFT, ref 4471, proof attached" survives; the
-- document's `amount_paid_cents` is a maintained rollup, not the source of truth.
create table partner_payments (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  document_id  uuid not null,
  amount_cents bigint not null,          -- VAT-inclusive, as actually paid
  paid_on      date not null default current_date,
  method       text,                     -- eft | cash | card | other (free text)
  reference    text,
  proof_path   text,                     -- object key of the proof of payment
  note         text,
  recorded_by  uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint partner_payments_doc_fk  foreign key (document_id, farm_id)
    references partner_documents(id, farm_id) on delete cascade,
  constraint partner_payments_farm_fk foreign key (farm_id) references farms(id)
);
create index partner_payments_doc_idx on partner_payments(document_id, paid_on);

-- ══════════════════════════════════════════════════════════════════
-- Derived totals — typed once, computed everywhere else
-- ══════════════════════════════════════════════════════════════════

-- Line total = qty × unit price − line discount, ex-VAT.
create or replace function app_partner_line_total() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.line_total_cents :=
    greatest(0, round(new.qty * new.unit_price_cents)::bigint - coalesce(new.discount_cents, 0));
  return new;
end $$;

create trigger partner_document_lines_total
  before insert or update on partner_document_lines
  for each row execute function app_partner_line_total();

-- Document totals from its lines. Skipped for `uploaded` documents, which have no lines
-- and whose totals were entered from the partner's own paperwork.
create or replace function app_partner_document_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_doc uuid := coalesce(new.document_id, old.document_id);
  v_sub bigint;
begin
  select coalesce(sum(line_total_cents), 0) into v_sub
    from partner_document_lines where document_id = v_doc and deleted_at is null;

  update partner_documents d
     set subtotal_cents = v_sub,
         vat_cents      = round((v_sub - least(d.discount_cents, v_sub)) * d.vat_rate_bps / 10000.0)::bigint,
         total_cents    = (v_sub - least(d.discount_cents, v_sub))
                          + round((v_sub - least(d.discount_cents, v_sub)) * d.vat_rate_bps / 10000.0)::bigint,
         updated_at     = now()
   where d.id = v_doc and d.source = 'built';

  return null;
end $$;

create trigger partner_document_lines_rollup
  after insert or update or delete on partner_document_lines
  for each row execute function app_partner_document_totals();

-- Recompute when the document's own VAT rate or discount moves.
create or replace function app_partner_document_self_totals() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sub bigint; v_net bigint;
begin
  if new.source <> 'built' then return new; end if;
  select coalesce(sum(line_total_cents), 0) into v_sub
    from partner_document_lines where document_id = new.id and deleted_at is null;
  v_net := v_sub - least(coalesce(new.discount_cents, 0), v_sub);
  new.subtotal_cents := v_sub;
  new.vat_cents      := round(v_net * new.vat_rate_bps / 10000.0)::bigint;
  new.total_cents    := v_net + new.vat_cents;
  return new;
end $$;

create trigger partner_documents_self_totals
  before update of vat_rate_bps, discount_cents on partner_documents
  for each row execute function app_partner_document_self_totals();

-- Payments roll up into the document, and move an invoice's status with them.
create or replace function app_partner_payment_rollup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_doc  uuid := coalesce(new.document_id, old.document_id);
  v_paid bigint;
begin
  select coalesce(sum(amount_cents), 0) into v_paid
    from partner_payments where document_id = v_doc and deleted_at is null;

  update partner_documents d
     set amount_paid_cents = v_paid,
         status = case
           when d.kind <> 'invoice' or d.status in ('cancelled', 'draft') then d.status
           when v_paid >= d.total_cents and d.total_cents > 0 then 'paid'
           when v_paid > 0 then 'part_paid'
           else 'sent'
         end,
         paid_at = case
           when d.kind = 'invoice' and v_paid >= d.total_cents and d.total_cents > 0
             then coalesce(d.paid_at, now())
           else null
         end,
         updated_at = now()
   where d.id = v_doc;

  return null;
end $$;

create trigger partner_payments_rollup
  after insert or update or delete on partner_payments
  for each row execute function app_partner_payment_rollup();

-- ══════════════════════════════════════════════════════════════════
-- Invoice → cost ledger, exactly once (the no-double-count rule)
-- ══════════════════════════════════════════════════════════════════
-- The farm's TCO must not count the same money twice, and there are now TWO ways a
-- partner's bill can reach it: the F12b work-request `invoice_amount_cents` (0311) and a
-- real invoice document here. The rule is simple and one-directional:
--
--   A partner INVOICE DOCUMENT, once issued, owns the cost for its work request.
--
-- So this trigger upserts a single `invoice` cost entry keyed
-- (source_type='partner_document', source_id=document.id), and soft-deletes the
-- work-request-sourced entry for the same job. 0311 is replaced below to stand down
-- whenever such a document exists, so the two can never race back and forth. A QUOTE is
-- never costed — it is not money owed. Amount booked is ex-VAT (subtotal − discount),
-- consistent with every other entry in the ledger.
create or replace function app_cost_from_partner_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_net bigint; v_live boolean;
begin
  v_net  := greatest(0, new.subtotal_cents - least(new.discount_cents, new.subtotal_cents));
  v_live := new.deleted_at is null
        and new.kind = 'invoice'
        and new.status in ('sent', 'part_paid', 'paid')
        and v_net > 0;

  if not v_live then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'partner_document' and source_id = new.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'partner_document' and source_id = new.id) then
    update cost_entries
       set farm_id = new.farm_id, machine_id = new.machine_id, type = 'invoice',
           amount_cents = v_net, vat_rate_bps = new.vat_rate_bps,
           deleted_at = null, deleted_by = null
     where source_type = 'partner_document' and source_id = new.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps,
                              source_type, source_id, occurred_on, created_by, note)
    values (new.farm_id, new.machine_id, 'invoice', v_net, new.vat_rate_bps,
            'partner_document', new.id, new.issue_date, new.created_by, new.number);
  end if;

  -- Stand the work-request entry down (or back up) so the job is costed once.
  if new.work_request_id is not null then
    if v_live then
      update cost_entries set deleted_at = coalesce(deleted_at, now())
        where source_type = 'work_request' and source_id = new.work_request_id and deleted_at is null;
    else
      update work_requests set updated_at = now() where id = new.work_request_id;  -- re-fire 0311
    end if;
  end if;

  return null;
end $$;

create trigger partner_documents_cost
  after insert or update on partner_documents
  for each row execute function app_cost_from_partner_document();

-- 0311, replaced: yield to a live invoice document for the same request.
create or replace function app_cost_from_work_request() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amount bigint;
  v_yield  boolean;
begin
  v_amount := coalesce(new.invoice_amount_cents, 0);
  v_yield  := exists (
    select 1 from partner_documents pd
     where pd.work_request_id = new.id and pd.kind = 'invoice'
       and pd.deleted_at is null and pd.status in ('sent', 'part_paid', 'paid')
  );

  if new.deleted_at is not null or v_amount <= 0 or v_yield then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'work_request' and source_id = new.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'work_request' and source_id = new.id) then
    update cost_entries
       set farm_id = new.farm_id, machine_id = new.machine_id, type = 'invoice',
           amount_cents = v_amount, vat_rate_bps = new.vat_rate_bps,
           deleted_at = null, deleted_by = null
     where source_type = 'work_request' and source_id = new.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps,
                              source_type, source_id, occurred_on, created_by)
    values (new.farm_id, new.machine_id, 'invoice', v_amount, new.vat_rate_bps,
            'work_request', new.id, current_date, new.created_by);
  end if;

  return new;
end $$;

-- ══════════════════════════════════════════════════════════════════
-- Tell the farmer — a document arriving is news
-- ══════════════════════════════════════════════════════════════════
create or replace function app_partner_document_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'sent' and (tg_op = 'INSERT' or old.status is distinct from 'sent') then
    perform app.notify_farm(new.farm_id,
      case when new.kind = 'quote' then 'partner_quote_received' else 'partner_invoice_received' end,
      jsonb_build_object('document_id', new.id, 'machine_id', new.machine_id,
                         'number', new.number, 'amount_cents', new.total_cents,
                         'workshop_id', new.workshop_id));
  end if;
  return null;
end $$;

create trigger partner_documents_notify
  after insert or update on partner_documents
  for each row execute function app_partner_document_notify();

-- ══════════════════════════════════════════════════════════════════
-- RLS + grants
-- ══════════════════════════════════════════════════════════════════
-- Visibility rule, in one place so the three tables cannot drift apart:
--   * rr_admin sees everything (as everywhere else);
--   * a workshop sees only documents IT issued, on farms it is linked to — two
--     contractors serving the same farm never see each other's pricing (F7's rule);
--   * an operator sees none — a driver has no business in the farm's payables;
--   * everyone else with farm access (owner/manager/mechanic) sees the farm's documents.
create or replace function app.partner_doc_visible(p_farm uuid, p_workshop uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_farm_access(p_farm)
     and (app.current_app_role() is distinct from 'workshop' or p_workshop = app.user_workshop_id())
     and (app.current_app_role() is distinct from 'operator' or app.is_rr_admin());
$$;

-- Same rule reached through a child row's parent document.
create or replace function app.partner_doc_visible_by_id(p_doc uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.partner_documents d
     where d.id = p_doc and app.partner_doc_visible(d.farm_id, d.workshop_id)
  );
$$;

revoke execute on function app.partner_doc_visible(uuid, uuid)  from public, anon;
revoke execute on function app.partner_doc_visible_by_id(uuid)  from public, anon;
grant  execute on function app.partner_doc_visible(uuid, uuid)  to authenticated, service_role;
grant  execute on function app.partner_doc_visible_by_id(uuid)  to authenticated, service_role;

alter table partner_documents enable row level security;
alter table partner_documents force  row level security;
create policy partner_documents_sel on partner_documents for select to authenticated
  using (deleted_at is null and app.partner_doc_visible(farm_id, workshop_id));
-- Who may create one: the issuing partner, or the farm's owner/manager recording a
-- document they were handed on paper. (rr_admin is inside app.partner_doc_visible.)
create policy partner_documents_ins on partner_documents for insert to authenticated
  with check (
    app.partner_doc_visible(farm_id, workshop_id)
    and (workshop_id = app.user_workshop_id()
         or app.current_app_role() in ('owner', 'manager')
         or app.is_rr_admin())
  );
create policy partner_documents_upd on partner_documents for update to authenticated
  using (
    app.partner_doc_visible(farm_id, workshop_id)
    and (workshop_id = app.user_workshop_id()
         or app.current_app_role() in ('owner', 'manager')
         or app.is_rr_admin())
  )
  with check (app.partner_doc_visible(farm_id, workshop_id));
create policy partner_documents_del on partner_documents for delete to authenticated
  using (
    app.partner_doc_visible(farm_id, workshop_id)
    and (workshop_id = app.user_workshop_id() or app.is_rr_admin())
  );

do $do$
declare t text;
begin
  foreach t in array array['partner_document_lines', 'partner_payments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format('create policy %1$I_sel on public.%1$I for select to authenticated '
                   'using (deleted_at is null and app.partner_doc_visible_by_id(document_id))', t);
    execute format('create policy %1$I_ins on public.%1$I for insert to authenticated '
                   'with check (app.partner_doc_visible_by_id(document_id))', t);
    execute format('create policy %1$I_upd on public.%1$I for update to authenticated '
                   'using (app.partner_doc_visible_by_id(document_id)) '
                   'with check (app.partner_doc_visible_by_id(document_id))', t);
    execute format('create policy %1$I_del on public.%1$I for delete to authenticated '
                   'using (app.partner_doc_visible_by_id(document_id))', t);
  end loop;
end $do$;

do $do$
declare t text;
begin
  foreach t in array array['partner_documents', 'partner_document_lines', 'partner_payments'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('create trigger %1$I_audit after insert or update or delete on public.%1$I '
                   'for each row execute function app_audit()', t);
  end loop;
end $do$;
-- anon gets ZERO access (0102 default privileges revoke it; no anon policy exists).

-- Trigger-only helpers stay off the PostgREST RPC surface (0205/0211/0311 pattern).
revoke execute on function
  app_partner_line_total(), app_partner_document_totals(), app_partner_document_self_totals(),
  app_partner_payment_rollup(), app_cost_from_partner_document(), app_partner_document_notify()
from anon, authenticated, public;

-- ── Uploaded documents + proofs live in `attachments` ─────────────
alter table attachments drop constraint attachments_parent_type_ck;
alter table attachments add  constraint attachments_parent_type_ck
  check (parent_type in ('machine', 'fault', 'job_card', 'job_card_line',
                         'checklist_instance', 'work_request', 'partner_document'));
