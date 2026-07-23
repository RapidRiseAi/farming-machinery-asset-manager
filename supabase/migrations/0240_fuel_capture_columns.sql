-- 0240_fuel_capture_columns.sql
-- Fuel module (F4 · FR-6.1/6.2/6.3, §23 fuel metrics). The tank / delivery / issue
-- tables were created dormant in 0007; this migration adds the columns the capture UI
-- (app + QR "log fuel") needs so we can record a fill (delivery) and a per-machine draw
-- (issue) with litres, COST, date, meter, operator/driver and activity.
--
-- Money stays integer cents, ex-VAT (Scope §6). RLS, the FORCE-RLS farm-scoped policies
-- (0101), grants (0102) and the append-only audit trigger (0008) already cover all three
-- fuel tables; adding columns does not change any of that — audit captures the whole row
-- via to_jsonb, so the new fields are audited automatically.

-- ── Deliveries: capture the VAT rate and who recorded the fill ────
-- (litres, price_per_l_cents, date, supplier, invoice_no, doc_url already exist in 0007.)
alter table fuel_deliveries
  add column if not exists vat_rate_bps int,                     -- VAT rate captured (bps; 1500 = 15%)
  add column if not exists by_user      uuid references users(id);

-- ── Issues (per-machine draws): capture cost + a free-text driver ──
-- litres, meter_reading, activity, by_user, date, machine_id already exist in 0007.
--   * cost_cents        — ex-VAT total cost of THIS draw. This is the authoritative
--                         per-machine fuel cost that flows into cost_entries/TCO (0241).
--   * price_per_l_cents — optional unit price (ex-VAT), kept for display/reconciliation.
--   * vat_rate_bps      — VAT rate captured at entry (bps).
--   * driver_name       — free-text operator name for anonymous QR draws (mirrors
--                         usage_logs.driver_name); signed-in captures use by_user.
alter table fuel_issues
  add column if not exists cost_cents        bigint,
  add column if not exists price_per_l_cents bigint,
  add column if not exists vat_rate_bps      int,
  add column if not exists driver_name       text;

-- Helps the consumption/anomaly engine and the machine "fuel & consumption" card walk a
-- machine's metered draws in meter order cheaply.
create index if not exists fuel_issues_machine_meter_idx
  on fuel_issues(machine_id, meter_reading);
create index if not exists fuel_deliveries_date_idx on fuel_deliveries(farm_id, date);
create index if not exists fuel_issues_date_idx      on fuel_issues(farm_id, date);
