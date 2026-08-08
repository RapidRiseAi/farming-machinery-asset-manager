-- 0415_credit_note_numbering.sql
-- A credit note needs its own number series, and had none.
--
-- Found by driving the live project: pressing "Start a credit note" fails with
-- `unknown document kind credit_note` from `public.next_document_number`, which knows
-- exactly two kinds. So 0412 shipped a correction path whose first step could not run.
--
-- The `app.` function is worse than the wrapper, in a quieter way: its branch is
-- `if quote … else invoice`, so a credit note would have taken a number from the INVOICE
-- sequence. INV-0008 and the credit note correcting INV-0007 would both be "invoice
-- number 8" in the partner's own books, and the two series would interleave in a way no
-- accountant would accept. A credit note is its own kind of document under VAT Act s21
-- and it gets its own series.

alter table workshops
  add column doc_prefix_credit text not null default 'CN',
  add column next_credit_no    int  not null default 1;

comment on column workshops.doc_prefix_credit is
  'Numbering prefix for this partner''s credit notes. Its own series — a credit note is '
  'not an invoice, and sharing the invoice counter makes both series unreadable.';

-- Backfill the counter past anything already issued, the way 0384 does for the other two,
-- so a project where credit notes were somehow created by hand does not collide.
update workshops w set next_credit_no = greatest(
  w.next_credit_no,
  coalesce((
    select max(nullif(regexp_replace(d.number, '^.*?(\d+)$', '\1'), '')::int) + 1
      from partner_documents d
     where d.workshop_id = w.id and d.kind = 'credit_note'
       and d.number ~ '\d+$'
  ), 1)
);

create or replace function app.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_no     int;
  v_prefix text;
  v_number text;
  v_taken  boolean;
  v_guard  int := 0;
begin
  if p_kind not in ('quote', 'invoice', 'credit_note') then
    raise exception 'unknown document kind %', p_kind;
  end if;

  loop
    v_guard := v_guard + 1;
    if v_guard > 10000 then
      raise exception 'could not allocate a % number for workshop % — the sequence looks corrupt', p_kind, p_workshop;
    end if;

    -- One counter per kind, incremented under the row lock the UPDATE takes, so two
    -- staff issuing at the same second get consecutive numbers rather than the same one.
    if p_kind = 'quote' then
      update workshops set next_quote_no = next_quote_no + 1
        where id = p_workshop
        returning next_quote_no - 1, doc_prefix_quote into v_no, v_prefix;
    elsif p_kind = 'credit_note' then
      update workshops set next_credit_no = next_credit_no + 1
        where id = p_workshop
        returning next_credit_no - 1, doc_prefix_credit into v_no, v_prefix;
    else
      update workshops set next_invoice_no = next_invoice_no + 1
        where id = p_workshop
        returning next_invoice_no - 1, doc_prefix_invoice into v_no, v_prefix;
    end if;

    if v_no is null then
      raise exception 'unknown workshop %', p_workshop;
    end if;

    v_number := coalesce(nullif(v_prefix, ''), 'DOC') || '-' || lpad(v_no::text, 4, '0');

    -- Skip a number already in use (0384): counters and rows drift after a restore or an
    -- import, and a unique-violation at the end of a form loses the whole document.
    select exists (
      select 1 from partner_documents
       where workshop_id = p_workshop and kind = p_kind::partner_doc_kind and number = v_number
    ) into v_taken;

    exit when not v_taken;
  end loop;

  return v_number;
end $$;

-- The PostgREST wrapper carries the same three kinds, and still refuses another
-- partner's sequence.
create or replace function public.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_rr_admin() or p_workshop = app.user_workshop_id()) then
    raise exception 'not your numbering sequence';
  end if;
  if p_kind not in ('quote', 'invoice', 'credit_note') then
    raise exception 'unknown document kind %', p_kind;
  end if;
  return app.next_document_number(p_workshop, p_kind);
end $$;

revoke execute on function public.next_document_number(uuid, text) from public, anon;
grant  execute on function public.next_document_number(uuid, text) to authenticated;
