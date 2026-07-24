-- 0341_per_role_visibility.sql
-- F7 — Per-role visibility (FR-2.3, FR-8.1), enforced in RLS (not merely the UI).
--
-- Two role tightenings layered ON TOP of the existing farm-access model. Both are
-- strictly ADDITIVE narrowings for exactly one role each; for every other role the
-- predicate reduces to the previous `app.has_farm_access(farm_id)` behaviour, so every
-- pre-existing isolation assertion (all seeded personas are owner/workshop/rr_admin,
-- never operator) stays green.
--
--   1) OPERATOR → assigned assets only. A user whose role is `operator` sees only
--      machines where `assigned_operator_id = auth.uid()`, and only the child rows of
--      those machines. Owner/manager/mechanic keep full-farm access.
--
--   2) CONTRACTOR (workshop) → assigned work only. A `workshop` user sees (and may update)
--      only the work_requests assigned to THEIR workshop, plus those requests' events and
--      media — not every request on a linked farm. This closes the gap F12c flagged
--      ("the app-side workshop_id filter was load-bearing"): RLS now enforces it. Farm
--      crew keep full access to all their farm's requests.
--
-- Helpers are SECURITY DEFINER (bypass RLS to read machines/work_requests without
-- recursion), search_path pinned, execute revoked from public/anon and granted only to
-- authenticated + service_role (anon has no `app` schema usage anyway).

-- ── Helper: is a machine-keyed row visible to the current role? ────
-- Non-operators: == app.has_farm_access(p_farm). Operators: additionally require the
-- machine to be assigned to them. Farm-level rows (p_machine null, e.g. farm-level fuel)
-- are therefore hidden from operators and unchanged for everyone else.
create or replace function app.row_visible_to_role(p_farm uuid, p_machine uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.has_farm_access(p_farm)
     and (
       app.current_app_role() is distinct from 'operator'
       or (p_machine is not null and exists (
             select 1 from public.machines mm
             where mm.id = p_machine and mm.assigned_operator_id = auth.uid()))
     );
$$;

-- ── Helper: is a work_request visible to the current role? ─────────
-- Farm access + workshop-scoping (workshop sees only its own assigned requests) +
-- operator machine-scoping. Used for work_requests' child events and media.
create or replace function app.work_request_visible(p_wr uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.work_requests wr
    where wr.id = p_wr
      and app.has_farm_access(wr.farm_id)
      and (app.current_app_role() is distinct from 'workshop'
           or wr.workshop_id = app.user_workshop_id())
      and (app.current_app_role() is distinct from 'operator'
           or exists (select 1 from public.machines m
                      where m.id = wr.machine_id and m.assigned_operator_id = auth.uid()))
  );
$$;

revoke execute on function app.row_visible_to_role(uuid, uuid) from public, anon;
revoke execute on function app.work_request_visible(uuid)      from public, anon;
grant  execute on function app.row_visible_to_role(uuid, uuid) to authenticated, service_role;
grant  execute on function app.work_request_visible(uuid)      to authenticated, service_role;

-- ══════════════════════════════════════════════════════════════════
-- 1) OPERATOR → assigned machines + their child rows
-- ══════════════════════════════════════════════════════════════════

-- machines: the asset itself is gated on assigned_operator_id.
drop policy machines_sel on machines;
create policy machines_sel on machines for select to authenticated
  using (
    app.has_farm_access(farm_id) and deleted_at is null
    and (app.current_app_role() is distinct from 'operator' or assigned_operator_id = auth.uid())
  );

-- Direct machine-keyed child tables: replace the farm-only SELECT predicate with the
-- role-aware one. For non-operators this is byte-for-byte the old behaviour.
do $do$
declare t text;
begin
  foreach t in array array[
    'meter_readings','service_plan_lines','faults','job_cards','watch_items',
    'fuel_issues','usage_logs','licences'
  ] loop
    execute format('drop policy %1$I_sel on public.%1$I', t);
    execute format(
      'create policy %1$I_sel on public.%1$I for select to authenticated '
      'using (deleted_at is null and app.row_visible_to_role(farm_id, machine_id))', t);
  end loop;
end $do$;

-- ══════════════════════════════════════════════════════════════════
-- 2) CONTRACTOR (workshop) → assigned work_requests only (+ operator machine-scoping)
-- ══════════════════════════════════════════════════════════════════

-- work_requests SELECT: farm access + operator machine-scoping + workshop own-work-scoping.
drop policy work_requests_sel on work_requests;
create policy work_requests_sel on work_requests for select to authenticated
  using (
    deleted_at is null
    and app.row_visible_to_role(farm_id, machine_id)
    and (app.current_app_role() is distinct from 'workshop' or workshop_id = app.user_workshop_id())
  );

-- work_requests UPDATE: a workshop may act only on its OWN assigned requests. Farm crew
-- keep full access (reassign/close/etc.). Insert/delete stay farm-scoped (farm crew create
-- requests; a workshop never inserts one).
drop policy work_requests_upd on work_requests;
create policy work_requests_upd on work_requests for update to authenticated
  using (
    app.has_farm_access(farm_id)
    and (app.current_app_role() is distinct from 'workshop' or workshop_id = app.user_workshop_id())
  )
  with check (
    app.has_farm_access(farm_id)
    and (app.current_app_role() is distinct from 'workshop' or workshop_id = app.user_workshop_id())
  );

-- work_request_events SELECT: visible only when the parent request is visible to the role
-- (folds in workshop + operator scoping via the helper).
drop policy work_request_events_sel on work_request_events;
create policy work_request_events_sel on work_request_events for select to authenticated
  using (
    deleted_at is null
    and app.has_farm_access(farm_id)
    and app.work_request_visible(work_request_id)
  );

-- attachments: work_request media (parent_type='work_request') follows the same
-- role-scoping as the request; ALL other parent types are byte-for-byte unchanged.
drop policy attachments_sel on attachments;
create policy attachments_sel on attachments for select to authenticated
  using (
    app.has_farm_access(farm_id) and deleted_at is null
    and (parent_type <> 'work_request' or app.work_request_visible(parent_id))
  );
