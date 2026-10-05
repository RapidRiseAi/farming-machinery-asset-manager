-- WhatsApp alerts are not built, so they stop being a plan feature.
--
-- The sign-up comparison ticks every key of FEATURE_MIN_PLAN (src/lib/entitlements.ts),
-- and `whatsapp` put "WhatsApp alerts" on the Complete plan for a capability that does not
-- exist. The key is gone from that map; this is its SQL twin, which the map's header
-- promises to keep identical. Nothing ever asked app.has_entitlement for 'whatsapp', so no
-- gate changes: the feature simply falls to the ungated default like any other unknown
-- name, until the alerts are built and it comes back in both places.

create or replace function app.feature_min_rank(p_feature text) returns int
language sql immutable security definer set search_path = public, pg_temp as $$
  select case p_feature
    when 'dashboard'        then 2   -- professional+
    when 'advanced_reports' then 2   -- professional+
    when 'fuel'             then 2   -- professional+
    when 'tco'              then 2   -- professional+
    when 'aarto'            then 3   -- complete+
    when 'voice_ai'         then 3   -- complete+
    when 'multi_site'       then 3   -- complete+
    when 'api_access'       then 4   -- done_for_you
    else 1                           -- ungated core feature
  end;
$$;
