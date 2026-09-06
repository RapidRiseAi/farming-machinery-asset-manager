-- 20260904120000_saas_billing_launch_prices.sql
-- The confirmed launch price list.
--
-- THE CONFLICT IS RESOLVED. `20260903160000` shipped `billing_price_versions` EMPTY
-- because two sources disagreed:
--
--     docs/FLEETWISE_FOUNDER_DECISIONS.md #1 : R44 / R73 / R89 / R250
--     src/lib/entitlements.ts (display only) : R39 / R69 / R99 / POA
--
-- The founder has confirmed the FOUNDER DOCUMENT is correct (4 September 2026). These are
-- those prices, and `src/lib/entitlements.ts` is corrected to match in the same change —
-- a screen quoting R39 while the invoice says R44 is worse than either number alone.
--
-- ── This does NOT switch charging on ─────────────────────────────────────────
-- There were two independent locks. This releases the first. The second,
-- `BILLING_CHARGING_ENABLED`, is untouched and still unset, so every code path that
-- would move money continues to return without making a network request. Invoices can
-- now be RAISED; nothing can be CHARGED. That is the intended next state: it lets a full
-- billing cycle be watched on real data before a single rand moves.
--
-- ── Why the VAT rate is 0 on every row ───────────────────────────────────────
-- Rapid Rise is not registered for VAT (founder decision #8), so it may not charge any.
-- `app.billing_force_vat_rate` would force an invoice to 0% regardless of what is written
-- here; setting 0 explicitly means the catalogue and the invoices agree rather than the
-- trigger silently correcting every row.
--
-- The prices are described as VAT-INCLUSIVE, and that stays true: R44 is what the customer
-- pays. While unregistered there is simply no VAT inside it. On registering, the amount
-- the customer pays does not change — only the split does — and because a non-draft price
-- version's money columns are frozen, that is done by RETIRING these rows and inserting a
-- `launch-2026-vat` generation carrying the same prices at 1500 bps. Invoices already
-- issued keep the 0% they were raised under, which is the correct treatment and is
-- asserted in the suite.
--
-- ── Annual ───────────────────────────────────────────────────────────────────
-- Two months free: an annual row carries the SAME per-vehicle monthly price and
-- `months_charged = 10`, so a year costs ten months rather than twelve. The term lives on
-- the row rather than in a constant, so changing the offer later cannot restate history.

insert into billing_price_versions (
  version_label, plan, billing_period,
  per_vehicle_monthly_incl_cents, months_charged, vat_rate_bps,
  status, effective_from, notes
) values
  -- Essential — R44 per vehicle per month
  ('launch-2026', 'essential',    'monthly',  4400,  1, 0, 'active', current_date,
   'Founder decision #1, confirmed 2026-09-04. VAT-inclusive; 0% while unregistered.'),
  ('launch-2026', 'essential',    'annual',   4400, 10, 0, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free.'),

  -- Professional — R73 per vehicle per month
  ('launch-2026', 'professional', 'monthly',  7300,  1, 0, 'active', current_date,
   'Founder decision #1, confirmed 2026-09-04. VAT-inclusive; 0% while unregistered.'),
  ('launch-2026', 'professional', 'annual',   7300, 10, 0, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free.'),

  -- Complete — R89 per vehicle per month
  ('launch-2026', 'complete',     'monthly',  8900,  1, 0, 'active', current_date,
   'Founder decision #1, confirmed 2026-09-04. VAT-inclusive; 0% while unregistered.'),
  ('launch-2026', 'complete',     'annual',   8900, 10, 0, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free.'),

  -- Done-For-You — R250 per vehicle per month.
  -- The founder document gives a real number where entitlements.ts had "price on
  -- application". A number is now on file, so the plan CAN be auto-invoiced like any
  -- other; a farm negotiated off this list gets its own price version rather than a null.
  ('launch-2026', 'done_for_you', 'monthly', 25000,  1, 0, 'active', current_date,
   'Founder decision #1, confirmed 2026-09-04. VAT-inclusive; 0% while unregistered.'),
  ('launch-2026', 'done_for_you', 'annual',  25000, 10, 0, 'active', current_date,
   'Annual pre-pay: 10 months charged, two months free.');

comment on table billing_price_versions is
  'Versioned per-vehicle-per-month price list, VAT-INCLUSIVE cents. The `launch-2026` '
  'generation (R44/R73/R89/R250) was confirmed by the founder on 2026-09-04 and seeded by '
  'migration 20260904120000. A non-draft row''s money columns are frozen: reprice by '
  'retiring a generation and inserting a new one, never by editing these.';
