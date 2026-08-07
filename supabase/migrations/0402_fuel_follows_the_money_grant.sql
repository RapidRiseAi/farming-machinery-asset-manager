-- 0402_fuel_follows_the_money_grant.sql
-- Fuel draws carry a price, so they belong with the money grant.
--
-- 0400 gated `fuel_tanks` and `fuel_deliveries` on `see_costs` but left `fuel_issues` on
-- the vehicle rule alone — so a contractor working on one tractor could still read every
-- diesel draw against it, and `fuel_issues` carries `cost_cents` and `price_per_l_cents`.
-- Measured against the live demo farm that was 6 rows a contractor had no reason to see.
--
-- Consumption IS diagnostically useful to a mechanic, which is why this is a grant rather
-- than a ban: a farm that wants their diesel specialist looking at L/hr turns `see_costs`
-- on for them. The default is off, like every other money surface.

drop policy fuel_issues_sel on fuel_issues;
create policy fuel_issues_sel on fuel_issues for select to authenticated
  using (
    deleted_at is null
    and app.row_visible_to_role(farm_id, machine_id)
    and app.partner_scope(farm_id, 'costs')
  );
