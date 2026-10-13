-- 20261013100000_statement_row_keys.sql
-- Statements that can be read page by page.
--
-- The API returns at most 1 000 rows a request and says nothing when it stops. A statement
-- of account for a large customer over a year, or a busy partner's year-to-date statement
-- from its main parts supplier, passes that, and the PDF, the CSV and the emailed copy then
-- stopped part-way: the activity table ended, and the balance summed from it was wrong while
-- the outstanding total (summed in SQL) was right, so two figures on one page disagreed.
--
-- Reading page by page needs an order that never ties, and the API can only sort by columns
-- it is given. Each statement now also returns its sort rank (the balance brought forward
-- first, then the day's charges, then the day's settlements: the rank both functions already
-- sorted by, which could not be asked for from outside) and a key that is unique within its
-- kind (partner_statement.entry_id: the document, payment or written-off invoice the line is
-- about; supplier_statement already had expense_id). The lines and their order are unchanged.
--
-- A function's result type cannot change in place, so each is dropped and created again,
-- public wrapper first. Nothing else in the database calls them.

drop function if exists public.partner_statement(uuid, uuid, uuid, date, date);
drop function if exists app.partner_statement(uuid, uuid, uuid, date, date);
drop function if exists public.supplier_statement(uuid, uuid, date, date);
drop function if exists app.supplier_statement(uuid, uuid, date, date);

create function app.partner_statement(
  p_workshop uuid, p_farm uuid, p_client uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  document_id uuid, debit_cents bigint, credit_cents bigint, due_date date,
  entry_id uuid, sort_rank integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with scope as (
    select d.*
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       and d.status not in ('draft', 'void', 'cancelled')
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and ((p_farm   is not null and d.farm_id           = p_farm)
         or (p_client is not null and d.partner_client_id = p_client))
  ),
  -- What was still owed on each written-off invoice at the moment it was written off:
  -- its total, less anything actually paid, less anything already credited back. That is
  -- the number that has to come off the account for the balance to be true.
  writeoffs as (
    select s.id,
           s.written_off_at::date as entry_date,
           s.number,
           greatest(0, s.total_cents
             - coalesce(s.amount_paid_cents, 0)
             - coalesce((select sum(c.total_cents) from partner_documents c
                          where c.corrects_document_id = s.id and c.kind = 'credit_note'
                            and c.deleted_at is null
                            and c.status not in ('draft', 'void', 'cancelled')), 0)) as cents
      from scope s
     where s.status = 'written_off' and s.written_off_at is not null
  ),
  opening as (
    select coalesce(sum(case when kind = 'credit_note' then -total_cents else total_cents end), 0)
             - coalesce((select sum(p.amount_cents)
                           from partner_payments p
                           join scope s2 on s2.id = p.document_id
                          where p.deleted_at is null and p.paid_on < p_from), 0)
             - coalesce((select sum(w.cents) from writeoffs w where w.entry_date < p_from), 0) as cents
      from scope
     where issue_date < p_from
  ),
  -- `description` carries the row's own DETAIL and nothing else, a document's subject, a
  -- payment's method, null where there is none. The sentence ("Payment received",
  -- "Written off as bad debt") is composed in `src/lib/statement.ts`, because a statement
  -- posted to an Afrikaans farm cannot have half its lines written in English by a
  -- Postgres function. `kind` is what tells the renderer which sentence to use.
  written_off_lines as (
    select w.entry_date,
           'write_off'::text as kind,
           w.number     as reference,
           null::text   as description,
           w.id         as document_id,
           0::bigint    as debit_cents,
           w.cents      as credit_cents,
           null::date   as due_date,
           w.id         as entry_id
      from writeoffs w
     where w.entry_date between p_from and p_to and w.cents > 0
  ),
  documents as (
    select issue_date as entry_date,
           kind::text as kind,
           number     as reference,
           subject    as description,
           id         as document_id,
           case when kind = 'credit_note' then 0 else total_cents end as debit_cents,
           case when kind = 'credit_note' then total_cents else 0 end as credit_cents,
           due_date,
           id         as entry_id
      from scope
     where issue_date between p_from and p_to
  ),
  payments as (
    select p.paid_on as entry_date,
           case when p.is_refund then 'refund' else 'payment' end as kind,
           coalesce(nullif(btrim(p.reference), ''), s.number) as reference,
           p.method  as description,
           s.id      as document_id,
           0::bigint as debit_cents,
           p.amount_cents as credit_cents,   -- negative for a refund; the balance climbs back
           null::date as due_date,
           p.id       as entry_id
      from partner_payments p
      join scope s on s.id = p.document_id
     where p.deleted_at is null
       and p.paid_on between p_from and p_to
  )
  -- The union is WRAPPED so the ordering can carry an explicit rank.
  --
  -- It used to end with the ordinal pair (entry_date, kind), which put the balance brought
  -- forward in the right place only by the accident of how its name is spelt. 'opening'
  -- sorts after 'credit_note', 'debit_note' and 'invoice', so a document issued ON the
  -- window's first day appeared ABOVE the opening line, and `withRunningBalance` then ran
  -- the Balance column from the wrong start for every row until the opening row was
  -- reached. The closing total stayed correct, which is what let it go unnoticed - but the
  -- Balance column is the one a customer checks a statement against.
  --
  -- A rank cannot be expressed in the ORDER BY of a UNION (Postgres allows only output
  -- column names or ordinal positions there), so the union moves into a subquery. The
  -- tie-break after the rank is still `kind`, exactly as before.
  select x.entry_date, x.kind, x.reference, x.description, x.document_id,
         x.debit_cents, x.credit_cents, x.due_date, x.entry_id, x.sort_rank
    from (
      select p_from as entry_date, 'opening'::text as kind, null::text as reference,
             null::text as description, null::uuid as document_id,
             greatest(o.cents, 0) as debit_cents, greatest(-o.cents, 0) as credit_cents,
             null::date as due_date, null::uuid as entry_id, 0 as sort_rank
        from opening o
       where o.cents <> 0
      union all
      select *, 1 from documents
      union all
      select *, 1 from payments
      union all
      select *, 1 from written_off_lines
    ) x
   order by x.entry_date, x.sort_rank, x.kind, x.entry_id;
$$;

create function app.supplier_statement(
  p_workshop uuid,
  p_supplier uuid,
  p_from     date,
  p_to       date
) returns table (
  entry_date   date,
  kind         text,
  reference    text,
  description  text,
  category     partner_expense_category,
  expense_id   uuid,
  debit_cents  bigint,
  credit_cents bigint,
  due_date     date,
  sort_rank    integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with scope as (
    select e.id, e.reference, e.description, e.category, e.expense_date, e.paid_on,
           (e.amount_cents + e.vat_cents) as gross,
           -- DERIVED, and the screen says so. A supplier invoice carries no due date, so
           -- this is `expense_date + the supplier's own terms`, falling back to 30 days -
           -- the same rule and the same fallback 0491 gave the cash-flow forecast, because
           -- a partner reading "due 14 May" here and a different date on /cashflow would
           -- have no way to tell which one the product actually believes.
           (e.expense_date + coalesce(s.payment_terms_days, 30)) as due
      from partner_expenses e
      -- Not a left join: the statement is FOR this supplier record, so the row that
      -- supplies the terms is the row the whole statement is about.
      join suppliers s
        on s.id = e.supplier_id and s.workshop_id = e.workshop_id
     where e.workshop_id = p_workshop
       and e.supplier_id = p_supplier
       and e.deleted_at is null
  ),
  -- Everything that happened before the window, as one line. Without this the closing
  -- balance is not a balance, it is "what I was billed this quarter", the first and worst
  -- of the six faults 0413 catalogues.
  --
  -- The payment leg is deliberately NOT filtered by `expense_date`: a bill dated inside the
  -- window but settled before it (a prepayment, or a correction to a captured date) must
  -- still have its payment recognised, or the balance would carry a charge whose settlement
  -- appears nowhere. Same shape as 0413's opening.
  opening as (
    select coalesce((select sum(gross) from scope where expense_date < p_from), 0)
         - coalesce((select sum(gross) from scope where paid_on     < p_from), 0) as cents
  ),
  bills as (
    select expense_date as entry_date,
           'bill'::text as kind,
           nullif(btrim(reference), '')   as reference,
           nullif(btrim(description), '') as description,
           category,
           id           as expense_id,
           gross        as debit_cents,
           0::bigint    as credit_cents,
           due          as due_date,
           1            as sort_rank
      from scope
     where expense_date between p_from and p_to
  ),
  payments as (
    select paid_on      as entry_date,
           'payment'::text as kind,
           -- The supplier's own invoice number: the only thing that says WHICH bill this
           -- settled, since there is no payment record to carry a reference of its own.
           nullif(btrim(reference), '')   as reference,
           null::text   as description,
           category,
           id           as expense_id,
           0::bigint    as debit_cents,
           gross        as credit_cents,
           null::date   as due_date,
           2            as sort_rank
      from scope
     where paid_on between p_from and p_to
  ),
  everything as (
    select p_from       as entry_date,
           'opening'::text as kind,
           null::text   as reference,
           null::text   as description,
           null::partner_expense_category as category,
           null::uuid   as expense_id,
           greatest(o.cents, 0)  as debit_cents,
           greatest(-o.cents, 0) as credit_cents,
           null::date   as due_date,
           0            as sort_rank
      from opening o
     where o.cents <> 0
    union all select * from bills
    union all select * from payments
  )
  -- Ordered by an EXPLICIT rank rather than by the kind's spelling. 0413 orders `by 1, 2`,
  -- which happens to work there only because 'opening' sorts after 'credit_note' and
  -- 'invoice', so a document dated on the first day of the window is listed ABOVE the
  -- balance brought forward, and the running balance down the page starts from the wrong
  -- number. 'bill' would collide the same way here. The opening line is first, then the
  -- day's charge, then the day's settlement, which is also the order the events happened in.
  select entry_date, kind, reference, description, category, expense_id,
         debit_cents, credit_cents, due_date, sort_rank
    from everything
   order by entry_date, sort_rank, reference nulls last, expense_id;
$$;

create function public.partner_statement(
  p_workshop uuid, p_farm uuid, p_client uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  document_id uuid, debit_cents bigint, credit_cents bigint, due_date date,
  entry_id uuid, sort_rank integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_statement(p_workshop, p_farm, p_client, p_from, p_to);
$$;

create function public.supplier_statement(
  p_workshop uuid, p_supplier uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  category partner_expense_category, expense_id uuid,
  debit_cents bigint, credit_cents bigint, due_date date, sort_rank integer
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.supplier_statement(p_workshop, p_supplier, p_from, p_to);
$$;

comment on function app.partner_statement(uuid, uuid, uuid, date, date) is
  'A statement of account: opening balance, then every invoice, credit note and payment '
  'in the window. SECURITY INVOKER, so RLS decides who may read it and the same rows '
  'appear from both sides of the relationship. sort_rank and entry_id give the API an '
  'order that never ties, so the statement can be read page by page.';

comment on function app.supplier_statement(uuid, uuid, date, date) is
  'A supplier statement of account (G25): opening balance, then every bill and every '
  'settlement in the window, gross. SECURITY INVOKER, so RLS decides; workshop-scoped. '
  'sort_rank and expense_id give the API an order that never ties, so the statement can be '
  'read page by page.';

-- Helper-only app.* and the public API, as before: never EXECUTE to PUBLIC, every one of
-- these exposes money.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.partner_statement(uuid,uuid,uuid,date,date)',
    'public.partner_statement(uuid,uuid,uuid,date,date)',
    'app.supplier_statement(uuid,uuid,date,date)',
    'public.supplier_statement(uuid,uuid,date,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
