-- 0431_vat_return.sql
-- What a VAT-registered partner has to hand SARS every two months.
--
-- This is the gap that most directly stops somebody using the system: they can raise a
-- perfect invoice here, and then at filing time have no way to total the VAT on it for a
-- period. So they export to a spreadsheet, and once the numbers live in the spreadsheet
-- the spreadsheet becomes the books.
--
-- ── What it is, precisely ────────────────────────────────────────────────────
--
-- OUTPUT VAT — VAT charged to customers. Taken from the documents, at the TIME OF SUPPLY,
-- which for an invoice is its issue date (VAT Act s9(1)) — NOT when it was paid. A
-- partner on the invoice basis (which nearly all are; the payments basis is limited to
-- small non-corporate vendors) owes the VAT on an invoice in the period it was issued,
-- even if the customer has not paid. Getting this wrong is the classic small-business
-- error, so the function is explicit about it and the screen says it in words.
--
--   invoice     adds
--   debit note  adds       (it increased the charge)
--   credit note SUBTRACTS  (s21 — the adjustment belongs in the period the note is issued)
--   quote       never, and neither does a draft or a voided document
--
-- A WRITTEN-OFF invoice still counts. The supply happened and the VAT was declared; bad
-- debt relief is a separate claim (s22) with its own conditions, and pretending the sale
-- never happened would be wrong. The screen shows written-off invoices separately so the
-- partner can raise that claim knowingly rather than have this quietly do it for them.
--
-- INPUT VAT — VAT paid to suppliers, from `partner_expenses` (0430), excluding anything
-- flagged not claimable (s17(2): entertainment, passenger vehicles, club fees).
--
-- NET — output minus input. Positive is payable to SARS; negative is refundable.
--
-- SECURITY INVOKER, so RLS decides whose numbers these are: `partner_documents` is scoped
-- by `app.partner_doc_visible` and `partner_expenses` to the owning workshop. A partner
-- passing another workshop's id gets zeroes, not somebody else's return.

-- Which two months are a period depends on the category the vendor was registered under.
-- Category A ends on odd months, B on even ones; C is monthly. Offering the real periods
-- rather than a free date range is what stops a return being built over a window that
-- double-counts one month and omits another. Editable by the partner (0380's
-- `workshops_upd_self`), which already covers their own business profile.
alter table workshops
  add column vat_category text not null default 'A'
    check (vat_category in ('A', 'B', 'monthly'));

comment on column workshops.vat_category is
  'SARS VAT period category: A (two-monthly ending Jan/Mar/…), B (ending Feb/Apr/…) or '
  'monthly. Decides which windows the VAT screen offers.';

create or replace function app.partner_vat_return(
  p_workshop uuid,
  p_from     date,
  p_to       date
) returns table (
  -- Sales
  standard_ex_cents   bigint,   -- ex-VAT value of standard-rated supplies
  standard_vat_cents  bigint,   -- the output VAT on them
  zero_rated_cents    bigint,   -- ex-VAT value of anything issued at 0%
  credits_ex_cents    bigint,   -- ex-VAT value of credit notes (already netted above)
  output_vat_cents    bigint,
  -- Purchases
  input_ex_cents      bigint,
  input_vat_cents     bigint,
  blocked_vat_cents   bigint,   -- VAT paid but NOT claimable, shown so it is not a mystery
  -- The answer
  net_vat_cents       bigint,   -- positive = pay SARS, negative = claim back
  -- Context a partner needs to trust the number
  written_off_ex_cents  bigint, -- declared here, possibly claimable under s22
  written_off_vat_cents bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with sales as (
    select d.kind,
           d.status,
           d.vat_rate_bps,
           -- The signed, ex-VAT value of the supply. A credit note reverses it.
           case when d.kind = 'credit_note' then -1 else 1 end
             * greatest(0, d.subtotal_cents - least(d.discount_cents, d.subtotal_cents)) as net_cents,
           case when d.kind = 'credit_note' then -1 else 1 end * d.vat_cents as vat_cents
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       -- Issued, in any sense that means the customer was told what they owe. A draft was
       -- never a supply; a void document is one that never should have been.
       and d.status in ('sent', 'part_paid', 'paid', 'written_off')
       and d.issue_date between p_from and p_to
  ),
  purchases as (
    select e.amount_cents, e.vat_cents, e.vat_claimable
      from partner_expenses e
     where e.workshop_id = p_workshop
       and e.deleted_at is null
       and e.expense_date between p_from and p_to
  )
  select
    coalesce((select sum(net_cents) from sales where vat_rate_bps > 0 and kind <> 'credit_note'), 0)::bigint,
    coalesce((select sum(vat_cents) from sales), 0)::bigint,
    coalesce((select sum(net_cents) from sales where vat_rate_bps = 0 and kind <> 'credit_note'), 0)::bigint,
    coalesce((select -sum(net_cents) from sales where kind = 'credit_note'), 0)::bigint,
    coalesce((select sum(vat_cents) from sales), 0)::bigint,
    coalesce((select sum(amount_cents) from purchases where vat_claimable), 0)::bigint,
    coalesce((select sum(vat_cents)    from purchases where vat_claimable), 0)::bigint,
    coalesce((select sum(vat_cents)    from purchases where not vat_claimable), 0)::bigint,
    (coalesce((select sum(vat_cents) from sales), 0)
     - coalesce((select sum(vat_cents) from purchases where vat_claimable), 0))::bigint,
    coalesce((select sum(net_cents) from sales where status = 'written_off'), 0)::bigint,
    coalesce((select sum(vat_cents) from sales where status = 'written_off'), 0)::bigint;
$$;

comment on function app.partner_vat_return(uuid, date, date) is
  'Output VAT less input VAT for a period, on the INVOICE basis (time of supply = issue '
  'date, VAT Act s9(1)) — not when the money moved. SECURITY INVOKER: RLS decides whose '
  'numbers these are.';

create or replace function public.partner_vat_return(p_workshop uuid, p_from date, p_to date)
returns table (
  standard_ex_cents bigint, standard_vat_cents bigint, zero_rated_cents bigint,
  credits_ex_cents bigint, output_vat_cents bigint,
  input_ex_cents bigint, input_vat_cents bigint, blocked_vat_cents bigint,
  net_vat_cents bigint, written_off_ex_cents bigint, written_off_vat_cents bigint
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_vat_return(p_workshop, p_from, p_to);
$$;

-- Revoked from PUBLIC (which is what `anon` inherits) and granted back explicitly, the
-- same shape as `app.partner_statement` in 0413. SECURITY INVOKER means RLS still decides
-- whose rows are summed, so the grant is about who may ask, not what they get.
revoke execute on function app.partner_vat_return(uuid, date, date)    from public, anon;
revoke execute on function public.partner_vat_return(uuid, date, date) from public, anon;
grant  execute on function app.partner_vat_return(uuid, date, date)    to authenticated, service_role;
grant  execute on function public.partner_vat_return(uuid, date, date) to authenticated, service_role;
