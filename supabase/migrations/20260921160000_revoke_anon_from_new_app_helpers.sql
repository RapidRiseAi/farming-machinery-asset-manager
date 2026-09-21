-- 20260921160000_revoke_anon_from_new_app_helpers.sql
-- Close the default PUBLIC grant on the app-schema helpers added on 21/09/2026.
--
-- WHAT WENT WRONG
-- =============================================================================
-- `create function` grants EXECUTE to PUBLIC. Every helper added yesterday said
-- `grant execute ... to authenticated, service_role` and none of them said
-- `revoke ... from public`, so `anon` inherited EXECUTE on all eight through PUBLIC.
--
-- Caught by CI, by the G11 assertion in `rls_isolation.sql`, which is a real-Postgres
-- suite: it does not run on PGlite, so `pnpm db:check` had nothing to say about it. That
-- is the gap. Eight functions shipped with a grant nobody intended and the local gates
-- were all green.
--
-- HOW EXPOSED IT ACTUALLY WAS
-- =============================================================================
-- Not. `anon` has no USAGE on schema `app` on the live database, so a call would have been
-- refused at the schema before the function grant mattered. This is defence in depth, and
-- the point of the gate is that the product must not DEPEND on the second lock: the day
-- somebody grants `anon` usage on `app` for one thing, these eight must not come with it.
--
-- WHY THE TRIGGER FUNCTION LOSES `authenticated` TOO
-- =============================================================================
-- `warranty_claim_within_job_card` is a trigger body. It is invoked by the trigger, never
-- called by name, and the convention this schema already follows for those
-- (`app.billing_derive_invoice_totals`, `app_audit`) is that nobody holds EXECUTE on them.

revoke execute on function app.driver_credential_lapses(uuid, uuid, text, date) from public, anon;
revoke execute on function app.farm_calendar(uuid, date, date) from public, anon;
revoke execute on function app.fit_tyre(uuid, uuid, tyre_axle, text, date, numeric) from public, anon;
revoke execute on function app.job_card_warranty_cover(uuid) from public, anon;
revoke execute on function app.months_between(date, date) from public, anon;
revoke execute on function app.remove_tyre(uuid, text, date, numeric, boolean) from public, anon;
revoke execute on function app.tyre_life(uuid) from public, anon;

-- A trigger body: reached by the trigger, never by name.
revoke execute on function app.warranty_claim_within_job_card() from public, anon, authenticated;

-- The grants the app genuinely needs, restated so this file is the whole truth about who
-- may call these rather than half of it.
grant execute on function app.driver_credential_lapses(uuid, uuid, text, date) to authenticated, service_role;
grant execute on function app.farm_calendar(uuid, date, date) to authenticated, service_role;
grant execute on function app.fit_tyre(uuid, uuid, tyre_axle, text, date, numeric) to authenticated, service_role;
grant execute on function app.job_card_warranty_cover(uuid) to authenticated, service_role;
grant execute on function app.months_between(date, date) to authenticated, service_role;
grant execute on function app.remove_tyre(uuid, text, date, numeric, boolean) to authenticated, service_role;
grant execute on function app.tyre_life(uuid) to authenticated, service_role;
