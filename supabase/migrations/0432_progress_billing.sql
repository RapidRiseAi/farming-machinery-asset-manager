-- 0432_progress_billing.sql
-- Billing a job in more than one go: a deposit up front, stages as work proceeds, the
-- balance at the end.
--
-- ── Why this is one feature and not two ──────────────────────────────────────
--
-- A deposit and a progress payment look like different things to a business owner and are
-- the same thing to a ledger: an invoice for PART of an agreed job, raised before the
-- whole job is delivered. Modelling them separately is how systems end up with a deposit
-- that is not really an invoice, does not appear on a statement, carries no VAT, and has
-- to be reconciled by hand at the end. So there is one mechanism:
--
--   MANY INVOICES MAY POINT AT ONE QUOTE, and the quote knows how much of it has been
--   billed so far.
--
-- Nothing new is needed to make that legal — `partner_documents.quote_id` (0381) already
-- exists and was never unique. What was missing is the arithmetic that keeps it honest,
-- and a way to say what each invoice IS: a deposit, a stage, or the final balance.
--
-- ── The no-double-billing rule ───────────────────────────────────────────────
--
-- Each progress invoice carries its OWN lines and is costed by the existing 0418 trigger
-- like any other invoice. There is no netting, no deduction field, no "less deposit
-- previously invoiced" line to get wrong: three invoices of R5 000 against a R15 000
-- quote put exactly R15 000 into the farm's cost ledger, and every one of them appears on
-- the statement in its own right. That is the whole reason for choosing this shape.
--
-- Billing MORE than was quoted is allowed and flagged, not refused. Jobs grow; a gearbox
-- comes apart and needs a part nobody priced. Refusing the invoice would just push the
-- partner outside the system, which is worse than showing them a number in orange.

create type partner_billing_stage as enum ('deposit', 'progress', 'final');

alter table partner_documents
  add column billing_stage partner_billing_stage,
  -- What this invoice was FOR, in the partner's words, when it is part of a bigger job:
  -- "50% deposit", "second cut", "on completion". Printed under the document title.
  add column stage_label text;

comment on column partner_documents.billing_stage is
  'Set when this invoice bills PART of a quote (0432). deposit = up front, progress = a '
  'stage, final = the balance. Each such invoice carries its own lines and its own cost '
  'entry — there is no netting, so parts of a job can never double-count.';

-- Only an invoice pointing at a quote can be a stage of anything.
alter table partner_documents
  add constraint partner_documents_stage_ck check (
    billing_stage is null or (kind = 'invoice' and quote_id is not null)
  );

create index partner_documents_quote_idx on partner_documents(quote_id)
  where quote_id is not null and deleted_at is null;

-- ── How much of a quote has been billed ──────────────────────────────────────
-- SECURITY INVOKER: the caller sees exactly the invoices RLS lets them see, which is the
-- correct answer for both sides — the partner sees their own billing against their own
-- quote, and the farmer sees what they have actually been sent.
--
-- Drafts count as NOT yet billed. A draft has not left the building, so treating it as
-- billed would tell a partner they had invoiced money they have not asked for. Voided and
-- cancelled invoices likewise.
create or replace function app.quote_billing(p_quote uuid)
returns table (
  quoted_cents    bigint,   -- what the quote came to, VAT inclusive
  billed_cents    bigint,   -- issued so far against it
  draft_cents     bigint,   -- sitting in a draft, not yet sent
  remaining_cents bigint,   -- quoted − billed, floored at zero
  over_billed     boolean,  -- billed MORE than quoted: allowed, but say so
  invoice_count   int
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with q as (
    select total_cents from partner_documents
     where id = p_quote and kind = 'quote' and deleted_at is null
  ),
  billed as (
    select
      coalesce(sum(total_cents) filter (
        where status in ('sent', 'part_paid', 'paid', 'written_off')), 0) as issued,
      coalesce(sum(total_cents) filter (where status = 'draft'), 0)       as drafted,
      count(*) filter (where status <> 'draft')                           as n
      from partner_documents
     where quote_id = p_quote and kind = 'invoice' and deleted_at is null
       and status not in ('void', 'cancelled')
  )
  select
    coalesce((select total_cents from q), 0)::bigint,
    b.issued::bigint,
    b.drafted::bigint,
    greatest(coalesce((select total_cents from q), 0) - b.issued, 0)::bigint,
    b.issued > coalesce((select total_cents from q), 0),
    b.n::int
  from billed b;
$$;

create or replace function public.quote_billing(p_quote uuid)
returns table (
  quoted_cents bigint, billed_cents bigint, draft_cents bigint,
  remaining_cents bigint, over_billed boolean, invoice_count int
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.quote_billing(p_quote);
$$;

revoke execute on function app.quote_billing(uuid)    from public, anon;
revoke execute on function public.quote_billing(uuid) from public, anon;
grant  execute on function app.quote_billing(uuid)    to authenticated, service_role;
grant  execute on function public.quote_billing(uuid) to authenticated, service_role;

comment on function app.quote_billing(uuid) is
  'How much of a quote has been invoiced, across every progress invoice raised against '
  'it. Drafts are reported separately because a draft has not been asked for yet.';
