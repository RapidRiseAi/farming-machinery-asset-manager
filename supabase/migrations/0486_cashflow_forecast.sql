-- 0486_cashflow_forecast.sql
-- What is ABOUT to happen to the bank account.
--
-- 0460 answered "did this month make money, who owes me, who do I owe". Every one of
-- those questions looks BACKWARDS, and the question a small workshop actually loses sleep
-- over looks forwards: can I pay wages at the end of the month. A partner can be
-- profitable on the P&L, owed R80 000, and still unable to settle a R12 000 supplier
-- account on Friday, because profit is an opinion about a period and cash is a fact about
-- a date. Nothing in this product could answer that, so the answer lived in somebody's
-- head or in a spreadsheet nobody else could see.
--
-- No new tables. Everything below is an aggregation over `partner_documents`,
-- `partner_payments`, `recurring_invoices`, `partner_expenses` and `purchase_orders`,
-- all of which already exist and are already workshop-scoped.
--
-- ── Why SQL rather than the page ────────────────────────────────────────────
--
-- The same reason `partner_statement`, `partner_ageing`, `partner_vat_return` and the
-- 0460 money answers are SQL: a screen, a CSV, a PDF and an emailed copy must not be able
-- to disagree. A forecast computed in a React component is a forecast that exists in one
-- place only until somebody adds an export, and then there are two forecasts.
--
-- ── EX-VAT or GROSS: gross, everywhere, and here is why ─────────────────────
--
-- The ledger is ex-VAT because that is what a P&L and a VAT return are made of. A cash
-- forecast is not made of that. When a farmer settles an invoice the bank receives the
-- VAT-inclusive total, and when the workshop pays Bearing Co the bank loses the
-- VAT-inclusive total — the fact that R1 500 of it will come back from SARS in six weeks
-- does not help on Friday. So every figure in this migration is GROSS:
--
--   * outstanding invoices use `partner_documents.total_cents` (VAT-inclusive) less what
--     has settled, exactly as `app.partner_debtors` does;
--   * a standing invoice is rolled up from its lines and then has VAT ADDED, mirroring
--     the document rollup the generator will produce;
--   * an unpaid supplier invoice is `amount_cents + vat_cents`, the same expression
--     `app.partner_creditors` and `app.partner_cash` already use for money that leaves;
--   * a purchase order uses its own maintained `total_cents`, which is gross.
--
-- The one place ex-VAT would be right — profitability — is the screen next door.
--
-- ── Four judgements worth stating, because each is a place to be plausibly wrong ──
--
-- 1. AN OVERDUE INVOICE IS EXPECTED NOW, NOT IN THE PAST. Bucketing by raw date would put
--    a 90-day-old debt in a bucket that has already gone by, where it silently disappears
--    from the forecast — or, worse, quietly into "this week", which reads as a promise
--    nobody made. It gets its own bucket at the front, ahead of everything, and the screen
--    says how late each one is. It is money you are owed today and have not got.
--
-- 2. CASH ARRIVES ON THE TERMS DATE, NOT THE ISSUE DATE. A standing invoice raised on the
--    1st with 30-day terms is not cash on the 1st. So a schedule is SELECTED by
--    `next_issue_date` inside the horizon and BUCKETED at `next_issue_date +
--    workshops.invoice_terms_days` — the same terms the generator (0433) will stamp on the
--    document it raises, so the forecast and the invoice agree. The same reasoning moves a
--    purchase order's date: `expected_date` is when the parts arrive, and the supplier's
--    invoice is paid a further term after that.
--
-- 3. A PURCHASE ORDER ALREADY CONVERTED TO AN EXPENSE IS NOT FORECAST AGAIN. 0475 records
--    the link from the supplier's invoice back to the order. Without that exclusion an
--    order would be counted once as a commitment and once as an unpaid expense, and the
--    outflow side would overstate itself by exactly the orders that are going best. This
--    is the same "which row owns this rand" rule 0450 and 0473 worked through, applied to
--    a forecast instead of a ledger.
--
-- 4. THE SUPPLIER TERM IS AN ASSUMPTION, AND IT IS NAMED. `partner_expenses` carries no
--    due date — only the supplier's own invoice date — which 0460 already called out when
--    it aged creditors from that date rather than implying lateness. A forecast cannot
--    dodge the question the way an ageing table can, so it assumes 30 DAYS from the
--    supplier's invoice date, which is the ordinary trade term in South Africa and the one
--    a partner who has never thought about it is most likely to be on. It is stated in one
--    place here, restated on the screen in words, and the honest fix is a real due date on
--    the expense (or per-supplier terms) rather than a better guess.
--
-- ── What is NOT in here yet ────────────────────────────────────────────────
--
-- `recurring_expenses` — a standing outflow (rent, insurance, medical aid, a debit order
-- for the workshop's own finance) — is the obvious next input to the outflow side and the
-- one that will change the shape of a month most. It is being built separately; when it
-- lands it belongs in `outflow` below alongside the unpaid expenses, dated from its own
-- next-due date with no terms offset, because a debit order leaves on the day it says.
--
-- Also deliberately absent: the bank balance. `bank_statement_lines` (0470) is an import
-- queue, not an authoritative balance, and a forecast that invented one would be believed.
-- The running total below is a CUMULATIVE MOVEMENT from zero — the change against whatever
-- is in the account today — and the screen lets the reader type today's balance to see the
-- week it runs out.

-- ── Every expected movement, one row each ────────────────────────────────────
--
-- The aggregate below is built FROM this function rather than repeating its four queries,
-- so a bucket total can never disagree with the items shown underneath it. 0460 made the
-- same choice for the expense breakdown, for the same reason: a total nobody can take
-- apart is a total nobody believes.
create or replace function app.partner_cashflow_items(p_workshop uuid, p_horizon_days int default 90)
returns table (
  bucket        text,
  ordinal       int,
  direction     text,     -- 'in' | 'out'
  source        text,     -- 'invoice' | 'recurring' | 'expense' | 'purchase_order'
  ref           text,     -- the document/order number, or the schedule's name
  party         text,     -- who pays it, or who is owed it
  expected_date date,     -- when the cash is expected to move
  days_late     int,      -- 0 unless the date has already gone by
  amount_cents  bigint,   -- GROSS, always. See the header.
  source_id     uuid
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with edges as (
    select
      current_date                                                            as today,
      -- Postgres weeks start on Monday, which is also how a farm week is counted here.
      (date_trunc('week', current_date)::date + 6)                            as wk_end,
      (date_trunc('week', current_date)::date + 13)                           as nxt_end,
      (date_trunc('month', current_date)::date + interval '1 month - 1 day')::date as mo_end,
      current_date + greatest(coalesce(p_horizon_days, 90), 0)                as horizon,
      -- Judgement 4. One place, named, restated on the screen.
      30                                                                      as supplier_terms_days
  ),

  -- ── IN: invoices already out there and not yet settled ────────────────────
  -- The settlement arithmetic is copied deliberately from `app.partner_debtors` (0460):
  -- payments received plus credit notes issued against the invoice. If the two ever
  -- diverge, a partner reads one figure on the money screen and a different one here and
  -- believes neither. Kind is `invoice` only, matching debtors — a debit note raises what
  -- is owed on the invoice it corrects rather than standing as its own collectable.
  inv as (
    select
      d.id,
      coalesce(nullif(btrim(d.number), ''), '—')                              as ref,
      coalesce(nullif(btrim(d.bill_to_name), ''), '—')                        as party,
      coalesce(d.due_date, d.issue_date)                                      as due,
      d.total_cents
        - coalesce((select sum(p.amount_cents) from partner_payments p
                     where p.document_id = d.id and p.deleted_at is null
                       and p.paid_on <= e.today), 0)
        - coalesce((select sum(c.total_cents) from partner_documents c
                     where c.corrects_document_id = d.id and c.kind = 'credit_note'
                       and c.deleted_at is null
                       and c.status not in ('draft', 'void', 'cancelled')
                       and c.issue_date <= e.today), 0)                       as outstanding
      from partner_documents d
      cross join edges e
     where d.workshop_id = p_workshop
       and d.kind = 'invoice'
       and d.deleted_at is null
       -- A draft has not been sent, so nobody owes it. A void or cancelled document does
       -- not exist. A written-off one was given up on (G5) and is deliberately no longer
       -- chased — forecasting it would be forecasting money the partner has already
       -- decided is not coming.
       and d.status not in ('draft', 'void', 'cancelled', 'written_off')
       -- The horizon is a question about the FUTURE ("what does the next six weeks look
       -- like"), so it never hides a debt that is already late. Overdue money is here now
       -- whatever window the reader chose.
       and (coalesce(d.due_date, d.issue_date) < e.today
            or coalesce(d.due_date, d.issue_date) <= e.horizon)
  ),

  -- ── IN: standing invoices not raised yet ──────────────────────────────────
  -- Money that has not been billed but will be. Rolled up exactly as 0381's document
  -- triggers will roll up the invoice this schedule produces: line total is
  -- qty × price − line discount, floored at zero; the document discount comes off the
  -- subtotal; VAT is added to what is left.
  rec as (
    select
      ri.id,
      coalesce(nullif(btrim(ri.name), ''), '—')                               as ref,
      -- `bill_to_name` is null when the recipient is a linked farm or a client from the
      -- partner's own book, and reading those names back out is a different tenancy
      -- question. The schedule's own name is always present and is what the partner calls
      -- this money anyway.
      coalesce(nullif(btrim(ri.bill_to_name), ''), nullif(btrim(ri.name), ''), '—') as party,
      (ri.next_issue_date + w.invoice_terms_days)                             as due,
      (l.net + round(l.net * ri.vat_rate_bps / 10000.0)::bigint)              as gross
      from recurring_invoices ri
      join workshops w on w.id = ri.workshop_id
      cross join edges e
      cross join lateral (
        select greatest(0, sub - least(coalesce(ri.discount_cents, 0), sub))   as net
          from (select coalesce(sum(greatest(0,
                         round(x.qty * x.unit_price_cents)::bigint - coalesce(x.discount_cents, 0))), 0) as sub
                  from recurring_invoice_lines x
                 where x.recurring_id = ri.id and x.deleted_at is null) s
      ) l
     where ri.workshop_id = p_workshop
       and ri.deleted_at is null
       and ri.active
       and ri.next_issue_date between e.today and e.horizon
       and (ri.ends_on is null or ri.next_issue_date <= ri.ends_on)
       -- The generator's own idempotency key (0433): a schedule whose next period has
       -- already been billed will be skipped and rolled forward, so forecasting it would
       -- be forecasting an invoice that is never raised.
       and (ri.last_period_start is null or ri.next_issue_date > ri.last_period_start)
       -- No lines means no invoice — the generator refuses to raise a zero-rand document,
       -- and a forecast should not promise one either.
       and l.net > 0
  ),

  -- ── OUT: supplier invoices sitting unpaid ─────────────────────────────────
  -- GROSS, because the VAT goes out of the bank with the rest of it. Same expression as
  -- `app.partner_creditors` and `app.partner_cash`.
  exp as (
    select
      x.id,
      coalesce(nullif(btrim(x.reference), ''), '—')                           as ref,
      coalesce(nullif(btrim(x.supplier_name), ''), '—')                       as party,
      (x.expense_date + e.supplier_terms_days)                                as due,
      (x.amount_cents + x.vat_cents)                                          as gross
      from partner_expenses x
      cross join edges e
     where x.workshop_id = p_workshop
       and x.deleted_at is null
       and x.paid_on is null
       -- Same rule as the invoices above: already late is always in view.
       and (x.expense_date + e.supplier_terms_days < e.today
            or x.expense_date + e.supplier_terms_days <= e.horizon)
  ),

  -- ── OUT: money committed on an order and not yet invoiced ─────────────────
  -- A purchase order is a commitment, never a cost (0473) — but a commitment is precisely
  -- what a forecast is about, and it is the outflow a partner is most likely to have
  -- forgotten because no paper has arrived yet. `sent` and `part_received` only: a draft
  -- has not left the building, and `received`/`closed`/`cancelled` are either already
  -- invoiced or never happening.
  --
  -- The whole order value is forecast, including any part already delivered, because none
  -- of it has been invoiced yet — the moment any of it is, 0475's link fires and the order
  -- drops out of the forecast entirely in favour of the real expense.
  po as (
    select
      o.id,
      coalesce(nullif(btrim(o.reference), ''), o.supplier_name)               as ref,
      coalesce(nullif(btrim(o.supplier_name), ''), '—')                       as party,
      (o.expected_date + e.supplier_terms_days)                               as due,
      o.total_cents                                                           as gross
      from purchase_orders o
      cross join edges e
     where o.workshop_id = p_workshop
       and o.deleted_at is null
       and o.status in ('sent', 'part_received')
       -- An order with no expected date cannot be placed on a calendar. It is left out
       -- rather than guessed at, and the screen says so instead of quietly dropping it.
       and o.expected_date is not null
       and o.expected_date <= e.horizon
       and o.total_cents > 0
       and not exists (
         select 1 from partner_expenses px
          where px.purchase_order_id = o.id and px.deleted_at is null)
  ),

  moves as (
    select 'in'::text  as direction, 'invoice'::text        as source, ref, party, due, outstanding as amount, id from inv
     where outstanding > 0
    union all
    select 'in',  'recurring',      ref, party, due, gross, id from rec
    union all
    select 'out', 'expense',        ref, party, due, gross, id from exp
    union all
    select 'out', 'purchase_order', ref, party, due, gross, id from po
  )

  select
    -- Judgement 1: anything whose date has gone by is expected NOW, in its own bucket at
    -- the front, never folded into a future one.
    case when m.due <  e.today   then 'overdue'
         when m.due <= e.wk_end  then 'this_week'
         when m.due <= e.nxt_end then 'next_week'
         when m.due <= e.mo_end  then 'this_month'
         else 'later' end,
    case when m.due <  e.today   then 1
         when m.due <= e.wk_end  then 2
         when m.due <= e.nxt_end then 3
         when m.due <= e.mo_end  then 4
         else 5 end,
    m.direction, m.source, m.ref, m.party, m.due,
    greatest(0, e.today - m.due)::int,
    m.amount::bigint,
    m.id
    from moves m
    cross join edges e
   -- The horizon governs SELECTION above; a movement dated beyond it by the terms offset
   -- still belongs in `later` rather than vanishing, which is why there is no clip here.
   order by 2, 7, 9 desc;
$$;

-- ── The forecast itself ──────────────────────────────────────────────────────
-- Always five rows, empty ones included. A bucket that disappears when nothing falls in it
-- makes the running balance unreadable, and "nothing goes out next week" is itself an
-- answer worth showing.
create or replace function app.partner_cashflow(p_workshop uuid, p_horizon_days int default 90)
returns table (
  bucket        text,
  ordinal       int,
  from_date     date,     -- null for `overdue`: it has no start
  to_date       date,     -- null for `later`: it has no end
  in_cents      bigint,
  out_cents     bigint,
  net_cents     bigint,
  running_cents bigint,   -- cumulative movement, NOT a bank balance. See the header.
  item_count    int
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with e as (
    select
      current_date                                                            as today,
      (date_trunc('week', current_date)::date + 6)                            as wk_end,
      (date_trunc('week', current_date)::date + 13)                           as nxt_end,
      (date_trunc('month', current_date)::date + interval '1 month - 1 day')::date as mo_end
  ),
  scaffold as (
    select * from (values
      ('overdue', 1), ('this_week', 2), ('next_week', 3), ('this_month', 4), ('later', 5)
    ) v(bucket, ordinal)
  ),
  bounds as (
    select s.bucket, s.ordinal,
           case s.bucket when 'this_week'  then e.today
                         when 'next_week'  then e.wk_end + 1
                         when 'this_month' then e.nxt_end + 1
                         when 'later'      then e.mo_end + 1 end as from_date,
           case s.bucket when 'overdue'    then e.today - 1
                         when 'this_week'  then e.wk_end
                         when 'next_week'  then e.nxt_end
                         -- Near the end of a month this can fall BEFORE `from_date`, which
                         -- is correct and means the window is empty: next week has already
                         -- swallowed the rest of the month. The screen shows the bucket
                         -- with nothing in it rather than pretending it does not exist.
                         when 'this_month' then e.mo_end end   as to_date
      from scaffold s cross join e
  ),
  agg as (
    select i.bucket,
           coalesce(sum(i.amount_cents) filter (where i.direction = 'in'),  0) as ins,
           coalesce(sum(i.amount_cents) filter (where i.direction = 'out'), 0) as outs,
           count(*)                                                           as n
      from app.partner_cashflow_items(p_workshop, p_horizon_days) i
     group by i.bucket
  )
  select b.bucket, b.ordinal, b.from_date, b.to_date,
         coalesce(a.ins, 0)::bigint,
         coalesce(a.outs, 0)::bigint,
         (coalesce(a.ins, 0) - coalesce(a.outs, 0))::bigint,
         sum(coalesce(a.ins, 0) - coalesce(a.outs, 0))
           over (order by b.ordinal rows between unbounded preceding and current row)::bigint,
         coalesce(a.n, 0)::int
    from bounds b
    left join agg a on a.bucket = b.bucket
   order by b.ordinal;
$$;

-- ── PostgREST wrappers + least privilege (0205/0413/0460 pattern) ────────────
-- The column lists are restated rather than referenced: a function's RETURNS TABLE is not
-- a named composite type, so `returns setof app.partner_cashflow` does not exist.
create or replace function public.partner_cashflow(p_workshop uuid, p_horizon_days int default 90)
returns table (
  bucket text, ordinal int, from_date date, to_date date,
  in_cents bigint, out_cents bigint, net_cents bigint, running_cents bigint, item_count int
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_cashflow(p_workshop, p_horizon_days);
$$;

create or replace function public.partner_cashflow_items(p_workshop uuid, p_horizon_days int default 90)
returns table (
  bucket text, ordinal int, direction text, source text, ref text, party text,
  expected_date date, days_late int, amount_cents bigint, source_id uuid
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_cashflow_items(p_workshop, p_horizon_days);
$$;

-- app.* is helper-only; the public wrappers are the API. Both are SECURITY INVOKER, so a
-- rival workshop passing somebody else's id is answered by RLS on the underlying tables —
-- returning zeros — rather than by a workshop check written in the body, which would be a
-- second and weaker copy of a rule the database already enforces.
--
-- The revokes are not optional tidying: a function created with no explicit grant defaults
-- to EXECUTE TO PUBLIC, which is how `app.stock_needs_reorder` shipped and how
-- `public._f14_probe` survived on production (0440). G11 fails the suite for it.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.partner_cashflow(uuid,int)', 'app.partner_cashflow_items(uuid,int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.partner_cashflow(uuid,int)', 'public.partner_cashflow_items(uuid,int)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
