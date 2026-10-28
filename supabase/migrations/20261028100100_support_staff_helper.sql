-- 20261028100100_support_staff_helper.sql
-- Who may work the support desk.
--
-- Founder default (2026-10-28): at launch only team@ answers tickets, so support staff are
-- exactly Rapid Rise admins, and this answers the same as app.is_rr_admin(): the second
-- factor given in this session and never a test account (20261014120000). Every support
-- function asks THIS helper rather than is_rr_admin directly, so personal, two-step,
-- support-only staff accounts can be added later by changing one function, without giving
-- them billing, discounts or AI margins. No shared logins.

create or replace function app.is_rr_support() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_rr_admin();
$$;

comment on function app.is_rr_support() is
  'May this session work the support desk? Today exactly app.is_rr_admin() (two-step, not a '
  'test account). Change here, and only here, to admit support-only staff later.';

revoke execute on function app.is_rr_support() from public, anon;
grant execute on function app.is_rr_support() to authenticated, service_role;
