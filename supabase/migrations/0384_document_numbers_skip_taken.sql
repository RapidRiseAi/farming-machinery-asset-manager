-- 0384_document_numbers_skip_taken.sql
-- The number allocator must never hand out one that is already in use.
--
-- Found by driving the built app: pressing "Start it" as a partner failed with
--
--     duplicate key value violates unique constraint "partner_documents_number_uq"
--
-- and created nothing. The counter on `workshops` and the numbers actually present in
-- `partner_documents` had drifted apart — in that instance because demo rows were
-- inserted directly, but the same drift arrives by ordinary means: a restore from
-- backup, an import of a partner's historical paperwork, a row inserted by support, or
-- a counter reset by someone tidying up. 0380 assumed the counter was the only writer.
--
-- Two problems, both fixed here:
--   1. The allocator now SKIPS numbers already taken, advancing the counter past them,
--      so it stays correct however the rows arrived.
--   2. A partner never sees a Postgres constraint message. The old failure surfaced raw
--      in a redirect query string; the allocator now resolves the collision itself.
--
-- The loop is bounded (10 000 attempts) so a pathological state fails loudly with a
-- sentence someone can act on rather than spinning. Still one UPDATE per attempt under
-- the same row lock, so the concurrency guarantee from 0380 is unchanged: two staff
-- issuing at the same second still get consecutive, distinct numbers.

create or replace function app.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_no      int;
  v_prefix  text;
  v_number  text;
  v_taken   boolean;
  v_guard   int := 0;
begin
  loop
    v_guard := v_guard + 1;
    if v_guard > 10000 then
      raise exception 'could not allocate a % number for workshop % — the sequence looks corrupt', p_kind, p_workshop;
    end if;

    if p_kind = 'quote' then
      update workshops set next_quote_no = next_quote_no + 1
        where id = p_workshop
        returning next_quote_no - 1, doc_prefix_quote into v_no, v_prefix;
    else
      update workshops set next_invoice_no = next_invoice_no + 1
        where id = p_workshop
        returning next_invoice_no - 1, doc_prefix_invoice into v_no, v_prefix;
    end if;

    if v_no is null then
      raise exception 'unknown workshop %', p_workshop;
    end if;

    v_number := coalesce(nullif(v_prefix, ''), 'DOC') || '-' || lpad(v_no::text, 4, '0');

    -- Is it already on a document of this kind for this partner? (Soft-deleted rows
    -- count: the unique index covers them, and reissuing a deleted number would make
    -- two documents share an identity in the audit log.)
    select exists (
      select 1 from partner_documents
       where workshop_id = p_workshop and kind = p_kind::partner_doc_kind and number = v_number
    ) into v_taken;

    exit when not v_taken;
  end loop;

  return v_number;
end $$;

revoke execute on function app.next_document_number(uuid, text) from public, anon;
grant  execute on function app.next_document_number(uuid, text) to authenticated, service_role;

-- Bring every existing partner's counters past whatever numbers are already on their
-- documents, so the first allocation after this migration is clean rather than merely
-- recoverable. Only handles the app's own `PREFIX-0007` shape; anything else is left to
-- the skip loop above.
update workshops w set
  next_quote_no = greatest(w.next_quote_no, coalesce((
    select max((regexp_replace(d.number, '^.*-', ''))::int) + 1
      from partner_documents d
     where d.workshop_id = w.id and d.kind = 'quote' and d.number ~ '-\d+$'
  ), 1)),
  next_invoice_no = greatest(w.next_invoice_no, coalesce((
    select max((regexp_replace(d.number, '^.*-', ''))::int) + 1
      from partner_documents d
     where d.workshop_id = w.id and d.kind = 'invoice' and d.number ~ '-\d+$'
  ), 1));
