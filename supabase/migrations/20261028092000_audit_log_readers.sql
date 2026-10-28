-- The activity log must never show a reader more than the source table would (part 4 of 5):
-- who may read a farm's log.
--
-- Until now a farm's whole log was readable by every owner, manager and mechanic, by an
-- operator on a farm that shows costs to operators, and by every linked contractor whatever
-- its link allowed (20261026100000). The tables those rows describe are narrower for the
-- last two: an operator sees only the vehicles assigned to them, and a contractor sees
-- vehicles, service history, costs and the team only as far as the farm's link allows
-- (0400). Stripping columns (20261028091000) and refiling the per-person and billing tables
-- (20261028091500) cannot fix that, because the narrowing is per vehicle and per link
-- scope inside tables like machines, job_cards and cost_entries. Through the log a
-- contractor with a bare link read the farm's costs and budgets, every vehicle, the team's
-- phone numbers and other contractors' quotes.
--
-- So the log follows the one audience whose view of every 'farm' table is complete:
--   * Rapid Rise (is_rr_admin: two-step, not a test account) reads every row, as before;
--   * a farm's OWNERS, MANAGERS and MECHANICS read its log, as before. Each 'farm' table in
--     app.audit_table_rules shows them every row (machine rule, cost visibility, farm side;
--     see the enumeration in 20261028090000), which is what makes that filing safe;
--   * an operator who may see costs and a linked contractor (the readers 20261026100000
--     admitted besides those) keep exactly one thing, because the app uses it: the history
--     of a VEHICLE THEY CAN SEE (the machine page's record of changes, and downtime, which
--     0361 rebuilds from the status trail). Which vehicles is answered by machines' own
--     policy, through the subquery below, so it can never drift from the vehicle list. An
--     operator whose farm hides costs still reads nothing (operator_cost_confidentiality).
-- Nobody gains a row they could not read yesterday; operators and contractors lose the rows
-- whose tables never showed them.
--
-- Still set-based, as 20261026100000 made it: each farm set is worked out once per query.
-- The vehicle branch is reached only for rows the first two refuse, so an owner reading
-- their own farm never pays for it; for a contractor the subquery is one hashed list of the
-- vehicles machines' policy shows them on the farms they are linked to.

-- The farms whose whole log the caller may read.
create or replace function app.audit_readable_farm_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select a.farm_id
    from app.accessible_farm_ids() as a(farm_id)
   where app.has_farm_access(a.farm_id)
     and app.effective_farm_role(auth.uid(), a.farm_id) in ('owner', 'manager', 'mechanic');
$$;

comment on function app.audit_readable_farm_ids() is
  'Farms whose whole activity log the caller reads: owner, manager or mechanic there. '
  '20261028092000.';

revoke all on function app.audit_readable_farm_ids() from public, anon;
grant execute on function app.audit_readable_farm_ids() to authenticated;

-- The farms on which the caller may read the history of a vehicle they can see: the
-- audience 20261026100000 gave the whole log (anyone with farm access, an operator only
-- where the farm shows costs to operators).
create or replace function app.audit_vehicle_reader_farm_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select a.farm_id
    from app.accessible_farm_ids() as a(farm_id)
   where app.has_farm_access(a.farm_id)
     and (
       app.effective_farm_role(auth.uid(), a.farm_id) is distinct from 'operator'
       or app.can_view_farm_costs(a.farm_id)
     );
$$;

comment on function app.audit_vehicle_reader_farm_ids() is
  'Farms on which the caller reads the audit history of vehicles machines'' own policy shows '
  'them (operators only where costs are shown to operators). 20261028092000.';

revoke all on function app.audit_vehicle_reader_farm_ids() from public, anon;
grant execute on function app.audit_vehicle_reader_farm_ids() to authenticated;

-- The vehicle subquery names its farms as `= any (array(...))`, not `in (select ...)`, on
-- purpose. machines' policy is a security barrier, so a farm filter written as a join is
-- applied only AFTER the policy has run on every vehicle in the database; as an array it is
-- an index condition, and the policy runs on the reader's farms' vehicles alone. Measured on
-- PGlite with 4,000 vehicles: 378 ms as a join, 5 ms as an array, same rows.
drop policy if exists audit_sel on public.audit_log;
create policy audit_sel on public.audit_log for select to authenticated
  using (
    (select app.is_rr_admin())
    or farm_id in (select app.audit_readable_farm_ids())
    or (
      entity = 'machines'
      and farm_id = any (array(select app.audit_vehicle_reader_farm_ids()))
      -- Runs under machines' own policy, as the caller: the vehicles they can see.
      and entity_id in (
        select m.id from public.machines m
         where m.farm_id = any (array(select app.audit_vehicle_reader_farm_ids()))
      )
    )
  );
