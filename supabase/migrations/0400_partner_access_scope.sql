-- 0400_partner_access_scope.sql
-- F16 — A partner sees the work they are doing, not the farm's books and address list.
--
-- ── WHAT WAS ACTUALLY HAPPENING ──────────────────────────────────────────────
--
-- An active `workshop_link` granted `app.has_farm_access`, which is the same predicate
-- the farm's own staff are judged by. Measured against the demo farm, one contractor
-- could read:
--
--     12 machines · 5 faults · 4 job cards · 50 meter readings
--     32 cost entries   ← the farm's whole spend, including OTHER contractors' invoices
--      3 budgets · 11 fuel issues
--      5 partners       ← the farm's other contractors, with their phone numbers
--      6 users          ← the farm's entire team, with names and emails
--     22 notifications
--
-- None of that is needed to fix a tractor. A farmer connecting a tyre fitter to change
-- two tyres was handing over their supplier list, their staff directory and their
-- financials. That is the wrong default, and it is the kind of wrong default that only
-- becomes visible after someone has been burned by it.
--
-- ── THE MODEL ────────────────────────────────────────────────────────────────
--
-- Access becomes a per-link CHOICE, made by the farm, defaulting to the minimum:
--
--   (default)            the vehicles this partner is actually working on — the ones
--                        with a work request or a document involving them — plus the
--                        faults and job cards on those vehicles. Nothing else.
--   see_all_vehicles     the whole fleet, for a partner who services everything.
--   see_service_history  meter readings, service plans, past job cards on those vehicles.
--   see_costs            what things cost. Off by default: a mechanic does not need to
--                        know what the farm paid anyone else.
--   see_team             the farm's people and their contact details.
--
-- `partners` has NO toggle and is never visible to a workshop. A contractor has no
-- business reading the farm's list of other contractors under any setting — that is a
-- competitor list, not job information.
--
-- EXISTING LINKS TIGHTEN. The columns default to false, so every current connection
-- narrows the moment this lands. That is deliberate: the safe direction for a permission
-- nobody has consciously granted is off, and a farm that wants the old breadth can turn
-- it on in one tap on the Partners screen.
--
-- Farm-side users are completely unaffected: every predicate below reduces to exactly
-- its previous form for anyone who is not a workshop.

-- ── The choice, stored on the link ───────────────────────────────────────────
alter table workshop_links
  add column see_all_vehicles    boolean not null default false,
  add column see_service_history boolean not null default false,
  add column see_costs           boolean not null default false,
  add column see_team            boolean not null default false;

comment on column workshop_links.see_all_vehicles is
  'Farm-granted: this partner may see the whole fleet, not only the vehicles they are '
  'working on. Default false — the minimum needed to do the job.';
comment on column workshop_links.see_costs is
  'Farm-granted: this partner may see what things cost. Default false — a mechanic does '
  'not need to know what the farm paid anyone else.';

-- ── Helpers ──────────────────────────────────────────────────────────────────

/*
 * Does the current user's workshop hold `key` on this farm?
 *
 * Returns TRUE for anyone who is not a workshop, so every policy below reads as "…and
 * the partner is allowed this", and collapses to a no-op for farm staff and rr_admin.
 */
create or replace function app.partner_scope(p_farm uuid, p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select
    app.is_rr_admin()
    or app.current_app_role() is distinct from 'workshop'
    or exists (
      select 1 from public.workshop_links wl
      where wl.workshop_id = app.user_workshop_id()
        and wl.farm_id = p_farm
        and wl.status = 'active'
        and wl.deleted_at is null
        and case p_key
              when 'vehicles' then wl.see_all_vehicles
              when 'history'  then wl.see_service_history
              when 'costs'    then wl.see_costs
              when 'team'     then wl.see_team
              else false
            end
    );
$$;

/*
 * Is this machine one the partner is actually working on?
 *
 * "Working on" means there is a work request assigned to them, or a document they
 * issued, against that machine. Deliberately not "any job card": a job card is the
 * farm's own record and may have nothing to do with this partner.
 *
 * TRUE for non-workshops, and TRUE for a workshop the farm granted the whole fleet to.
 */
create or replace function app.partner_machine_visible(p_farm uuid, p_machine uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select
    app.is_rr_admin()
    or app.current_app_role() is distinct from 'workshop'
    or app.partner_scope(p_farm, 'vehicles')
    or (p_machine is not null and (
      exists (
        select 1 from public.work_requests wr
        where wr.machine_id = p_machine
          and wr.workshop_id = app.user_workshop_id()
          and wr.deleted_at is null
      )
      or exists (
        select 1 from public.partner_documents pd
        where pd.machine_id = p_machine
          and pd.workshop_id = app.user_workshop_id()
          and pd.deleted_at is null
      )
    ));
$$;

revoke execute on function app.partner_scope(uuid, text)            from public, anon;
revoke execute on function app.partner_machine_visible(uuid, uuid)  from public, anon;
grant  execute on function app.partner_scope(uuid, text)            to authenticated, service_role;
grant  execute on function app.partner_machine_visible(uuid, uuid)  to authenticated, service_role;

-- ── The one predicate every machine-keyed table already routes through ───────
-- 0341 gave these tables `app.row_visible_to_role(farm, machine)`. Extending THAT
-- function narrows nine tables at once and keeps the rule in a single place, rather than
-- nine copies of it that can drift.
create or replace function app.row_visible_to_role(p_farm uuid, p_machine uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_farm_access(p_farm)
     -- Operators: only the machines assigned to them (F7, unchanged).
     and (app.current_app_role() is distinct from 'operator'
          or exists (select 1 from public.machines m
                     where m.id = p_machine and m.assigned_operator_id = auth.uid()))
     -- Partners: only the machines they are working on, unless the farm granted more.
     and app.partner_machine_visible(p_farm, p_machine);
$$;

-- machines itself carries the same rule (its policy is bespoke because the machine id
-- is the row's own id).
drop policy machines_sel on machines;
create policy machines_sel on machines for select to authenticated
  using (
    app.has_farm_access(farm_id) and deleted_at is null
    and (app.current_app_role() is distinct from 'operator' or assigned_operator_id = auth.uid())
    and app.partner_machine_visible(farm_id, id)
  );

-- ── Money: off unless the farm says otherwise ────────────────────────────────
do $do$
declare t text;
begin
  foreach t in array array['cost_entries', 'budgets'] loop
    execute format('drop policy %1$I_sel on public.%1$I', t);
    execute format(
      'create policy %1$I_sel on public.%1$I for select to authenticated '
      'using (deleted_at is null and app.has_farm_access(farm_id) '
      '       and app.partner_scope(farm_id, ''costs'') '
      '       and app.partner_machine_visible(farm_id, machine_id))', t);
  end loop;
end $do$;

-- Fuel is both cost and operational detail; a contractor sees none of it by default.
do $do$
declare t text;
begin
  foreach t in array array['fuel_tanks', 'fuel_deliveries'] loop
    execute format('drop policy %1$I_sel on public.%1$I', t);
    execute format(
      'create policy %1$I_sel on public.%1$I for select to authenticated '
      'using (deleted_at is null and app.has_farm_access(farm_id) '
      '       and app.partner_scope(farm_id, ''costs''))', t);
  end loop;
end $do$;

-- Job-card LINES carry what parts and labour cost; gate them with the money rule too,
-- while leaving a partner the job cards on their own vehicles.
drop policy job_card_lines_sel on job_card_lines;
create policy job_card_lines_sel on job_card_lines for select to authenticated
  using (
    deleted_at is null
    and app.has_farm_access(farm_id)
    and app.partner_scope(farm_id, 'costs')
    and exists (select 1 from public.job_cards jc
                where jc.id = job_card_id and jc.deleted_at is null
                  and app.partner_machine_visible(jc.farm_id, jc.machine_id))
  );

-- ── History: meter readings and service plans ────────────────────────────────
do $do$
declare t text;
begin
  foreach t in array array['meter_readings', 'service_plan_lines'] loop
    execute format('drop policy %1$I_sel on public.%1$I', t);
    execute format(
      'create policy %1$I_sel on public.%1$I for select to authenticated '
      'using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id) '
      '       and app.partner_scope(farm_id, ''history''))', t);
  end loop;
end $do$;

-- ── The farm's people ────────────────────────────────────────────────────────
-- `users` is how a contractor would read the farm's staff directory: names, emails,
-- phone numbers. Off unless the farm granted it. A partner always sees its OWN staff and
-- itself, which is what the app needs to render "who did this".
drop policy users_sel on users;
create policy users_sel on users for select to authenticated
  using (
    app.is_rr_admin()
    or id = auth.uid()
    or (workshop_id is not null and workshop_id = app.user_workshop_id())
    or (farm_id is not null and app.has_farm_access(farm_id) and app.partner_scope(farm_id, 'team'))
  );

-- ── The farm's other contractors: never ──────────────────────────────────────
-- No toggle. A contractor reading the farm's partner directory is reading a competitor
-- list with contact details, and no amount of farm consent makes that part of fixing a
-- tractor. Global suggested rows (farm_id null) stay readable by everyone, as before.
drop policy partners_sel on partners;
create policy partners_sel on partners for select to authenticated
  using (
    deleted_at is null
    and (
      farm_id is null
      or (app.has_farm_access(farm_id) and app.current_app_role() is distinct from 'workshop')
      or app.is_rr_admin()
    )
  );
