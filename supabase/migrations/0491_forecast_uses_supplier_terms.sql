-- 0491_forecast_uses_supplier_terms.sql
-- The forecast asks every supplier to be paid in 30 days, including the ones the partner
-- told us are 60.
--
-- 0480 gives a supplier record `payment_terms_days`, and the /suppliers screen asks for it
-- and stores it. 0486's forecast then ignores it and assumes 30 for everybody. So a
-- partner can file "Bearing Co, 60 days", read a cash-flow that says the money leaves in
-- 30, and plan around a number the product already knew was wrong. Captured-but-unused
-- settings are worse than absent ones: they buy trust the output has not earned.
--
-- The sales side already does this properly — `partner_clients.payment_terms_days` sets a
-- document's due date when an invoice is raised. This is the purchase-side half of the
-- same idea, and it closes the asymmetry.
--
-- 30 days stays as the fallback and is still stated on screen, because most supplier
-- invoices carry no terms at all and a forecast has to assume something; the difference is
-- that it is now only an assumption where the partner has not told us otherwise.
--
-- Only the `exp` branch changes. Purchase orders keep the flat assumption on purpose: an
-- order that has not been invoiced yet has no supplier invoice date to count from, so the
-- terms would be applied to the wrong event.

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
      o.total_cents as gross
      from purchase_orders o
      cross join edges e
     where o.workshop_id = p_workshop
       and o.deleted_at is null
       and o.status in ('sent', 'part_received')
       and o.expected_date is not null
       and o.expected_date <= e.horizon
       and o.total_cents > 0
       and not exists (
         select 1 from partner_expenses px
          where px.purchase_order_id = o.id and px.deleted_at is null)
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
