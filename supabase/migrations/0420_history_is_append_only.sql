-- 0420_history_is_append_only.sql
-- The version history has to REFUSE, not quietly do nothing.
--
-- ── WHAT WAS ACTUALLY TRUE ───────────────────────────────────────────────────
--
-- `partner_document_revisions` (0417) is the record that makes editing an issued document
-- safe: it is the thing that stops a correction being invisible. So the question "can
-- anyone delete it?" is the whole load-bearing question, and the honest answer was
-- "not really, by accident".
--
-- Measured against the live project as an ordinary partner login:
--
--     delete from partner_document_revisions;   → ran, 0 rows, NO ERROR
--     update partner_document_revisions set …;  → ran, 0 rows, NO ERROR
--     insert into partner_document_revisions …; → RLS violation
--
-- Nothing was destroyed — 1 revision before, 1 after — but only because `0102` grants
-- table privileges broadly and leans on RLS, and 0417 defined a SELECT policy and no
-- others, so UPDATE and DELETE matched no rows. That is default-deny doing its job, and
-- it is a thin thing to rest an audit trail on:
--
--   * it is silent. A caller is told nothing happened by being told nothing at all —
--     the same shape as the `wl_upd` bug found earlier this session, where a farm owner
--     was shown "disconnected" for an update that matched zero rows.
--   * it is one permissive policy away from being wrong. Anyone adding a `for all`
--     policy later — the obvious thing to write when adding, say, an admin cleanup —
--     opens it without noticing.
--
-- So: say it twice, and make it loud.

-- ── 1. The grant should never have been there ────────────────────────────────
revoke insert, update, delete on partner_document_revisions from authenticated;

-- ── 2. And the table refuses out loud, whatever the grants say ───────────────
-- Belt and braces on purpose. A trigger cannot be bypassed by a future policy, and it
-- raises rather than shrugging — so a caller who tries finds out, and so does anyone
-- reading the logs.
create or replace function app_revisions_append_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  raise exception 'The version history cannot be % — it is the record that makes correcting a document safe.',
    case tg_op when 'DELETE' then 'deleted' else 'changed' end
    using errcode = '42501';
end $$;

create trigger partner_document_revisions_append_only
  before update or delete on partner_document_revisions
  for each row execute function app_revisions_append_only();

revoke execute on function app_revisions_append_only() from public, anon, authenticated;

comment on table partner_document_revisions is
  'Append-only. Every version an issued document has had; written by `revise_document` '
  'before the change is applied. UPDATE and DELETE are refused by trigger as well as by '
  'RLS, because an audit trail that can be quietly emptied is not an audit trail.';

-- ── 3. Close the one door that COULD have removed history ────────────────────
--
-- `partner_document_revisions.document_id` cascades, and a DRAFT can still be deleted.
-- Nothing stopped `revise_document` running on a draft, so the sequence
-- "revise a draft twice, then delete it" would have taken its versions with it.
--
-- The fix is not to protect a draft's history — it is that a draft should never have had
-- any. A draft is directly editable through the ordinary form; going through the
-- correction machinery for one is redundant, and it manufactures history for a document
-- nobody has ever seen. So: refuse. Revisions now exist only for documents that were
-- issued, and an issued document cannot be deleted.
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

  -- A draft has not gone anywhere. Edit it directly; there is nothing to keep a version of.
  if d.status = 'draft' then
    raise exception 'This is still a draft — edit it directly. Corrections are for documents that have been sent.'
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

  if d.kind = 'invoice' and v_after < v_paid then
    raise exception 'That would put the total (%) below what has already been paid (%). Issue a credit note instead, so the refund shows.',
      v_after, v_paid using errcode = '23514';
  end if;

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

  -- Stamp the outcome onto the version we just wrote. The append-only trigger stands
  -- aside only for this one write, held open from inside this function and nowhere else.
  perform set_config('app.revising', 'closing', true);
  update partner_document_revisions set total_cents_after = v_after
   where document_id = p_document and version = d.revision;
  perform set_config('app.revising', 'off', true);
end $$;

-- `revise_document` writes the `total_cents_after` line above, which the new trigger would
-- otherwise refuse. It is SECURITY DEFINER and runs as the owner, so it needs the trigger
-- to stand aside for that one write — the same transaction-local flag pattern 0417 uses
-- for the freeze triggers, and for the same reason: one door, held open only from inside.
create or replace function app_revisions_append_only() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('app.revising', true), '') = 'closing' then
    return new;
  end if;
  raise exception 'The version history cannot be % — it is the record that makes correcting a document safe.',
    case tg_op when 'DELETE' then 'deleted' else 'changed' end
    using errcode = '42501';
end $$;
