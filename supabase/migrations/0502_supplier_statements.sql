-- 0502_supplier_statements.sql
-- G25 — The statement, from the other side of the counter.
--
-- 0413 answers "what does this customer owe me, and how did it get there". Nothing answers
-- the mirror. A partner can see their whole payables ageing on /money (0460, 0482) and see
-- one line per supplier — and cannot open that line. "What did I buy from Agri Diesel this
-- year, what have I paid them, and what is still outstanding" is a question every account
-- with a supplier gets asked, usually by the supplier, and the answer lived nowhere.
--
-- And when the partner pays, there is no REMITTANCE ADVICE. A supplier who receives one
-- EFT covering six invoices has to guess the allocation, and guesses wrong in the
-- direction that produces a phone call: the oldest invoice stays open on their books and
-- the partner is chased for money they have already sent. A remittance is a small document
-- that removes an entire category of argument.
--
-- No new tables. Every figure below is an aggregation over `partner_expenses` and
-- `suppliers`, both of which already exist and are already scoped.
--
-- ── The limitation, stated rather than papered over ───────────────────────────
--
-- The sales side has `partner_payments`: a row per receipt, with an amount, so a customer
-- who pays half of a R20 000 invoice shows a R10 000 credit and a R10 000 balance. The
-- purchase side has NO payment records at all. `partner_expenses.paid_on` (0430) is a
-- single nullable DATE, and 0470's bank reconciliation sets it to the day the money left.
-- So on this statement:
--
--   * a "payment" line is a BILL WHOSE `paid_on` FALLS IN THE PERIOD, credited at its full
--     gross value. There is no other information to draw on;
--   * a PART-PAYMENT cannot be represented. A bill is settled or it is not. That is a
--     property of the data model, not of this function, and it is what would have to
--     change first if part-paying a supplier ever needs recording;
--   * the reference on a payment line is the SUPPLIER's own invoice number, because that
--     is the only thing identifying what was settled — there is no payment reference, and
--     no method either. A remittance advice is what carries that detail instead.
--
-- Any of those three could have been hidden behind a cheerful "Payment" row. Written down
-- here they are a boundary somebody can act on.
--
-- ── Money is GROSS, deliberately ─────────────────────────────────────────────
--
-- `amount_cents` is ex-VAT and `vat_cents` is the supplier's own VAT line (0430). What
-- LEAVES THE BANK is the sum, and a statement of account is about what leaves the bank —
-- so every debit, every credit and every bucket below is `amount_cents + vat_cents`, which
-- is exactly what `app.partner_creditors` (0460, regrouped by 0482) already does. If this
-- screen were ex-VAT and /money were gross, a partner would read two different answers to
-- "what do I owe Agri Diesel" in the same week and stop believing both. The ex-VAT and VAT
-- halves are still reported separately on the REMITTANCE, where a supplier reconciling to
-- their own tax invoice needs them.
--
-- ── Filed suppliers only ─────────────────────────────────────────────────────
--
-- A statement is per supplier RECORD (`p_supplier`), so an expense still carrying only a
-- typed `supplier_name` appears on no statement. That is the honest answer: there is no
-- business to address it to. 0481 refuses to invent a supplier from a name, /suppliers
-- already counts the unfiled invoices and says how to attach them, and the moment one is
-- filed its history attaches and shows up here.
--
-- ── Wording is NOT in SQL ────────────────────────────────────────────────────
--
-- `src/lib/statement.ts` sets the rule and gives the reason: a statement posted to an
-- Afrikaans reader must not have half its lines written in English by a Postgres function.
-- So these functions return what a row IS (`kind`) and the row's OWN detail (`description`
-- — the supplier's note, or null), and never a sentence. This is the one place 0413's SQL
-- did not quite hold to its own rule (it coalesces a missing subject to the literal
-- 'Invoice'); `src/lib/supplier-statement.ts` composes every sentence here.

-- ── The rows ─────────────────────────────────────────────────────────────────
--
-- SECURITY INVOKER, exactly as 0413 and 0460 argue: `partner_expenses` and `suppliers` are
-- workshop-scoped (0430/0480 policy sets, no farm path at all), so passing another
-- workshop's id is answered by RLS on the underlying tables rather than by a check in a
-- body somebody could forget to write. A rival partner gets an empty statement; the FARM
-- this workshop works for gets an empty statement, because a farm reading who its
-- contractor buys from and on what terms is reading the margin behind every quote it has
-- ever been given (F16).
--
-- The arithmetic, once:
--
--     a supplier bill is a DEBIT at its gross value
--     a bill settled in the period is a CREDIT at its gross value
--     everything before the period start collapses into an opening balance
--
-- Nothing else.
create or replace function app.supplier_statement(
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
  due_date     date
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with scope as (
    select e.id, e.reference, e.description, e.category, e.expense_date, e.paid_on,
           (e.amount_cents + e.vat_cents) as gross,
           -- DERIVED, and the screen says so. A supplier invoice carries no due date, so
           -- this is `expense_date + the supplier's own terms`, falling back to 30 days —
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
  -- balance is not a balance, it is "what I was billed this quarter" — the first and worst
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
           due          as due_date
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
           null::date   as due_date
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
           null::date   as due_date
      from opening o
     where o.cents <> 0
    union all select * from bills
    union all select * from payments
  )
  -- Ordered by an EXPLICIT rank rather than by the kind's spelling. 0413 orders `by 1, 2`,
  -- which happens to work there only because 'opening' sorts after 'credit_note' and
  -- 'invoice' — so a document dated on the first day of the window is listed ABOVE the
  -- balance brought forward, and the running balance down the page starts from the wrong
  -- number. 'bill' would collide the same way here. The opening line is first, then the
  -- day's charge, then the day's settlement, which is also the order the events happened in.
  select entry_date, kind, reference, description, category, expense_id,
         debit_cents, credit_cents, due_date
    from everything
   order by entry_date,
            case kind when 'opening' then 0 when 'bill' then 1 else 2 end,
            reference nulls last;
$$;

-- ── The ageing, for one supplier ─────────────────────────────────────────────
--
-- `app.partner_creditors` ages EVERY supplier and groups the answer; there is no way to ask
-- it about one. Matching its output by the supplier's name would be exactly the string
-- lookup G18 (0480–0482) existed to abolish, so this asks the question directly.
--
-- Same buckets, same boundaries, same gross figure as `app.partner_creditors`, on purpose:
-- /money and this screen are read by the same person in the same week, and G25 asserts they
-- agree on the total rather than trusting that they were written the same way. Age is
-- measured from the SUPPLIER'S OWN INVOICE DATE, not from a due date — an expense has no
-- due date, so this is "how long have I been sitting on this", and the screen says which.
create or replace function app.supplier_ageing(
  p_workshop uuid,
  p_supplier uuid,
  p_as_at    date default current_date
) returns table (
  current_cents bigint,
  d30_cents     bigint,
  d60_cents     bigint,
  d90_cents     bigint,
  total_cents   bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with unpaid as (
    select (e.amount_cents + e.vat_cents) as owed,   -- what actually leaves the bank
           p_as_at - e.expense_date as age
      from partner_expenses e
     where e.workshop_id = p_workshop
       and e.supplier_id = p_supplier
       and e.deleted_at is null
       and e.paid_on is null
       and e.expense_date <= p_as_at
  )
  select
    coalesce(sum(owed) filter (where age <= 30),              0)::bigint,
    coalesce(sum(owed) filter (where age between 31 and 60),  0)::bigint,
    coalesce(sum(owed) filter (where age between 61 and 90),  0)::bigint,
    coalesce(sum(owed) filter (where age > 90),               0)::bigint,
    coalesce(sum(owed),                                       0)::bigint
  from unpaid;
$$;

-- ── The remittance ───────────────────────────────────────────────────────────
--
-- What one payment covered. Keyed on the DATE the money left, because that is the only
-- thing the purchase side records about a payment and because it is also how the payment
-- actually happened: a partner sits down on Friday, pays the week's bills in one banking
-- session, and 0470's reconciliation stamps them all with the same `paid_on`.
--
-- Ex-VAT and VAT are reported SEPARATELY here, unlike the statement. A supplier
-- reconciling a remittance against their own tax invoice is looking at both lines on that
-- invoice, and a single gross figure makes them do the arithmetic backwards.
create or replace function app.supplier_remittance(
  p_workshop uuid,
  p_supplier uuid,
  p_paid_on  date
) returns table (
  expense_id   uuid,
  expense_date date,
  reference    text,
  description  text,
  category     partner_expense_category,
  amount_cents bigint,
  vat_cents    bigint,
  total_cents  bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select e.id,
         e.expense_date,
         nullif(btrim(e.reference), ''),
         nullif(btrim(e.description), ''),
         e.category,
         e.amount_cents,
         e.vat_cents,
         (e.amount_cents + e.vat_cents)::bigint
    from partner_expenses e
   where e.workshop_id = p_workshop
     and e.supplier_id = p_supplier
     and e.deleted_at is null
     and e.paid_on = p_paid_on
   order by e.expense_date, e.reference nulls last;
$$;

-- ── PostgREST wrappers ───────────────────────────────────────────────────────
-- The column lists are restated rather than referenced: a function's RETURNS TABLE is not
-- a named composite type, so `returns setof app.supplier_statement` does not exist. Same
-- shape as the 0413 and 0460 wrappers.
create or replace function public.supplier_statement(
  p_workshop uuid, p_supplier uuid, p_from date, p_to date
) returns table (
  entry_date date, kind text, reference text, description text,
  category partner_expense_category, expense_id uuid,
  debit_cents bigint, credit_cents bigint, due_date date
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.supplier_statement(p_workshop, p_supplier, p_from, p_to);
$$;

create or replace function public.supplier_ageing(
  p_workshop uuid, p_supplier uuid, p_as_at date default current_date
) returns table (
  current_cents bigint, d30_cents bigint, d60_cents bigint, d90_cents bigint, total_cents bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.supplier_ageing(p_workshop, p_supplier, p_as_at);
$$;

create or replace function public.supplier_remittance(
  p_workshop uuid, p_supplier uuid, p_paid_on date
) returns table (
  expense_id uuid, expense_date date, reference text, description text,
  category partner_expense_category, amount_cents bigint, vat_cents bigint, total_cents bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.supplier_remittance(p_workshop, p_supplier, p_paid_on);
$$;

comment on function app.supplier_statement(uuid, uuid, date, date) is
  'A supplier statement of account (G25): opening balance, then every bill and every '
  'settlement in the window, GROSS (amount + the supplier''s own VAT) because that is what '
  'leaves the bank — the same figure app.partner_creditors ages. SECURITY INVOKER, so RLS '
  'decides; workshop-scoped, so no farm ever reads it. The purchase side has no payment '
  'records, only partner_expenses.paid_on, so a settlement is all-or-nothing and carries '
  'the supplier''s own invoice number as its reference.';
comment on function app.supplier_ageing(uuid, uuid, date) is
  'Payables ageing for ONE supplier (G25). Same buckets, boundaries and gross figure as '
  'app.partner_creditors so /money and the supplier page cannot disagree; aged from the '
  'supplier''s own invoice date, because a supplier invoice has no due date.';
comment on function app.supplier_remittance(uuid, uuid, date) is
  'The bills this supplier was paid for on one date (G25), for a remittance advice. Keyed '
  'on paid_on because that is all the purchase side records about a payment, and because '
  'one banking session stamps a whole batch with the same date. Ex-VAT and VAT are split '
  'so the supplier can tie each line to their own tax invoice.';

-- app.* is helper-only and the public wrappers are the API. G11's rule: a function with no
-- explicit grant defaults to EXECUTE TO PUBLIC, and every one of these exposes money.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.supplier_statement(uuid,uuid,date,date)',
    'app.supplier_ageing(uuid,uuid,date)',
    'app.supplier_remittance(uuid,uuid,date)',
    'public.supplier_statement(uuid,uuid,date,date)',
    'public.supplier_ageing(uuid,uuid,date)',
    'public.supplier_remittance(uuid,uuid,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
