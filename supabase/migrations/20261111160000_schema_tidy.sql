-- Tidying the schema (Supabase's advisors and a scan for unused objects, 11 November 2026).
--
-- 1. Four functions ran with the caller's search_path (advisor 0011): three trigger
--    functions and one pure helper. None looks anything up by an unqualified name, so
--    pinning changes nothing they do; it closes the door the advisor names.
--
-- 2. Functions nothing calls any more. Each was found by reading every reference in the
--    app, the scripts, the other functions, policies, views, triggers and indexes (none),
--    and the test suites (changed alongside):
--      public.ai_my_usage                a member's own AI use; no screen shows it
--      public.fuel_tank_reconciliation   and app.fuel_tank_reconciliation: the fuel screen
--                                        reads fuel_tank_balances instead
--      public.partner_over_limit         wrapper nothing calls; app.partner_over_limit stays
--      public.purchase_order_invoiced    wrapper nothing calls; app.purchase_order_invoiced stays
--      public.sync_apply_reading         the first offline sync; the app records readings
--                                        through recordMeterReading, and nothing calls this
--    The first four could be called from a browser by any signed-in person. An unused
--    door is still a door.

alter function public.app_purchase_order_totals() set search_path = public, pg_temp;
alter function public.app_service_job_source() set search_path = public, pg_temp;
alter function public.app_job_line_version() set search_path = public, pg_temp;
alter function app.stock_needs_reorder(numeric, numeric) set search_path = public, pg_temp;

drop function if exists public.ai_my_usage(uuid);
drop function if exists public.fuel_tank_reconciliation(uuid);
drop function if exists app.fuel_tank_reconciliation(uuid);
drop function if exists public.partner_over_limit(uuid, date);
drop function if exists public.purchase_order_invoiced(uuid);
drop function if exists public.sync_apply_reading(uuid, uuid, numeric, date, meter_source, uuid, timestamptz);
