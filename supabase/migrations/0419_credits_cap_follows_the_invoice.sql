-- 0419_credits_cap_follows_the_invoice.sql
-- The cap watched the wrong side of the pair.
--
-- 0412 refuses a credit note that would take total credits past the invoice they correct
-- — otherwise the customer ends up with a negative balance nothing on the statement
-- explains. But that check only ever ran when a NOTE was written, and 0417 made the
-- INVOICE editable. So the same hole reopened from the other direction:
--
--     invoice R10 000, credit note R9 000  →  balance R1 000, fine
--     revise the invoice down to R115      →  balance -R10 235, and nothing says why
--
-- Measured, not reasoned about: the local suite reproduced exactly that. It did not show
-- up on the demo project only because that invoice happened to have a payment against it
-- and the "below what has been paid" guard caught it first — luck, not cover.
--
-- ── WHERE THE CHECK GOES, AND WHY NOT IN THE TRIGGER ─────────────────────────
--
-- The obvious fix — ask the question in the row trigger when an invoice total drops —
-- was written first and immediately failed the suite: `revise_document` REPLACES the
-- lines, so it deletes them and re-inserts, and the document's total passes through ZERO
-- on the way. A row trigger sees that intermediate state and refuses a correction that is
-- perfectly fine by the time it finishes.
--
-- So the invoice side belongs at the END of the revision, next to the "below what has
-- been paid" check that is already there for exactly the same reason. The trigger keeps
-- the NOTE side, where there is no intermediate state to trip over. Between them, the
-- invariant holds from both directions and neither one fires on a half-finished edit.

create or replace function public.revise_document(
  p_document uuid,
  p_reason   text,
  p_patch    jsonb default '{}'::jsonb,
  p_lines    jsonb default null
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d          partner_documents%rowtype;
  v_snapshot jsonb;
  v_before   bigint;
  v_paid     bigint;
  v_after    bigint;
  v_credited bigint;
  ln         jsonb;
  i          int := 0;
begin
  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Say what you are correcting — it is what makes the change readable later.'
      using errcode = '23514';
  end if;

  select * into d from partner_documents where id = p_document and deleted_at is null;
  if d.id is null then
    raise exception 'document not found' using errcode = 'P0002';
  end if;

  if not app.is_rr_admin() and d.workshop_id is distinct from app.user_workshop_id() then
    raise exception 'Only the business that issued this document can correct it.'
      using errcode = '42501';
  end if;

  if d.status = 'void' then
    raise exception 'This document has been cancelled. Issue a new one instead.'
      using errcode = '42501';
  end if;

  v_snapshot := jsonb_build_object(
    'document', to_jsonb(d),
    'lines', coalesce((
      select jsonb_agg(to_jsonb(l) order by l.sort_order)
        from partner_document_lines l
       where l.document_id = p_document and l.deleted_at is null
    ), '[]'::jsonb)
  );
  v_before := d.total_cents;

  insert into partner_document_revisions
    (document_id, workshop_id, farm_id, version, reason, snapshot, total_cents_before, edited_by)
  values (p_document, d.workshop_id, d.farm_id, d.revision, btrim(p_reason), v_snapshot, v_before, auth.uid());

  perform set_config('app.revising', 'on', true);

  update partner_documents set
    subject         = coalesce(p_patch->>'subject', subject),
    issue_date      = coalesce((p_patch->>'issue_date')::date, issue_date),
    due_date        = case when p_patch ? 'due_date'
                           then nullif(p_patch->>'due_date', '')::date else due_date end,
    discount_cents  = coalesce((p_patch->>'discount_cents')::bigint, discount_cents),
    vat_rate_bps    = coalesce((p_patch->>'vat_rate_bps')::int, vat_rate_bps),
    notes           = case when p_patch ? 'notes' then p_patch->>'notes' else notes end,
    terms           = case when p_patch ? 'terms' then p_patch->>'terms' else terms end,
    bill_to_name       = coalesce(p_patch->>'bill_to_name', bill_to_name),
    bill_to_contact    = case when p_patch ? 'bill_to_contact' then p_patch->>'bill_to_contact' else bill_to_contact end,
    bill_to_email      = case when p_patch ? 'bill_to_email' then p_patch->>'bill_to_email' else bill_to_email end,
    bill_to_phone      = case when p_patch ? 'bill_to_phone' then p_patch->>'bill_to_phone' else bill_to_phone end,
    bill_to_address    = case when p_patch ? 'bill_to_address' then p_patch->>'bill_to_address' else bill_to_address end,
    bill_to_vat_number = case when p_patch ? 'bill_to_vat_number' then p_patch->>'bill_to_vat_number' else bill_to_vat_number end,
    bill_to_reg_number = case when p_patch ? 'bill_to_reg_number' then p_patch->>'bill_to_reg_number' else bill_to_reg_number end,
    bill_to_reference  = case when p_patch ? 'bill_to_reference' then p_patch->>'bill_to_reference' else bill_to_reference end,
    revision             = revision + 1,
    last_revised_at      = now(),
    last_revision_reason = btrim(p_reason),
    updated_at           = now()
  where id = p_document;

  if p_lines is not null then
    delete from partner_document_lines where document_id = p_document;
    for ln in select * from jsonb_array_elements(p_lines) loop
      insert into partner_document_lines
        (farm_id, document_id, sort_order, kind, part_no, description, qty, unit_price_cents, discount_cents)
      values (
        d.farm_id, p_document, i,
        coalesce(nullif(ln->>'kind', ''), 'part')::job_line_kind,
        nullif(ln->>'part_no', ''),
        coalesce(nullif(ln->>'description', ''), '—'),
        coalesce((ln->>'qty')::numeric, 1),
        coalesce((ln->>'unit_price_cents')::bigint, 0),
        coalesce((ln->>'discount_cents')::bigint, 0)
      );
      i := i + 1;
    end loop;
  end if;

  perform set_config('app.revising', 'off', true);

  select total_cents, amount_paid_cents into v_after, v_paid
    from partner_documents where id = p_document;

  -- ── The two things a correction is not allowed to do ───────────────────────
  -- Both are checked HERE rather than in a row trigger, because the line replacement
  -- above takes the total through zero on its way and a row trigger would refuse a
  -- correction that is fine by the time it lands.

  -- You cannot correct an invoice down below what has already been paid — that is a
  -- refund, and a refund has to be visible as its own event.
  if d.kind = 'invoice' and v_after < v_paid then
    raise exception 'That would put the total (%) below what has already been paid (%). Issue a credit note instead, so the refund shows.',
      v_after, v_paid using errcode = '23514';
  end if;

  -- Nor below the credit notes already issued against it, which would leave the customer
  -- holding a negative balance that nothing on their statement explains.
  if d.kind = 'invoice' then
    select coalesce(sum(total_cents), 0) into v_credited from partner_documents
     where corrects_document_id = p_document
       and kind = 'credit_note'
       and deleted_at is null and status not in ('draft', 'void');

    if v_credited > v_after then
      raise exception 'You have already credited % against this invoice, so it cannot come down to %. Credit the difference instead.',
        v_credited, v_after using errcode = '23514';
    end if;
  end if;

  update partner_document_revisions set total_cents_after = v_after
   where document_id = p_document and version = d.revision;
end $$;
