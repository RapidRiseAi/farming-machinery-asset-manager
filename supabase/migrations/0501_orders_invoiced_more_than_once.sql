-- 0501_orders_invoiced_more_than_once.sql
-- A supplier who part-ships may invoice twice, and the order has to survive it.
--
-- 0475 gave `partner_expenses.purchase_order_id` a PARTIAL UNIQUE INDEX, so exactly one
-- live expense could ever point at an order. That was the right call at the time: it made a
-- double-count structurally impossible while the conversion was new, and the handover
-- recorded it as a deliberate limitation.
--
-- It is now the limitation that bites. A parts supplier ships six of ten filters, invoices
-- for six, sends the rest a fortnight later and invoices again. Under 0475 the second
-- invoice cannot be linked at all: the partner either edits the first expense (making their
-- own books disagree with two real supplier documents, each of which SARS may ask about) or
-- captures the second with no link to the order, which silently breaks the commitment
-- figure the cash-flow forecast reads.
--
-- ── What still must not happen ───────────────────────────────────────────────
--
-- The no-double-count rule is unchanged and is what the index was protecting. It survives
-- because of WHERE the cost lives, not because of the index: a purchase order books
-- NOTHING (0473/0474 contain no path to cost_entries or partner_expenses at all — verified
-- by reading, not by trusting), and each supplier invoice books its own cost exactly once
-- as an ordinary `partner_expenses` row. Two invoices against one order are therefore two
-- costs because two real bills arrived, which is correct. G24 asserts this against a ledger
-- snapshot taken before the order exists, because the direction that catches a double-count
-- is the one proving the cost is NOT there yet.
--
-- ── Over-invoicing is flagged, never refused ─────────────────────────────────
--
-- The same call `app.quote_billing` made for progress billing, and for the same reason:
-- jobs grow. A supplier may legitimately bill more than the order said — a price rose, an
-- extra part went in, freight was added. Refusing the capture would leave the partner
-- unable to record a bill they have actually received, which is worse than showing them a
-- number that does not match.
--
-- ── The index is MOVED, not removed ──────────────────────────────────────────
--
-- 0475's index was doing a second job that matters and must not be lost. Its own comment
-- said it: "two people in the office capturing the same invoice, a double-submitted form and
-- a retried request are all this same race, and it is refused by a unique index rather than
-- by a read-then-write in application code." Simply dropping it would let a double-submit
-- create two identical expenses — a real double-count, of exactly the kind this codebase
-- refuses to leave to application logic. The isolation suite caught this: G16 asserted the
-- old invariant and failed, which is the suite doing its job.
--
-- So uniqueness moves to the NATURAL key of a purchase: the supplier's own invoice number.
-- Two DIFFERENT bills against one order are then fine, while the SAME bill twice is refused
-- by the database. Supplier is part of the key because two suppliers may both number an
-- invoice "INV-001"; it is resolved the way 0482 groups creditors — by the linked record
-- where there is one, and by the trimmed lower-cased name where there is not.
--
-- A bill with NO number (a till slip) gets no protection, and that is deliberate rather than
-- overlooked: the alternative is refusing to record a purchase that genuinely has no
-- reference, which is the same "warn, never block" call 0430 made for receipts.
-- Verified against production before adding: zero existing rows would collide.

drop index if exists partner_expenses_po_uq;

-- Kept as a plain index: the lookups (an order's expenses, the forecast's remainder) all
-- filter on this column and were relying on the unique index to serve them.
create index if not exists partner_expenses_po_idx on partner_expenses (purchase_order_id)
  where purchase_order_id is not null and deleted_at is null;

create unique index if not exists partner_expenses_supplier_ref_uq
  on partner_expenses (
    workshop_id,
    coalesce(supplier_id::text, lower(btrim(coalesce(supplier_name, '')))),
    lower(btrim(reference))
  )
  where nullif(btrim(coalesce(reference, '')), '') is not null and deleted_at is null;

comment on index partner_expenses_supplier_ref_uq is
  'The same supplier invoice cannot be captured twice (0501, inheriting the race protection '
  '0475 attached to the order). Partial on a present reference and a live row: a bill with '
  'no number is allowed through unguarded, and a soft-deleted capture frees its number.';

comment on column partner_expenses.purchase_order_id is
  'The order this supplier invoice settles part or all of (0475, relaxed in 0501). MANY '
  'expenses may point at one order: a supplier who part-ships invoices more than once. The '
  'order itself books no cost - each expense books its own, exactly once - so several '
  'invoices against one order are several costs because several bills arrived.';

-- ── How much of an order has actually been invoiced ──────────────────────────
-- Mirrors `app.quote_billing`'s shape so the two read the same way: what was committed,
-- what has been billed against it, what is left, and whether it has gone over.
create or replace function app.purchase_order_invoiced(p_order uuid)
returns table (
  ordered_cents   bigint,
  invoiced_cents  bigint,
  remaining_cents bigint,
  invoice_count   int,
  over_cents      bigint,
  fully_invoiced  boolean
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with o as (
    select po.id, po.total_cents
      from purchase_orders po
     where po.id = p_order
       and po.deleted_at is null
  ),
  billed as (
    -- GROSS, to compare like with like: purchase_orders.total_cents includes VAT, and a
    -- supplier invoice is captured ex-VAT plus the VAT they actually charged.
    select coalesce(sum(e.amount_cents + e.vat_cents), 0)::bigint as amount,
           count(*)::int                                          as n
      from partner_expenses e, o
     where e.purchase_order_id = o.id
       and e.deleted_at is null
  )
  select o.total_cents,
         b.amount,
         greatest(o.total_cents - b.amount, 0)::bigint,
         b.n,
         greatest(b.amount - o.total_cents, 0)::bigint,
         (b.amount >= o.total_cents and o.total_cents > 0)
    from o cross join billed b;
$$;

comment on function app.purchase_order_invoiced(uuid) is
  'What has been billed against a purchase order across ALL its supplier invoices (0501). '
  'Gross both sides - an order total includes VAT and an expense carries the VAT the '
  'supplier charged. Over-invoicing is reported, not refused: jobs grow (see the header).';

create or replace function public.purchase_order_invoiced(p_order uuid)
returns table (
  ordered_cents bigint, invoiced_cents bigint, remaining_cents bigint,
  invoice_count int, over_cents bigint, fully_invoiced boolean
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.purchase_order_invoiced(p_order);
$$;

revoke execute on function app.purchase_order_invoiced(uuid)    from public, anon;
revoke execute on function public.purchase_order_invoiced(uuid) from public, anon;
grant execute on function app.purchase_order_invoiced(uuid)    to authenticated, service_role;
grant execute on function public.purchase_order_invoiced(uuid) to authenticated, service_role;

-- ── The forecast now carries what is still UNBILLED, not all-or-nothing ─────
--
-- 0486 dropped a purchase order from the cash-flow forecast the moment any expense linked
-- to it, because under 0475 only one ever could. With part-invoicing allowed that would
-- understate the outflow by the uninvoiced remainder of every part-billed order, so the
-- order arm now forecasts the remainder and a fully-billed order falls out on its own.
--
-- Restated in full rather than patched, because a function body cannot be edited in place;
-- everything except the purchase-order arm is 0491 verbatim.
create or replace function app.partner_cashflow_items(p_workshop uuid, p_horizon_days int default 90)
returns table (
  bucket text, ordinal int, direction text, source text, ref text, party text,
  expected_date date, days_late int, amount_cents bigint, source_id uuid
)
language sql stable security invoker set search_path = public, pg_temp as $fn$
  with edges as (
    select
      current_date as today,
      (date_trunc('week', current_date)::date + 6) as wk_end,
      (date_trunc('week', current_date)::date + 13) as nxt_end,
      (date_trunc('month', current_date)::date + interval '1 month - 1 day')::date as mo_end,
      current_date + greatest(coalesce(p_horizon_days, 90), 0) as horizon,
      30 as supplier_terms_days
  ),
  inv as (
    select d.id,
      coalesce(nullif(btrim(d.number), ''), '-') as ref,
      coalesce(nullif(btrim(d.bill_to_name), ''), '-') as party,
      coalesce(d.due_date, d.issue_date) as due,
      d.total_cents
        - coalesce((select sum(p.amount_cents) from partner_payments p
                     where p.document_id = d.id and p.deleted_at is null
                       and p.paid_on <= e.today), 0)
        - coalesce((select sum(c.total_cents) from partner_documents c
                     where c.corrects_document_id = d.id and c.kind = 'credit_note'
                       and c.deleted_at is null
                       and c.status not in ('draft', 'void', 'cancelled')
                       and c.issue_date <= e.today), 0) as outstanding
      from partner_documents d
      cross join edges e
     where d.workshop_id = p_workshop
       and d.kind = 'invoice'
       and d.deleted_at is null
       and d.status not in ('draft', 'void', 'cancelled', 'written_off')
       and (coalesce(d.due_date, d.issue_date) < e.today
            or coalesce(d.due_date, d.issue_date) <= e.horizon)
  ),
  rec as (
    select ri.id,
      coalesce(nullif(btrim(ri.name), ''), '-') as ref,
      coalesce(nullif(btrim(ri.bill_to_name), ''), nullif(btrim(ri.name), ''), '-') as party,
      (ri.next_issue_date + w.invoice_terms_days) as due,
      (l.net + round(l.net * ri.vat_rate_bps / 10000.0)::bigint) as gross
      from recurring_invoices ri
      join workshops w on w.id = ri.workshop_id
      cross join edges e
      cross join lateral (
        select greatest(0, sub - least(coalesce(ri.discount_cents, 0), sub)) as net
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
       and (ri.last_period_start is null or ri.next_issue_date > ri.last_period_start)
       and l.net > 0
  ),
  exp as (
    -- THE CHANGE: this supplier's own terms where the partner has filed them, the flat
    -- assumption where they have not. A left join, because an expense whose supplier is
    -- not on the book is the ordinary case and must not drop out of the forecast.
    select x.id,
      coalesce(nullif(btrim(x.reference), ''), '-') as ref,
      coalesce(nullif(btrim(x.supplier_name), ''), '-') as party,
      (x.expense_date + coalesce(s.payment_terms_days, e.supplier_terms_days)) as due,
      (x.amount_cents + x.vat_cents) as gross
      from partner_expenses x
      cross join edges e
      left join suppliers s
        on s.id = x.supplier_id
       and s.workshop_id = x.workshop_id
       and s.deleted_at is null
     where x.workshop_id = p_workshop
       and x.deleted_at is null
       and x.paid_on is null
       and (x.expense_date + coalesce(s.payment_terms_days, e.supplier_terms_days) < e.today
            or x.expense_date + coalesce(s.payment_terms_days, e.supplier_terms_days) <= e.horizon)
  ),
  po as (
    select o.id,
      coalesce(nullif(btrim(o.reference), ''), o.supplier_name) as ref,
      coalesce(nullif(btrim(o.supplier_name), ''), '-') as party,
      (o.expected_date + e.supplier_terms_days) as due,
      -- What is still UNBILLED on this order. 0501 lets a supplier who part-ships
      -- invoice more than once, so an order is no longer all-or-nothing here: the arrived
      -- invoices are forecast as expenses in their own right (the `exp` arm above), and
      -- what remains committed is the order less what has been billed against it.
      --
      -- Before 0501 this arm dropped the whole order the moment ANY expense linked to it,
      -- which was right when only one ever could. Left alone it would now understate the
      -- outflow by the uninvoiced remainder of every part-billed order.
      greatest(o.total_cents - coalesce((
        select sum(px.amount_cents + px.vat_cents) from partner_expenses px
         where px.purchase_order_id = o.id and px.deleted_at is null), 0), 0) as gross
      from purchase_orders o
      cross join edges e
     where o.workshop_id = p_workshop
       and o.deleted_at is null
       and o.status in ('sent', 'part_received')
       and o.expected_date is not null
       and o.expected_date <= e.horizon
       and o.total_cents > 0
  ),
  moves as (
    select 'in'::text as direction, 'invoice'::text as source, ref, party, due, outstanding as amount, id from inv
     where outstanding > 0
    union all
    select 'in',  'recurring',      ref, party, due, gross, id from rec
    union all
    select 'out', 'expense',        ref, party, due, gross, id from exp
    union all
    select 'out', 'purchase_order', ref, party, due, gross, id from po
     where gross > 0
  )
  select
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
   order by 2, 7, 9 desc;
$fn$;

comment on function app.partner_cashflow_items(uuid, int) is
  'Every expected cash movement in the horizon (G20). A supplier bill is expected on that '
  'supplier''s own payment_terms_days where the partner has filed them (0480), and 30 days '
  'from the invoice date where they have not - stated on screen either way, because one is '
  'a fact and the other is an assumption.';

