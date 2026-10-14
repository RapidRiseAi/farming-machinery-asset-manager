-- 20261013130000_billing_settings_columns.sql
-- Farm users read the seller's details and the billing terms, not the platform's AI pricing.
--
-- billing_settings is the single row behind every invoice: Rapid Rise's legal name, VAT
-- number and address, and the billing policy (trial, grace, retries, downgrade). Its read
-- policy is `using (true)` with table-wide SELECT, so every signed-in user, operators and
-- partners included, could also read the AI margin, the AI spending limits, the fallback
-- exchange rate, when AI billing starts, the smallest AI invoice and who last edited the row.
--
-- Now granted column by column. What a customer's own /billing page and invoices show stays
-- readable; the rest is read only by Rapid Rise's own pages, through the service client after
-- their role check, and by the billing and AI functions, every one of which runs as its owner
-- (checked on production before this was written), so none of them is affected. Rapid Rise
-- still updates the row through its policy; an update needs no SELECT on the columns it sets.
-- A column added to the table later is hidden from farm users until it is granted here.

revoke select on public.billing_settings from authenticated;

grant select (
  id, singleton, legal_name, trading_name, reg_number, vat_registered, vat_number,
  vat_rate_bps, billing_address, billing_email, support_email, trial_days, retry_offsets_days,
  grace_days, downgrade_to_plan, cancel_at_period_end, prorate_annual_additions,
  payment_terms_days, updated_at, grace_retry_days, lapsed_grace_days,
  renewal_notice_days_monthly, renewal_notice_days_annual
) on public.billing_settings to authenticated;
