-- 0410_billing_identity_and_recipients.sql
-- G2a — Who a document is addressed to, and the details that make it a tax invoice.
--
-- ── TWO PROBLEMS, ONE SHAPE ──────────────────────────────────────────────────
--
-- 1. `farms` carried a name and nothing else. So every invoice a partner issued through
--    FleetWise printed the SUPPLIER's VAT number and address in full and reduced the
--    RECIPIENT to one line of free text. Section 20(4) of the VAT Act requires a full tax
--    invoice to carry the recipient's name, address AND VAT registration number for a
--    supply over R5 000 — so a VAT-registered farmer could not claim the input tax on
--    anything we produced. On a R40 000 repair that is about R5 200 the farmer simply
--    loses, and they find out at their VAT return rather than at the moment we could
--    have prevented it.
--
-- 2. `partner_documents.farm_id` was `not null`, so a partner could only ever invoice a
--    FleetWise tenant. That sits directly against the client book: `partner_clients`
--    exists precisely to hold a customer who is NOT on FleetWise, and a partner could
--    record them, note their vehicles and phone them — but not bill them. The pitch is
--    "run your business on FleetWise"; what they could actually do was run the FleetWise
--    slice of it and keep their old system for everyone else, which means they keep the
--    old system.
--
-- Both are the same question — WHO is this document for — so they are answered together.
--
-- ── THE MODEL ────────────────────────────────────────────────────────────────
--
-- A document has exactly one recipient, in one of three forms:
--
--   farm_id set             a FleetWise farm. The farmer sees the document in their own
--                           app, and an invoice books into their cost ledger. Unchanged.
--   partner_client_id set   someone in the partner's own client book who is not on
--                           FleetWise. Only the partner ever sees it.
--   neither set             a one-time customer, typed straight onto the document. No
--                           record to create first — which is the point: a walk-in job
--                           should not require filing a customer before you can bill it.
--
-- The BILLING DETAILS live on the document in all three cases (`bill_to_*`), seeded from
-- the farm or the client and then editable, because the details that were true when the
-- document was issued are what belongs on it. That is the same reasoning as
-- `issuer_snapshot`: a customer who moves premises next year must not silently restate
-- last year's invoice.

-- ── 1. A farm's billing identity ─────────────────────────────────────────────
alter table farms
  add column trading_name    text,
  add column reg_number      text,
  add column vat_number      text,
  add column billing_address text,
  add column billing_email   text;

comment on column farms.vat_number is
  'The farm''s VAT registration number. Printed on any tax invoice raised against them — '
  'without it a supply over R5 000 is not a full tax invoice under VAT Act s20(4) and the '
  'farmer cannot claim the input tax.';

-- ── 2. A client's billing identity ───────────────────────────────────────────
-- `partner_clients` held a name, a contact and an address: an address-book entry rather
-- than an account. Commercial terms were retyped on every document.
alter table partner_clients
  add column trading_name       text,
  add column reg_number         text,
  add column vat_number         text,
  add column payment_terms_days int,
  add column credit_limit_cents bigint,
  add constraint partner_clients_terms_ck check (payment_terms_days is null or payment_terms_days between 0 and 365),
  add constraint partner_clients_limit_ck check (credit_limit_cents is null or credit_limit_cents >= 0);

-- ── 3. The document's recipient ──────────────────────────────────────────────
-- `farm_id` becomes nullable. Its composite foreign keys are MATCH SIMPLE, so they stop
-- being enforced exactly when the column is null — which is correct, because a document
-- with no farm also has no machine and no work request to point at.
alter table partner_documents
  alter column farm_id drop not null,
  add column partner_client_id uuid references partner_clients(id),
  add column bill_to_name       text,
  add column bill_to_contact    text,
  add column bill_to_email      text,
  add column bill_to_phone      text,
  add column bill_to_address    text,
  add column bill_to_vat_number text,
  add column bill_to_reg_number text,
  add column bill_to_reference  text;   -- the customer's own order/reference number

comment on column partner_documents.bill_to_name is
  'Who the document is made out to, as it prints. Seeded from the farm or the client and '
  'then editable — the details true at issue are what belongs on the document.';

-- The lines and payments inherit the farm through a composite FK, so they have to be
-- nullable in step or a client-only document could carry no lines at all.
alter table partner_document_lines alter column farm_id drop not null;
alter table partner_payments       alter column farm_id drop not null;

-- Backfill: every existing document is addressed to its farm.
update partner_documents d
   set bill_to_name       = coalesce(d.bill_to_name, f.name),
       bill_to_address    = coalesce(d.bill_to_address, f.billing_address),
       bill_to_vat_number = coalesce(d.bill_to_vat_number, f.vat_number)
  from farms f
 where f.id = d.farm_id;

-- Seed the bill-to from whoever the document names, so no caller has to copy six fields
-- by hand and none of them can copy five. Only fills what was left blank: a partner
-- correcting a customer's address on one document is editing the document, not the
-- customer record, which is the behaviour that makes "the details true at issue" work.
create or replace function app_partner_document_addressee() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare src record;
begin
  if new.farm_id is not null then
    select coalesce(f.trading_name, f.name) as name, null::text as contact, f.billing_email as email,
           null::text as phone, f.billing_address as address, f.vat_number, f.reg_number
      into src from farms f where f.id = new.farm_id;
  elsif new.partner_client_id is not null then
    select coalesce(c.trading_name, c.name) as name, c.contact_name as contact, c.email,
           c.phone, c.address, c.vat_number, c.reg_number
      into src from partner_clients c where c.id = new.partner_client_id;
  else
    return new;                          -- a one-time customer: typed onto the document
  end if;

  new.bill_to_name       := coalesce(new.bill_to_name,       src.name);
  new.bill_to_contact    := coalesce(new.bill_to_contact,    src.contact);
  new.bill_to_email      := coalesce(new.bill_to_email,      src.email);
  new.bill_to_phone      := coalesce(new.bill_to_phone,      src.phone);
  new.bill_to_address    := coalesce(new.bill_to_address,    src.address);
  new.bill_to_vat_number := coalesce(new.bill_to_vat_number, src.vat_number);
  new.bill_to_reg_number := coalesce(new.bill_to_reg_number, src.reg_number);
  return new;
end $$;

create trigger partner_documents_addressee
  before insert on partner_documents
  for each row execute function app_partner_document_addressee();

revoke execute on function app_partner_document_addressee() from anon, authenticated, public;

-- A document must be addressed to someone, and to exactly one someone.
alter table partner_documents
  add constraint partner_documents_recipient_ck check (
    bill_to_name is not null
    and not (farm_id is not null and partner_client_id is not null)
  );

create index partner_documents_client_idx on partner_documents(partner_client_id)
  where partner_client_id is not null;

-- ── 4. Visibility with no farm ───────────────────────────────────────────────
-- `app.partner_doc_visible` is the single choke point every document policy and
-- `partner_doc_visible_by_id` routes through, so the new case is expressed once.
--
-- A document with no farm belongs to its issuer alone. No farm-side user is a party to
-- it — there is no farm — so the farm branch simply does not arise, and rr_admin keeps
-- its cross-tenant read. This is a WIDENING of nothing: it admits exactly the workshop
-- that issued the row and no one else.
create or replace function app.partner_doc_visible(p_farm uuid, p_workshop uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when app.is_rr_admin() then true
    -- No farm: the issuing partner's own paperwork for their own customer.
    when p_farm is null then p_workshop = app.user_workshop_id()
    else app.has_farm_access(p_farm)
     and (app.current_app_role() is distinct from 'workshop' or p_workshop = app.user_workshop_id())
     and app.current_app_role() is distinct from 'operator'
  end;
$$;

-- ── 5. Nothing without a farm reaches the cost ledger ────────────────────────
-- `cost_entries.farm_id` is not null and the whole ledger is farm-scoped, so a document
-- addressed to a client or a walk-in has nowhere to book — and should not, because that
-- money is the partner's revenue, not any farm's cost. Made explicit rather than left to
-- a null-propagating insert failing at some later date.
create or replace function app_cost_from_partner_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_net bigint; v_live boolean;
begin
  if new.farm_id is null then
    return null;                         -- not addressed to a farm: no farm cost exists
  end if;

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

  if new.work_request_id is not null then
    if v_live then
      update cost_entries set deleted_at = coalesce(deleted_at, now())
        where source_type = 'work_request' and source_id = new.work_request_id and deleted_at is null;
    else
      update work_requests set updated_at = now() where id = new.work_request_id;
    end if;
  end if;

  return null;
end $$;

comment on function app_cost_from_partner_document() is
  'A document with no farm books nothing — that money is the partner''s revenue, not a '
  'farm''s cost. 0411 extends this to net off credit notes.';

-- ── Who may fill the farm's billing identity in ──────────────────────────────
--
-- `farms_upd` (0101) is rr_admin only, deliberately — a farm row carries the plan and the
-- status, and a customer editing those would be editing their own subscription. But the
-- billing block IS theirs, and nobody else can know their VAT number.
--
-- So the same shape as `update_farm_settings` (0204): a SECURITY DEFINER RPC that writes
-- exactly these six columns after checking the caller is an owner or manager OF THAT
-- FARM. Nothing else on the row is reachable through it, which is what keeps the narrow
-- `farms_upd` policy meaningful.
create or replace function public.update_farm_billing(
  p_farm      uuid,
  p_trading   text,
  p_reg       text,
  p_vat       text,
  p_address   text,
  p_email     text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.is_rr_admin()
     and not exists (
       select 1 from users
       where id = auth.uid() and farm_id = p_farm and role in ('owner', 'manager')
         and active and deleted_at is null
     ) then
    raise exception 'not allowed to change billing details for this farm'
      using errcode = '42501';
  end if;

  update farms set
    trading_name    = nullif(btrim(coalesce(p_trading, '')), ''),
    reg_number      = nullif(btrim(coalesce(p_reg, '')), ''),
    vat_number      = nullif(btrim(coalesce(p_vat, '')), ''),
    billing_address = nullif(btrim(coalesce(p_address, '')), ''),
    billing_email   = nullif(btrim(coalesce(p_email, '')), '')
  where id = p_farm;
end $$;

revoke execute on function public.update_farm_billing(uuid, text, text, text, text, text) from public, anon;
grant  execute on function public.update_farm_billing(uuid, text, text, text, text, text) to authenticated;
