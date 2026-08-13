-- 0460_money_answers.sql
-- Did this month make money, who owes me, and who do I owe.
--
-- The commercial layer records transactions well and reports on them barely at all. A
-- partner can raise an invoice, correct it, chase it on a statement and file the VAT on
-- it — and still cannot answer the three questions any business actually runs on. This
-- adds no tables: every figure below is an aggregation over `partner_documents`,
-- `partner_payments` and `partner_expenses`, which already exist and are already scoped.
--
-- ── Why SQL rather than the page ────────────────────────────────────────────
--
-- Same reason `partner_statement`, `partner_ageing` and `partner_vat_return` are SQL: the
-- screen, the CSV, the PDF and an emailed copy must not be able to disagree. A figure
-- computed in a React component is a figure that exists in one place only until somebody
-- adds an export.
--
-- ── Why these numbers agree with the VAT return ─────────────────────────────
--
-- The document selection below is copied deliberately from `app.partner_vat_return`:
-- kinds invoice/credit_note/debit_note, statuses sent/part_paid/paid/written_off, by
-- `issue_date`. If the two ever diverge, a partner sees one revenue figure on the VAT
-- screen and a different one on the money screen and trusts neither. Invoice basis
-- throughout, and the screens say so in words.
--
-- ── Three judgements worth stating ──────────────────────────────────────────
--
-- 1. A WRITTEN-OFF invoice is still revenue, and the write-off is a cost. It was earned
--    and declared (G5/G6 keep it in the ledger and on the VAT return); pretending it was
--    never revenue would quietly restate a filed period. So it is counted in revenue and
--    subtracted again as bad debt, which nets correctly and shows the loss instead of
--    hiding it.
-- 2. NON-CLAIMABLE VAT IS A COST. The VAT return excludes it from input VAT, correctly —
--    but the money left the bank. Entertainment and passenger-car VAT belong in the cost
--    of running the business even though SARS will not refund them, and a P&L that
--    dropped them would overstate profit by exactly the amount most likely to be
--    forgotten.
-- 3. Ageing buckets a supplier invoice from ITS OWN DATE, because an expense carries no
--    due date. That is "how long have I been sitting on this", not "how overdue am I" —
--    the screen says which.

-- ── Did this month make money ────────────────────────────────────────────────
create or replace function app.partner_pl(p_workshop uuid, p_from date, p_to date)
returns table (
  revenue_ex_cents    bigint,   -- invoices + debit notes − credit notes, ex-VAT
  bad_debt_ex_cents   bigint,   -- of that revenue, what was written off
  expenses_ex_cents   bigint,   -- everything bought, ex-VAT
  blocked_vat_cents   bigint,   -- VAT paid that cannot be reclaimed — also a cost
  cost_cents          bigint,   -- expenses + blocked VAT
  profit_cents        bigint    -- revenue − bad debt − cost
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with sales as (
    select d.status,
           case when d.kind = 'credit_note' then -1 else 1 end
             * greatest(0, d.subtotal_cents - least(d.discount_cents, d.subtotal_cents)) as net_cents
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('sent', 'part_paid', 'paid', 'written_off')
       and d.issue_date between p_from and p_to
  ),
  purchases as (
    select e.amount_cents, e.vat_cents, e.vat_claimable
      from partner_expenses e
     where e.workshop_id = p_workshop
       and e.deleted_at is null
       and e.expense_date between p_from and p_to
  ),
  n as (
    select
      coalesce((select sum(net_cents) from sales), 0)::bigint                                as revenue,
      coalesce((select sum(net_cents) from sales where status = 'written_off'), 0)::bigint   as bad_debt,
      coalesce((select sum(amount_cents) from purchases), 0)::bigint                         as expenses,
      coalesce((select sum(vat_cents) from purchases where not vat_claimable), 0)::bigint    as blocked
  )
  select revenue, bad_debt, expenses, blocked,
         (expenses + blocked)::bigint,
         (revenue - bad_debt - expenses - blocked)::bigint
    from n;
$$;

-- ── Where the money went ─────────────────────────────────────────────────────
-- Split out rather than folded into the P&L because a total nobody can decompose is a
-- total nobody believes. Sums to `cost_cents` above — asserted in G14.
create or replace function app.partner_expense_breakdown(p_workshop uuid, p_from date, p_to date)
returns table (category partner_expense_category, ex_cents bigint, blocked_vat_cents bigint, cost_cents bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  select e.category,
         coalesce(sum(e.amount_cents), 0)::bigint,
         coalesce(sum(e.vat_cents) filter (where not e.vat_claimable), 0)::bigint,
         (coalesce(sum(e.amount_cents), 0) +
          coalesce(sum(e.vat_cents) filter (where not e.vat_claimable), 0))::bigint
    from partner_expenses e
   where e.workshop_id = p_workshop
     and e.deleted_at is null
     and e.expense_date between p_from and p_to
   group by e.category
   order by 4 desc;
$$;

-- ── Who owes me ──────────────────────────────────────────────────────────────
-- `app.partner_ageing` answers this for ONE customer and matches nothing when given
-- neither — so "who owes me, across everyone" was unanswerable, which is the first
-- question of the week. Same arithmetic, grouped by customer instead of filtered to one.
create or replace function app.partner_debtors(p_workshop uuid, p_as_at date default current_date)
returns table (
  party_label   text,
  farm_id       uuid,
  client_id     uuid,
  current_cents bigint,
  d30_cents     bigint,
  d60_cents     bigint,
  d90_cents     bigint,
  total_cents   bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with invoices as (
    select d.id,
           d.farm_id,
           d.partner_client_id,
           coalesce(nullif(btrim(d.bill_to_name), ''), '—') as label,
           d.total_cents,
           coalesce(d.due_date, d.issue_date) as due,
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
       -- A written-off invoice is no longer chased: it left the ageing on purpose (G5).
       and d.status not in ('draft', 'void', 'cancelled', 'written_off')
       and d.issue_date <= p_as_at
  ),
  outstanding as (
    select label, farm_id, partner_client_id,
           greatest(total_cents - settled, 0) as owed,
           p_as_at - due as days_over
      from invoices
     where total_cents > settled
  )
  select label, farm_id, partner_client_id,
         coalesce(sum(owed) filter (where days_over <= 0), 0)::bigint,
         coalesce(sum(owed) filter (where days_over between 1 and 30), 0)::bigint,
         coalesce(sum(owed) filter (where days_over between 31 and 60), 0)::bigint,
         coalesce(sum(owed) filter (where days_over > 60), 0)::bigint,
         coalesce(sum(owed), 0)::bigint
    from outstanding
   group by label, farm_id, partner_client_id
  having coalesce(sum(owed), 0) > 0
   order by 8 desc;
$$;

-- ── Who I owe ────────────────────────────────────────────────────────────────
-- The mirror, over the purchase side. An expense with no `paid_on` is outstanding; there
-- is no due date on a supplier invoice, so the buckets measure age from the supplier's
-- own invoice date and the screen says so rather than implying lateness.
create or replace function app.partner_creditors(p_workshop uuid, p_as_at date default current_date)
returns table (
  supplier      text,
  current_cents bigint,
  d30_cents     bigint,
  d60_cents     bigint,
  d90_cents     bigint,
  total_cents   bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with unpaid as (
    select coalesce(nullif(btrim(e.supplier_name), ''), '—') as supplier,
           (e.amount_cents + e.vat_cents) as owed,     -- what actually leaves the bank
           p_as_at - e.expense_date as age
      from partner_expenses e
     where e.workshop_id = p_workshop
       and e.deleted_at is null
       and e.paid_on is null
       and e.expense_date <= p_as_at
  )
  select supplier,
         coalesce(sum(owed) filter (where age <= 30), 0)::bigint,
         coalesce(sum(owed) filter (where age between 31 and 60), 0)::bigint,
         coalesce(sum(owed) filter (where age between 61 and 90), 0)::bigint,
         coalesce(sum(owed) filter (where age > 90), 0)::bigint,
         coalesce(sum(owed), 0)::bigint
    from unpaid
   group by supplier
  having coalesce(sum(owed), 0) > 0
   order by 6 desc;
$$;

-- ── What actually moved ──────────────────────────────────────────────────────
-- Profit is not cash. This is the other half: money that arrived and money that left in
-- the period, on a CASH basis, which is why a profitable month can still be a tight one.
create or replace function app.partner_cash(p_workshop uuid, p_from date, p_to date)
returns table (in_cents bigint, out_cents bigint, net_cents bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  with received as (
    -- Refunds are negative payments (0422), so summing gives net cash in without a
    -- special case.
    select coalesce(sum(p.amount_cents), 0)::bigint as c
      from partner_payments p
      join partner_documents d on d.id = p.document_id
     where d.workshop_id = p_workshop
       and p.deleted_at is null and d.deleted_at is null
       and p.paid_on between p_from and p_to
  ),
  spent as (
    select coalesce(sum(e.amount_cents + e.vat_cents), 0)::bigint as c
      from partner_expenses e
     where e.workshop_id = p_workshop
       and e.deleted_at is null
       and e.paid_on between p_from and p_to
  )
  select (select c from received), (select c from spent),
         ((select c from received) - (select c from spent))::bigint;
$$;

-- ── PostgREST wrappers + least privilege (0205/0413 pattern) ─────────────────
-- The column lists are restated rather than referenced: a function's RETURNS TABLE is not
-- a named composite type, so `returns setof app.partner_pl` does not exist. Same shape as
-- the 0413 wrappers.
create or replace function public.partner_pl(p_workshop uuid, p_from date, p_to date)
returns table (
  revenue_ex_cents bigint, bad_debt_ex_cents bigint, expenses_ex_cents bigint,
  blocked_vat_cents bigint, cost_cents bigint, profit_cents bigint
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_pl(p_workshop, p_from, p_to);
$$;

create or replace function public.partner_expense_breakdown(p_workshop uuid, p_from date, p_to date)
returns table (
  category partner_expense_category, ex_cents bigint, blocked_vat_cents bigint, cost_cents bigint
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_expense_breakdown(p_workshop, p_from, p_to);
$$;

create or replace function public.partner_debtors(p_workshop uuid, p_as_at date default current_date)
returns table (
  party_label text, farm_id uuid, client_id uuid,
  current_cents bigint, d30_cents bigint, d60_cents bigint, d90_cents bigint, total_cents bigint
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_debtors(p_workshop, p_as_at);
$$;

create or replace function public.partner_creditors(p_workshop uuid, p_as_at date default current_date)
returns table (
  supplier text, current_cents bigint, d30_cents bigint, d60_cents bigint, d90_cents bigint, total_cents bigint
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_creditors(p_workshop, p_as_at);
$$;

create or replace function public.partner_cash(p_workshop uuid, p_from date, p_to date)
returns table (in_cents bigint, out_cents bigint, net_cents bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_cash(p_workshop, p_from, p_to);
$$;

-- app.* is helper-only; the public wrappers are the API. Every one of these is
-- SECURITY INVOKER, so passing another workshop's id returns nothing rather than
-- somebody else's books — RLS on the underlying tables is what decides, exactly as it
-- does for partner_statement and partner_ageing.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.partner_pl(uuid,date,date)', 'app.partner_expense_breakdown(uuid,date,date)',
    'app.partner_debtors(uuid,date)', 'app.partner_creditors(uuid,date)',
    'app.partner_cash(uuid,date,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
  foreach f in array array[
    'public.partner_pl(uuid,date,date)', 'public.partner_expense_breakdown(uuid,date,date)',
    'public.partner_debtors(uuid,date)', 'public.partner_creditors(uuid,date)',
    'public.partner_cash(uuid,date,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
