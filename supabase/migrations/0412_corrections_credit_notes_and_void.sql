-- 0411_corrections_credit_notes_and_void.sql
-- G2b — A real way to fix a mistake, which is the thing AutoVault never had.
--
-- ── WHAT GOES WRONG WITHOUT ONE ──────────────────────────────────────────────
--
-- AutoVault has no correction path, so it grew two workarounds and both corrupt the
-- statement:
--
--   * `app/api/workshop/financial-documents/route.ts` HARD DELETES an invoice with the
--     service-role client — `admin.from('invoices').delete().eq('id', …)`. The row is
--     gone. A statement printed last month and one printed today for the same period
--     disagree, and nothing on either page explains why. That is not an audit trail with
--     a gap in it; it is an audit trail that lies.
--
--   * Where a credit WAS issued, the statement route finds it by REGEX over free text —
--     `/\b(CN-[A-Z0-9-]{4,})\b/i` against a description, and
--     `/credit\s+note\s+.*applied/i` to decide whether a line is a credit at all. The
--     accuracy of a customer's statement of account depends on how somebody worded a
--     description field.
--
-- FleetWise had the opposite half of the same problem: a sent document is correctly
-- immutable (`isEditable` is draft-only), but the only escape was `cancelDocument` —
-- available even on a PAID invoice, recording no reason, silently soft-deleting the
-- farm's cost entry. A partner who typed R12 000 instead of R1 200 could erase the
-- invoice from the farmer's costs with no explanation of why the number moved, or phone
-- them and ask them to ignore it.
--
-- ── THE MODEL — THREE WAYS TO BE WRONG, THREE ANSWERS ────────────────────────
--
--   Never issued        DELETE the draft. Nothing left our hands; there is no record to
--                       preserve. Unchanged.
--
--   Should not exist    VOID it, with a reason. The document, its number and its history
--                       stay; the money stands down. For an invoice that was raised
--                       against the wrong customer, or duplicated. VAT Act s21 wants the
--                       cancellation documented, not the paperwork destroyed.
--
--   Wrong amount        CREDIT NOTE. A document in its own right, with its own number
--                       and lines, pointing at the invoice it corrects. Issue a fresh
--                       invoice for the right amount alongside it. This is what s21(3)
--                       requires when the VAT or the consideration on an issued tax
--                       invoice was overstated, and it is what every tool in the
--                       comparison set does.
--
-- A credit note books the NEGATIVE of its value into the farm's cost ledger, so a
-- correction nets out of TCO instead of being erased from it — the farmer's spend history
-- shows what was billed and what was credited back, which is what actually happened.

-- The two enum values this migration needs are added by 0411, alone, because a new enum
-- value cannot be used in the transaction that created it.

-- ── The link back to what is being corrected ─────────────────────────────────
alter table partner_documents
  add column corrects_document_id uuid,
  add column void_reason          text,
  add column voided_at            timestamptz,
  add column voided_by            uuid references users(id),
  add constraint partner_documents_corrects_fk
    foreign key (corrects_document_id) references partner_documents(id);

comment on column partner_documents.corrects_document_id is
  'The invoice this credit note corrects. Printed on the credit note and read by the '
  'statement — never parsed out of a description, which is how AutoVault does it and how '
  'a statement ends up depending on somebody''s wording.';

create index partner_documents_corrects_idx on partner_documents(corrects_document_id)
  where corrects_document_id is not null;

-- A credit note must say what it corrects, and a void must say why. Both stated as
-- constraints so no code path can produce an undocumented correction.
alter table partner_documents
  add constraint partner_documents_credit_ck check (
    kind <> 'credit_note' or corrects_document_id is not null
  ),
  add constraint partner_documents_void_ck check (
    status <> 'void' or (void_reason is not null and length(btrim(void_reason)) >= 3)
  );

-- ── Nothing issued may be deleted ────────────────────────────────────────────
-- The `deleteDraft` action already checks the status, but a check in one server action is
-- not a rule — the table is reachable through PostgREST by anyone the policy admits. This
-- is the guard that makes "a sent document is a record" true of the DATABASE, which is
-- what AutoVault is missing.
create or replace function app_partner_document_no_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'A % that has been issued cannot be deleted. Void it or issue a credit note.', old.kind
        using errcode = '42501';
    end if;
    return old;
  end if;

  -- Soft delete is the same act by another name.
  if new.deleted_at is not null and old.deleted_at is null and old.status <> 'draft' then
    raise exception 'A % that has been issued cannot be deleted. Void it or issue a credit note.', old.kind
      using errcode = '42501';
  end if;

  -- Nor may an issued document be quietly re-priced or re-addressed. `isEditable` guards
  -- the UI; this guards the table, which is the difference between a convention and a
  -- rule. Status, payment, correction and void columns are how an issued document
  -- legitimately changes, so they stay open.
  --
  -- This trigger sorts FIRST among the BEFORE triggers on this table, so NEW still holds
  -- what the caller actually asked for — the totals and VAT triggers have not yet had
  -- their say. A caller who changes nothing here passes even though those later triggers
  -- will rewrite the same columns.
  if old.status <> 'draft' then
    if new.subtotal_cents    is distinct from old.subtotal_cents
    or new.discount_cents    is distinct from old.discount_cents
    or new.vat_rate_bps      is distinct from old.vat_rate_bps then
      raise exception 'A % that has been issued cannot be re-priced. Issue a credit note.', old.kind
        using errcode = '42501';
    end if;
    if new.number     is distinct from old.number
    or new.issue_date is distinct from old.issue_date then
      raise exception 'The number and date of an issued % are fixed.', old.kind
        using errcode = '42501';
    end if;
    if new.farm_id           is distinct from old.farm_id
    or new.partner_client_id is distinct from old.partner_client_id
    or new.bill_to_name      is distinct from old.bill_to_name then
      raise exception 'An issued % cannot be re-addressed to someone else. Void it and issue a new one.', old.kind
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

create trigger partner_documents_no_erase
  before update or delete on partner_documents
  for each row execute function app_partner_document_no_erase();

revoke execute on function app_partner_document_no_erase() from anon, authenticated, public;

-- Lines of an issued document are equally fixed. Without this the totals could be moved
-- through the child table, which is the same re-price by a longer route.
create or replace function app_partner_line_frozen() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_status partner_doc_status; v_kind partner_doc_kind;
begin
  select status, kind into v_status, v_kind from partner_documents
   where id = coalesce(new.document_id, old.document_id);

  if v_status is not null and v_status <> 'draft' then
    raise exception 'The items on an issued % cannot be changed. Issue a credit note.', v_kind
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

create trigger partner_document_lines_frozen
  before insert or update or delete on partner_document_lines
  for each row execute function app_partner_line_frozen();

revoke execute on function app_partner_line_frozen() from anon, authenticated, public;

-- ── The ledger nets, rather than forgetting ──────────────────────────────────
-- A credit note books the negative of its value against the same farm and machine, so the
-- farmer's cost history reads "billed R12 000, credited R10 800" instead of quietly
-- becoming R1 200 with no trace of the correction. A VOID document books nothing, which
-- the status test below already produces.
create or replace function app_cost_from_partner_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_net bigint; v_live boolean; v_sign int;
begin
  if new.farm_id is null then
    return null;                         -- not addressed to a farm: no farm cost exists
  end if;

  v_net  := greatest(0, new.subtotal_cents - least(new.discount_cents, new.subtotal_cents));
  v_sign := case when new.kind = 'credit_note' then -1 else 1 end;
  v_live := new.deleted_at is null
        and new.kind in ('invoice', 'credit_note')
        and new.status in ('sent', 'part_paid', 'paid')
        and v_net > 0;

  if not v_live then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'partner_document' and source_id = new.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'partner_document' and source_id = new.id) then
    update cost_entries
       set farm_id = new.farm_id, machine_id = new.machine_id, type = 'invoice',
           amount_cents = v_sign * v_net, vat_rate_bps = new.vat_rate_bps,
           deleted_at = null, deleted_by = null
     where source_type = 'partner_document' and source_id = new.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps,
                              source_type, source_id, occurred_on, created_by, note)
    values (new.farm_id, new.machine_id, 'invoice', v_sign * v_net, new.vat_rate_bps,
            'partner_document', new.id, new.issue_date, new.created_by, new.number);
  end if;

  -- Only a live INVOICE stands the work-request entry down; a credit note must not.
  if new.work_request_id is not null then
    if v_live and new.kind = 'invoice' then
      update cost_entries set deleted_at = coalesce(deleted_at, now())
        where source_type = 'work_request' and source_id = new.work_request_id and deleted_at is null;
    else
      update work_requests set updated_at = now() where id = new.work_request_id;
    end if;
  end if;

  return null;
end $$;

-- ── A credit note cannot exceed what it corrects ─────────────────────────────
-- Otherwise a partner can credit R20 000 against a R12 000 invoice and hand the customer
-- a negative balance that no invoice explains. Checked across ALL live credit notes
-- against the invoice, so three small ones cannot do what one large one is refused.
create or replace function app_partner_credit_within_invoice() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_invoice bigint; v_credited bigint;
begin
  if new.kind <> 'credit_note' or new.status = 'draft' or new.status = 'void' then
    return new;
  end if;

  select total_cents into v_invoice from partner_documents
   where id = new.corrects_document_id;

  select coalesce(sum(total_cents), 0) into v_credited from partner_documents
   where corrects_document_id = new.corrects_document_id
     and kind = 'credit_note' and id <> new.id
     and deleted_at is null and status not in ('draft', 'void');

  if v_invoice is not null and v_credited + new.total_cents > v_invoice then
    raise exception 'Credit notes against this invoice would come to more than the invoice itself (% of %).',
      v_credited + new.total_cents, v_invoice using errcode = '23514';
  end if;
  return new;
end $$;

-- Named to sort after the totals and VAT triggers so it judges the final numbers.
create trigger partner_documents_zzz_credit_cap
  before insert or update on partner_documents
  for each row execute function app_partner_credit_within_invoice();

revoke execute on function app_partner_credit_within_invoice() from anon, authenticated, public;
