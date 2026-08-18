-- 0504_statement_opening_balance_first.sql
-- The balance brought forward belongs at the top of the statement.
--
-- Found while building the SUPPLIER statement (0502), which needed the same ordering and
-- deliberately did not copy this one. 0413 introduced the ordinal ordering and 0418/0423
-- carried it forward. The kinds are 'credit_note', 'debit_note', 'invoice', 'opening',
-- 'payment', 'refund', 'write_off' - and the first three sort BEFORE 'opening'.
--
-- The opening row is dated p_from. So whenever a document was issued on the window's first
-- day - the 1st of a month, or exactly 90 days ago, which is the DEFAULT period - the
-- statement printed that document above "Balance brought forward". Reproduced before
-- writing this fix: an invoice of R230,00 issued on the from-date rendered as the first
-- line of the statement with a running balance of R230,00, when the customer in fact owed
-- R1 150,00 at that moment. The closing figure was right; every Balance cell above the
-- opening row was wrong.
--
-- Affects /statements, the statement PDF, the statement CSV and the emailed statement,
-- since all four render `withRunningBalance`.
--
-- The function is otherwise UNCHANGED from 0423 - same CTEs, same money, same visibility.

create or replace function app.partner_statement(
  p_workshop uuid, p_farm uuid, p_client uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  document_id uuid, debit_cents bigint, credit_cents bigint, due_date date
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
  -- `description` carries the row's own DETAIL and nothing else — a document's subject, a
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
           null::date   as due_date
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
           due_date
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
           null::date as due_date
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
         x.debit_cents, x.credit_cents, x.due_date
    from (
      select p_from as entry_date, 'opening'::text as kind, null::text as reference,
             null::text as description, null::uuid as document_id,
             greatest(o.cents, 0) as debit_cents, greatest(-o.cents, 0) as credit_cents,
             null::date as due_date, 0 as sort_rank
        from opening o
       where o.cents <> 0
      union all
      select *, 1 from documents
      union all
      select *, 1 from payments
      union all
      select *, 1 from written_off_lines
    ) x
   order by x.entry_date, x.sort_rank, x.kind;
$$;
