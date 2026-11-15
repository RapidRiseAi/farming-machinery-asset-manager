-- 20261115130000_billing_invoice_uniqueness.sql
-- One invoice per customer, per period, per kind of charge (BRIEF section 15, payment
-- integrity; requirement R-083; scenario 10).
--
-- What already held: a PERIOD invoice is unique on (farm, period_start, period_end)
-- (billing_invoices_farm_period_uq); a PRORATION on (farm, period, plan moved to)
-- (billing_invoices_proration_uq); a CHANGE invoice belongs to exactly one quote
-- (billing_change_quotes_invoice_uq, 20261115110000), and one quote at a time waits for its
-- payment per subscription (billing_change_quotes_awaiting_uq). What did not: an AI-ONLY
-- invoice was kept to one a day by a check inside the generator, so two runs racing (a manual
-- "raise it now" beside the nightly run) could each raise the same month. This makes it the
-- database's rule.
--
-- Safe on live data: the index is created only when no two live AI-only invoices already share
-- a customer and period; if any do, nothing changes and the migration says so (a person
-- reconciles them, then reruns it). Issued invoices are never edited or removed here.

do $$
begin
  if exists (
    select 1 from public.billing_invoices
     where kind = 'ai_usage' and deleted_at is null and status <> 'void'
     group by farm_id, period_start, period_end
    having count(*) > 1
  ) then
    raise notice 'billing_invoices_ai_usage_uq NOT created: live AI-only invoices share a customer and period; reconcile them first';
  else
    create unique index if not exists billing_invoices_ai_usage_uq
      on public.billing_invoices (farm_id, period_start, period_end)
      where deleted_at is null and status <> 'void' and kind = 'ai_usage';
  end if;
end
$$;
comment on column public.billing_invoices.kind is
  'period (one per customer and period, billing_invoices_farm_period_uq); proration (one per '
  'period and plan moved to); slots (the old additions); ai_usage (one per customer and period, '
  'billing_invoices_ai_usage_uq, 20261115130000); service (once-off); change (one per accepted '
  'quote, 20261115110000).';
