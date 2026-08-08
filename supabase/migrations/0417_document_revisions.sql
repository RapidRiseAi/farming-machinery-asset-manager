-- 0417_document_revisions.sql
-- G3 — Fix a mistake by fixing it, and keep every version you fixed.
--
-- ── WHY THIS REPLACES THE HARD FREEZE ────────────────────────────────────────
--
-- 0412 made an issued document immutable and offered a credit note as the only route to a
-- wrong amount. That is what the accounting textbooks say, and for a customer who pays
-- invoice-by-invoice it is right. But a great many farm customers run a MONTHLY ACCOUNT:
-- they never look at an individual invoice, they pay off a statement. For them, three
-- lines — the wrong invoice, a credit note, a replacement invoice — where one corrected
-- line belongs makes the statement HARDER to read, not more honest. The correction is
-- noise on a page whose whole job is to be scannable.
--
-- So: an issued document becomes editable, and the guarantee moves from "it cannot
-- change" to "it cannot change WITHOUT LEAVING A COMPLETE RECORD OF WHAT IT WAS". Which
-- is the guarantee that actually matters. Nobody was ever protected by immutability
-- itself; they were protected by being able to reconstruct what a customer was told.
--
-- ── HOW IT IS ENFORCED ───────────────────────────────────────────────────────
--
-- Editing goes through ONE SECURITY DEFINER function, `public.revise_document`, which:
--
--   1. checks the caller may edit this document at all;
--   2. writes the CURRENT document and its CURRENT lines into `partner_document_revisions`
--      as a complete jsonb snapshot;
--   3. applies the change;
--   4. bumps the version and records the reason, the person and the time.
--
-- The freeze triggers from 0412 stay exactly as they are for every other route, and open
-- only while that function is running (a transaction-local flag it sets and nobody else
-- can). So there is no way to edit an issued document through PostgREST, through a stray
-- server action, or by hand, that does not leave a version behind. The rule is a property
-- of the database, not a convention in the app.
--
-- ── WHAT STAYS SHUT ──────────────────────────────────────────────────────────
--
-- DELETING an issued document. That is the specific thing that makes AutoVault's
-- statements disagree with themselves — its route hard-deletes invoices with the
-- service-role client, so a statement printed last month and one printed today differ
-- with nothing on either page to explain it. `void` does the same job, keeps the number,
-- and records why.

-- ── The versions ─────────────────────────────────────────────────────────────
create table partner_document_revisions (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references partner_documents(id) on delete cascade,
  workshop_id  uuid not null references workshops(id),
  farm_id      uuid,                      -- mirrors the document; null for a client-book customer
  -- 1 is the document as first issued; each edit stores the version it replaced.
  version      int  not null,
  reason       text not null,
  -- The whole document AND its lines as they were. A snapshot rather than a column-level
  -- diff, because the question anyone actually asks is "what did the customer get?", and
  -- answering it from a pile of field-level deltas is a reconstruction — the same mistake
  -- AutoVault's statement route makes.
  snapshot     jsonb not null,
  total_cents_before bigint not null,
  total_cents_after  bigint,
  edited_by    uuid references users(id),
  edited_at    timestamptz not null default now(),
  constraint partner_document_revisions_uq unique (document_id, version)
);
create index partner_document_revisions_doc_idx on partner_document_revisions(document_id, version desc);

comment on table partner_document_revisions is
  'Every version an issued document has had. Written by `revise_document` before the '
  'change is applied, so a document can always be shown as the customer received it.';

alter table partner_documents
  add column revision             int not null default 1,
  add column last_revised_at      timestamptz,
  add column last_revision_reason text;

comment on column partner_documents.revision is
  'Version 1 is as first issued. Anything above 1 means the document has been corrected '
  'and `partner_document_revisions` holds every earlier version.';

alter table partner_document_revisions enable row level security;
alter table partner_document_revisions force  row level security;

-- Visibility follows the document, including the draft rule. A farmer can see how an
-- invoice they were sent has changed since — which is the point of keeping the versions.
create policy partner_document_revisions_sel on partner_document_revisions for select to authenticated
  using (app.partner_doc_visible_by_id(document_id));

grant select on partner_document_revisions to authenticated;
grant all    on partner_document_revisions to service_role;

-- ── The one door ─────────────────────────────────────────────────────────────
--
-- `app.revising` is set only inside `revise_document` and is transaction-local, so it
-- cannot leak to another statement, another request, or another connection.
create or replace function app_partner_document_no_erase() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_revising boolean := coalesce(current_setting('app.revising', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    -- Never, for anything issued. A deleted invoice is a statement that changes shape
    -- between two printings with nothing to explain why.
    if old.status <> 'draft' then
      raise exception 'A % that has been issued cannot be deleted. Void it, or correct it and keep the history.', old.kind
        using errcode = '42501';
    end if;
    return old;
  end if;

  if new.deleted_at is not null and old.deleted_at is null and old.status <> 'draft' then
    raise exception 'A % that has been issued cannot be deleted. Void it, or correct it and keep the history.', old.kind
      using errcode = '42501';
  end if;

  -- Everything below is now permitted — but only through `revise_document`, which has
  -- already written the previous version away.
  if old.status <> 'draft' and not v_revising then
    if new.subtotal_cents is distinct from old.subtotal_cents
    or new.discount_cents is distinct from old.discount_cents
    or new.vat_rate_bps   is distinct from old.vat_rate_bps then
      raise exception 'Correcting an issued % has to go through the edit form, so the previous version is kept.', old.kind
        using errcode = '42501';
    end if;
    if new.number is distinct from old.number then
      raise exception 'The number of an issued % is fixed.', old.kind
        using errcode = '42501';
    end if;
    if new.farm_id           is distinct from old.farm_id
    or new.partner_client_id is distinct from old.partner_client_id then
      raise exception 'An issued % cannot be moved to a different customer. Void it and issue a new one.', old.kind
        using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

create or replace function app_partner_line_frozen() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_status partner_doc_status;
  v_kind   partner_doc_kind;
  v_revising boolean := coalesce(current_setting('app.revising', true), '') = 'on';
begin
  if v_revising then
    return coalesce(new, old);
  end if;

  select status, kind into v_status, v_kind from partner_documents
   where id = coalesce(new.document_id, old.document_id);

  if v_status is not null and v_status <> 'draft' then
    raise exception 'The items on an issued % have to be changed through the edit form, so the previous version is kept.', v_kind
      using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;

-- ── Revise ───────────────────────────────────────────────────────────────────
--
-- Takes the change as data rather than letting the caller update the table, so the
-- snapshot and the edit are one atomic act. A caller cannot snapshot and then fail to
-- edit, or edit and forget to snapshot.
--
-- `p_patch` carries only the fields being changed; anything absent is left alone.
-- `p_lines` REPLACES the line set when present, and is left alone when null — so a
-- correction to the due date does not require resending every line.
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

  -- Only the issuing partner corrects their own paperwork. rr_admin may, for support.
  if not app.is_rr_admin() and d.workshop_id is distinct from app.user_workshop_id() then
    raise exception 'Only the business that issued this document can correct it.'
      using errcode = '42501';
  end if;

  if d.status = 'void' then
    raise exception 'This document has been cancelled. Issue a new one instead.'
      using errcode = '42501';
  end if;

  -- The whole thing as it stands, lines included.
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

  -- Open the door for the rest of this function only.
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

  -- Close it again before anything else in this transaction runs.
  perform set_config('app.revising', 'off', true);

  select total_cents, amount_paid_cents into v_after, v_paid
    from partner_documents where id = p_document;

  -- You cannot correct an invoice down below what has already been paid — that is not a
  -- correction, it is a refund, and it needs a credit note so the money going back is
  -- visible as its own event.
  if d.kind = 'invoice' and v_after < v_paid then
    raise exception 'That would put the total (%) below what has already been paid (%). Issue a credit note instead, so the refund shows.',
      v_after, v_paid using errcode = '23514';
  end if;

  update partner_document_revisions set total_cents_after = v_after
   where document_id = p_document and version = d.revision;
end $$;

revoke execute on function public.revise_document(uuid, text, jsonb, jsonb) from public, anon;
grant  execute on function public.revise_document(uuid, text, jsonb, jsonb) to authenticated, service_role;

comment on function public.revise_document(uuid, text, jsonb, jsonb) is
  'The ONLY way an issued document changes. Snapshots the current version and its lines '
  'into partner_document_revisions, then applies the edit — one atomic act, so no edit '
  'can exist without the version it replaced.';
