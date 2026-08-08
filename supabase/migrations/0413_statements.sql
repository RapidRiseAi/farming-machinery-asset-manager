-- 0413_statements.sql
-- G2c — A statement of account: what this customer owes, and how it got there.
--
-- Ported from AutoVault's customer statement, with its arithmetic fixed. AutoVault
-- assembles a statement in a 544-line API route
-- (`app/api/workshop/customer-statements/export/route.ts`) and gets six things wrong.
-- All six are visible in the code, and every one of them changes the number a customer
-- is asked to pay:
--
--  1. NO OPENING BALANCE. Rows are filtered `created_at >= from`, and the running balance
--     starts at zero. A statement for March shows nothing owed from February — so the
--     closing balance is not what the customer owes, it is what they were billed in
--     March. This is the classic statement bug and it makes the document useless for the
--     one thing it exists for.
--
--  2. CREDITS FOUND BY REGEX. `parseCreditNoteReference` matches `/\b(CN-[A-Z0-9-]{4,})\b/i`
--     against a free-text description, and a line counts as a credit if the description
--     matches `/credit\s+note\s+.*applied/i`. The accuracy of a customer's account
--     depends on how somebody worded a text field. Here the link is a column —
--     `corrects_document_id` — so it cannot be worded wrongly.
--
--  3. PAYMENTS ONLY APPEAR WHEN THE INVOICE IS FULLY PAID (`if paymentStatus !== 'paid'
--     return rows`). A customer who has paid half of a R20 000 invoice sees the full
--     R20 000 debit and no credit at all. The statement overstates what they owe.
--
--  4. AND WHEN IT IS PAID WITH NO RECORDED AMOUNT, THE PAYMENT IS INVENTED at the full
--     invoice value (`recordedPaidCents > 0 ? … : invoiceContextAmount`). A credit
--     appears on a customer's account that nobody ever received.
--
--  5. THE INVOICE DEBIT IS INFLATED BY ITS OWN CREDIT NOTES —
--     `total + creditCents - debitCents + appliedCredits` — and then the credit note is
--     listed again as its own credit row. The same credit is counted twice in opposite
--     directions and only nets out by luck.
--
--  6. QUOTES ARE ON IT. A quote is not a financial event; nothing is owed because of one.
--     Putting them on a statement of account makes a ledger look like a to-do list.
--
-- Here a statement is one SQL function, so the screen, the PDF and the CSV cannot drift
-- apart, and the arithmetic is stated once:
--
--     an invoice is a DEBIT at its own total
--     a credit note is a CREDIT at its own total
--     a payment is a CREDIT at the amount actually received
--     everything before the period start collapses into an opening balance
--
-- Nothing else. That is the whole definition, and it is why it fits on one screen.

-- ── The rows ─────────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER: RLS is the guarantor, exactly as it is for `app.fleet_downtime`. A
-- partner pulling a statement sees its own documents because `partner_documents_sel`
-- admits them; a farm pulling a statement of what a partner has billed them sees the same
-- rows from the other side. Neither needs a bespoke permission check here, and neither
-- can see anything the tables would not already show them.
create or replace function app.partner_statement(
  p_workshop uuid,
  p_farm     uuid,
  p_client   uuid,
  p_from     date,
  p_to       date
) returns table (
  entry_date   date,
  kind         text,
  reference    text,
  description  text,
  document_id  uuid,
  debit_cents  bigint,
  credit_cents bigint,
  due_date     date
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with scope as (
    select d.*
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       and d.status not in ('draft', 'void', 'cancelled')
       and d.kind in ('invoice', 'credit_note')
       -- Exactly one recipient, and the caller must name which.
       and ((p_farm   is not null and d.farm_id           = p_farm)
         or (p_client is not null and d.partner_client_id = p_client))
  ),
  -- Everything that happened before the window, as one line. Without this the closing
  -- balance is not a balance.
  opening as (
    select coalesce(sum(case when kind = 'invoice' then total_cents else -total_cents end), 0)
             - coalesce((select sum(p.amount_cents)
                           from partner_payments p
                           join scope s2 on s2.id = p.document_id
                          where p.deleted_at is null and p.paid_on < p_from), 0) as cents
      from scope
     where issue_date < p_from
  ),
  documents as (
    select issue_date as entry_date,
           kind::text as kind,
           number     as reference,
           coalesce(subject, case when kind = 'credit_note' then 'Credit note' else 'Invoice' end) as description,
           id         as document_id,
           case when kind = 'invoice'     then total_cents else 0 end as debit_cents,
           case when kind = 'credit_note' then total_cents else 0 end as credit_cents,
           due_date
      from scope
     where issue_date between p_from and p_to
  ),
  payments as (
    select p.paid_on as entry_date,
           'payment' as kind,
           coalesce(nullif(btrim(p.reference), ''), s.number) as reference,
           case when p.method is null then 'Payment received'
                else 'Payment received (' || p.method || ')' end as description,
           s.id      as document_id,
           0::bigint as debit_cents,
           p.amount_cents as credit_cents,
           null::date as due_date
      from partner_payments p
      join scope s on s.id = p.document_id
     where p.deleted_at is null
       and p.paid_on between p_from and p_to
  )
  select p_from, 'opening', null, 'Balance brought forward', null,
         greatest(o.cents, 0), greatest(-o.cents, 0), null
    from opening o
   where o.cents <> 0
  union all
  select * from documents
  union all
  select * from payments
   order by 1, 2;
$$;

-- ── The ageing ───────────────────────────────────────────────────────────────
--
-- What is overdue and by how long — the second half of every statement in the trade, and
-- absent from AutoVault entirely. Buckets are measured from the DUE date, not the issue
-- date, because an invoice on 30-day terms is not overdue on day one.
--
-- Credits and payments are applied oldest-first, which is both the convention and the
-- only allocation a customer can check without being told which invoice you decided to
-- settle.
create or replace function app.partner_ageing(
  p_workshop uuid,
  p_farm     uuid,
  p_client   uuid,
  p_as_at    date default current_date
) returns table (
  current_cents bigint,
  d30_cents     bigint,
  d60_cents     bigint,
  d90_cents     bigint,
  total_cents   bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with invoices as (
    select d.id, d.total_cents, coalesce(d.due_date, d.issue_date) as due,
           coalesce((select sum(p.amount_cents) from partner_payments p
                      where p.document_id = d.id and p.deleted_at is null
                        and p.paid_on <= p_as_at), 0)
         + coalesce((select sum(c.total_cents) from partner_documents c
                      where c.corrects_document_id = d.id and c.kind = 'credit_note'
                        and c.deleted_at is null and c.status not in ('draft', 'void', 'cancelled')
                        and c.issue_date <= p_as_at), 0) as settled
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.kind = 'invoice'
       and d.deleted_at is null
       and d.status not in ('draft', 'void', 'cancelled')
       and d.issue_date <= p_as_at
       and ((p_farm   is not null and d.farm_id           = p_farm)
         or (p_client is not null and d.partner_client_id = p_client))
  ),
  outstanding as (
    select greatest(total_cents - settled, 0) as owed, p_as_at - due as days_over
      from invoices
     where total_cents > settled
  )
  select
    coalesce(sum(owed) filter (where days_over <= 0),               0)::bigint,
    coalesce(sum(owed) filter (where days_over between 1 and 30),   0)::bigint,
    coalesce(sum(owed) filter (where days_over between 31 and 60),  0)::bigint,
    coalesce(sum(owed) filter (where days_over > 60),               0)::bigint,
    coalesce(sum(owed),                                             0)::bigint
  from outstanding;
$$;

-- ── PostgREST wrappers ───────────────────────────────────────────────────────
create or replace function public.partner_statement(
  p_workshop uuid, p_farm uuid, p_client uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  document_id uuid, debit_cents bigint, credit_cents bigint, due_date date
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_statement(p_workshop, p_farm, p_client, p_from, p_to);
$$;

create or replace function public.partner_ageing(
  p_workshop uuid, p_farm uuid, p_client uuid, p_as_at date default current_date
) returns table (
  current_cents bigint, d30_cents bigint, d60_cents bigint, d90_cents bigint, total_cents bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_ageing(p_workshop, p_farm, p_client, p_as_at);
$$;

revoke execute on function app.partner_statement(uuid, uuid, uuid, date, date)    from public, anon;
revoke execute on function app.partner_ageing(uuid, uuid, uuid, date)             from public, anon;
revoke execute on function public.partner_statement(uuid, uuid, uuid, date, date) from public, anon;
revoke execute on function public.partner_ageing(uuid, uuid, uuid, date)          from public, anon;
grant  execute on function app.partner_statement(uuid, uuid, uuid, date, date)    to authenticated, service_role;
grant  execute on function app.partner_ageing(uuid, uuid, uuid, date)             to authenticated, service_role;
grant  execute on function public.partner_statement(uuid, uuid, uuid, date, date) to authenticated, service_role;
grant  execute on function public.partner_ageing(uuid, uuid, uuid, date)          to authenticated, service_role;

comment on function app.partner_statement(uuid, uuid, uuid, date, date) is
  'A statement of account: opening balance, then every invoice, credit note and payment '
  'in the window. SECURITY INVOKER, so RLS decides who may read it and the same rows '
  'appear from both sides of the relationship.';
