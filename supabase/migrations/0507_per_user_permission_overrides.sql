-- 0507_per_user_permission_overrides.sql
-- FR-2.5 — Per-user permission overrides: the five fixed roles stay the baseline, and a
-- farm may hand ONE person a named grant on top.
--
-- ── WHY NOT A ROLE BUILDER ───────────────────────────────────────────────────
--
-- The obvious shape is "let a farm define its own roles". It was rejected deliberately.
-- A custom-role builder makes every policy in the product consult a dynamic table that a
-- customer edits, which is the highest-risk change possible to a system where RLS is the
-- sole tenancy guarantor: the predicate deciding who sees a tractor stops being something
-- this repo can read and becomes something a farm typed on a Tuesday.
--
-- So: `app_role` is NOT widened, the five roles keep their meaning, and an override is a
-- row saying "this person, on this farm, additionally may X" from a closed set of X.
--
-- ── THE PROPERTY THAT MATTERS: ADDITIVE, BY CONSTRUCTION ─────────────────────
--
-- F7 (0340–0341) is recorded in this repo as its most tenancy-sensitive change. This is
-- the second, so the additive property is not argued — it is made structural.
--
-- Every grant is enforced by an ADDITIONAL PERMISSIVE POLICY. PostgreSQL combines
-- permissive policies for a command with OR. A permissive policy can therefore only ever
-- ADD rows to a result; there is no expression it can contain that removes one. The
-- guarantee "a grant may only open access, never close it" is a property of the mechanism
-- rather than of the boolean expressions below, and it holds even if somebody later writes
-- one of those expressions wrongly.
--
-- The corollary is what the isolation suite checks: with no grant rows present,
-- `app.has_permission` is false for every caller, every new policy contributes nothing,
-- and every persona's visibility is byte-identical to the day before this file landed.
-- Measured, not assumed: 51 personas x 61 RLS tables = 3,111 cells, identical either side.
--
-- ── WHY NOT FOLDED INTO app.row_visible_to_role ──────────────────────────────
--
-- That was the first design, and it does not work from a file numbered 0507. Migrations
-- apply in filename order and `0507_...` sorts BEFORE `20260813195653_...`; the
-- voice-assistant commands migration ends with its own
-- `create or replace function app.row_visible_to_role` and its own `machines_sel`. A fold
-- written here is silently overwritten a moment later — measured with a probe migration
-- before this file was written, not inferred. Extra policies survive that, because nothing
-- else names them.
--
-- The second reason is the better one: rewriting `row_visible_to_role` means re-deriving,
-- by argument, that nine tables still answer exactly as before. Adding a policy beside it
-- means never touching the predicate F7, F16 and the assistant all depend on.
--
-- ── THE CLOSED SET, AND WHY IT IS ONLY THREE ─────────────────────────────────
--
-- A permission nobody enforces is worse than a missing one: the farm believes it granted
-- something. So every name here was checked against the live policy catalogue for a door
-- that is genuinely SHUT today for at least one farm-side role:
--
--   see_all_vehicles   Shut for OPERATORS. 0341/0400 narrow `machines` and ten machine-
--                      keyed child tables to the vehicles assigned to them. This is the
--                      relief valve for the stand-in driver covering the whole shed on a
--                      Saturday. Farm-wide by design: the grant says "trust this person
--                      with the yard", so farm-level rows (a fuel draw with no vehicle)
--                      come with it.
--   manage_stock       Shut for OPERATORS. 0452 narrowed store WRITES to
--                      owner/manager/mechanic after an operator was found able to move a
--                      machine's costs. Reading was deliberately left open; this reopens
--                      the write for one named person.
--   manage_partners    Shut for MECHANICS and OPERATORS. 0301 restricts the contractor
--                      directory to owner/manager. The workshop foreman who actually
--                      phones these people is usually a mechanic.
--
-- Four of the six names originally suggested were dropped after measuring, because those
-- doors are already OPEN to every farm-side role including operators, and a switch that
-- grants what somebody already has is a lie told to the farm:
--
--   see_costs           `cost_entries_sel` / `budgets_sel` gate only on partner scope, so
--                       an operator already reads the farm's entire spend. (Worth its own
--                       migration in the other direction; NOT this one — closing it would
--                       be a narrowing, which this file must never do.)
--   see_service_history `meter_readings` / `service_plan_lines` are narrowed for operators
--                       by the ASSIGNMENT rule, which `see_all_vehicles` already lifts.
--                       A second switch for the same door is a second thing to get wrong.
--   manage_job_cards    `job_cards_ins` / `_upd` are `app.has_farm_access(farm_id)` alone.
--   capture_fuel        `fuel_issues_ins` is `app.has_farm_access(farm_id)` alone.
--
-- `manage_team` is excluded on purpose, not by omission. A holder could insert a
-- `user_farm_memberships` row making themselves 'owner', and `app.effective_farm_role`
-- treats an active membership as authoritative — 0404's escalation, rebuilt as a feature.
-- Deciding who may reach a farm stays with the fixed roles.
--
-- ── RELATION TO F16 partner_scope (0400) ─────────────────────────────────────
--
-- Deliberately the same vocabulary, deliberately a different table, because these are
-- different populations reached by different spines:
--
--            CONTRACTORS (F16)                    STAFF (here)
--   reach    workshop_links, one row per farm     users.farm_id / user_farm_memberships
--   stored   columns ON the link row              rows in user_permission_grants
--   scope    per (workshop, farm)                 per (person, farm)
--   default  minimum; a link tightens on landing  the role's baseline; nothing changes
--
-- Contractor scoping is NOT touched. `app.has_permission` returns false unless
-- `app.is_farm_side()`, so no grant row can widen a workshop user by any route — a farm
-- cannot accidentally hand its contractor the fleet through this screen, and the
-- competitor-list rule 0400 settled stays settled. Asserted in G30.

-- ═════════════════════════════════════════════════════════════════════════════
-- ORDER OF THIS FILE
-- ═════════════════════════════════════════════════════════════════════════════
-- Postgres resolves a function reference when a POLICY is created, and a SQL function
-- body when the FUNCTION is created. So the pieces land in dependency order: the
-- belongs-to helper (needs only users + memberships), then the table, then
-- has_permission (needs the table), then everything that calls them.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1) WHO IS ACTUALLY ON THIS FARM
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * Is p_user actually on p_farm — by primary farm or by an active F7 membership?
 *
 * SECURITY DEFINER because it must read `users` and `user_farm_memberships` past their own
 * policies while deciding a WITH CHECK on a third table.
 *
 * It takes an arbitrary user id, which is the shape G11 exists to be suspicious of, so it
 * refuses to answer at all about a farm the CALLER cannot already reach. Within that farm
 * it discloses nothing new: `users_sel` already lets a farm-access holder read their own
 * farm's people.
 */
create or replace function app.user_belongs_to_farm(p_user uuid, p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_user is not null
     and p_farm is not null
     and app.has_farm_access(p_farm)
     and (
       exists (
         select 1 from public.users u
         where u.id = p_user
           and u.deleted_at is null
           and u.farm_id = p_farm
           and u.role in ('owner','manager','mechanic','operator')
       )
       or exists (
         select 1 from public.user_farm_memberships m
         where m.user_id = p_user
           and m.farm_id = p_farm
           and m.active
           and m.deleted_at is null
       )
     );
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2) THE GRANTS THEMSELVES
-- ═════════════════════════════════════════════════════════════════════════════
-- Shape mirrors `user_farm_memberships` (0340), the closest precedent, which solved the
-- same problems: soft delete rather than a hard one so a revoked permission leaves a
-- record; plain FKs to users(id) and farms(id) rather than the usual composite to
-- (id, farm_id), because a multi-site person's `users.farm_id` is only their PRIMARY farm
-- and a composite key could not express a grant on a farm they reach by membership.
-- Tenancy is not weakened by that: `farm_id` here is not a denormalised copy of anything,
-- it is the SCOPE of the grant, and `app.has_permission` refuses to answer for a farm the
-- caller cannot already reach.
create table user_permission_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  farm_id     uuid not null references farms(id),
  permission  text not null,
  granted_by  uuid references users(id),
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  -- One row per person per farm per permission, soft-deleted rows included, so re-granting
  -- reopens the SAME row and its audit trail reads as one continuous history rather than a
  -- pile of look-alikes.
  constraint user_permission_grants_uq unique (user_id, farm_id, permission)
);
create index user_permission_grants_user_idx on user_permission_grants(user_id);
create index user_permission_grants_farm_idx on user_permission_grants(farm_id);

comment on table user_permission_grants is
  'FR-2.5 per-user permission overrides (0507). One row = "this person, on this farm, may '
  'additionally X". Enforced by ADDITIONAL PERMISSIVE policies, so a row can only ever open '
  'access. The five fixed roles remain the baseline; this table never removes anything.';
comment on column user_permission_grants.permission is
  'A name from the closed set guarded by the user_permission_grants_check trigger. Mirrored '
  'in src/lib/permissions.ts — change one, change the other.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3) THE GATE
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * Does the CALLER hold `p_permission` on `p_farm`?
 *
 * SECURITY DEFINER: it is called from inside policies and must read the grants table
 * without those policies deciding the answer for it.
 *
 * Three refusals, in order, each load-bearing:
 *
 *   app.is_farm_side()     A grant is a STAFF instrument. Contractors reach farms through
 *                          workshop_links and their scope is F16's, on the link row; this
 *                          function returning false for them is what makes it impossible
 *                          for anything below to widen a contractor by any route.
 *                          `is_farm_side` also requires the account to be active and not
 *                          deleted, so deactivating somebody revokes their grants with them.
 *                          rr_admin is excluded too, and harmlessly: they already read
 *                          every farm, and every policy here is an OR.
 *
 *   app.has_farm_access()  The 0251 rule. A caller may only probe a farm they can already
 *                          reach, so this can never become a cross-tenant oracle.
 *
 *   the row itself         Soft-deleted grants do not count, so revoking is immediate —
 *                          dynamic scoping, exactly like workshop_links and memberships.
 */
create or replace function app.has_permission(p_farm uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_farm is not null
     and p_permission is not null
     and app.is_farm_side()
     and app.has_farm_access(p_farm)
     and exists (
       select 1 from public.user_permission_grants g
       where g.user_id = auth.uid()
         and g.farm_id = p_farm
         and g.permission = p_permission
         and g.deleted_at is null
     );
$$;

-- G11: an app-schema function with no explicit grant defaults to EXECUTE TO PUBLIC, which
-- is how the F14 debug probe stayed reachable by anon (0440). Revoke, then grant narrowly.
revoke execute on function app.user_belongs_to_farm(uuid, uuid) from public, anon;
revoke execute on function app.has_permission(uuid, text)       from public, anon;
grant  execute on function app.user_belongs_to_farm(uuid, uuid) to authenticated, service_role;
grant  execute on function app.has_permission(uuid, text)       to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4) THE TABLE'S OWN RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── The closed set, refused loudly (0505 / 0434 pattern) ─────────────────────
-- A farm that somehow posts 'see_everything' has not granted a permission — it has stored
-- a word no policy will ever read, and would go on believing the person could see the yard.
--
-- The same trigger stamps WHO. `granted_by` and `deleted_by` are the record of who opened
-- and who closed a security setting, so they come from the session and never from the
-- request: a signed-in caller cannot name somebody else as the granter. A seed or a
-- service-role import (no auth.uid()) keeps whatever it passed.
create or replace function app_user_permission_grants_check() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.permission is null
     or new.permission not in ('see_all_vehicles', 'manage_stock', 'manage_partners') then
    raise exception 'Unknown permission: %', new.permission using errcode = '22023';
  end if;

  if tg_op = 'INSERT' then
    new.granted_by := coalesce(auth.uid(), new.granted_by);
  elsif old.deleted_at is not null and new.deleted_at is null then
    new.granted_by := coalesce(auth.uid(), new.granted_by);   -- re-opened: a new decision
  elsif old.deleted_at is null and new.deleted_at is not null then
    new.deleted_by := coalesce(auth.uid(), new.deleted_by);   -- revoked
  end if;

  return new;
end $$;

create trigger user_permission_grants_check
  before insert or update on user_permission_grants
  for each row execute function app_user_permission_grants_check();

-- A trigger function is reached by the trigger, never called; EXECUTE is checked when the
-- trigger is created, not when it fires. Revoked for the reason 0505 records.
revoke execute on function app_user_permission_grants_check() from anon, authenticated, public;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table user_permission_grants enable row level security;
alter table user_permission_grants force  row level security;

-- You always see what has been granted TO YOU — a permission you cannot discover is a
-- permission you will not use. A farm's owner/manager (and rr_admin) see and manage the
-- grants on farms they administer. Mirrors `ufm_sel` (0340) deliberately, including its
-- use of `app.current_app_role()`: the two screens administer the same people, and a
-- second, subtly different notion of "who may administer this farm" is how the two drift.
create policy upg_sel on user_permission_grants for select to authenticated
  using (
    deleted_at is null and (
      user_id = auth.uid()
      or app.is_rr_admin()
      or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
    )
  );

-- NOBODY WRITES A ROW ABOUT THEMSELVES.
--
-- `0404` is why this is a policy and not a check in a server action: a signed-in user
-- could once `update users set role='rr_admin'` on their own row, reachable straight over
-- PostgREST, because the guard sat somewhere the request did not have to pass through. A
-- self-service permission screen is that same surface. Assume an attacker holding a valid
-- operator session and posting directly at the REST endpoint: `user_id <> auth.uid()` is
-- evaluated by the database on every insert and every update, so no route skips it — and
-- it covers the subtle direction too, where "granting" is an UPDATE clearing `deleted_at`
-- on a revoked row rather than an INSERT.
--
-- It applies to DELETE as well. Renouncing your own permission is harmless, but "you never
-- write a row about yourself" is a rule a reader can hold in their head, and the exception
-- would have to be re-argued by everyone who touches this file afterwards.
--
-- `app.user_belongs_to_farm` stops a farm writing rows naming ANOTHER tenant's people:
-- such a row is inert (has_permission refuses without farm access) but it would still be
-- visible to that stranger through the own-user clause above, and would land in their
-- farm's audit log. A grant is only ever about somebody actually on this farm.
create policy upg_ins on user_permission_grants for insert to authenticated
  with check (
    user_id <> auth.uid()
    and app.user_belongs_to_farm(user_id, farm_id)
    and (
      app.is_rr_admin()
      or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
    )
  );

create policy upg_upd on user_permission_grants for update to authenticated
  using (
    user_id <> auth.uid()
    and (
      app.is_rr_admin()
      or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
    )
  )
  with check (
    user_id <> auth.uid()
    and app.user_belongs_to_farm(user_id, farm_id)
    and (
      app.is_rr_admin()
      or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
    )
  );

create policy upg_del on user_permission_grants for delete to authenticated
  using (
    user_id <> auth.uid()
    and (
      app.is_rr_admin()
      or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
    )
  );

-- ── Grants (0102 pattern; anon gets nothing) ─────────────────────────────────
grant select, insert, update, delete on public.user_permission_grants to authenticated;
grant all on public.user_permission_grants to service_role;

-- ── Audit (append-only history, 0008 pattern) ────────────────────────────────
-- Who gave whom what, and when it was taken away.
create trigger user_permission_grants_audit
  after insert or update or delete on user_permission_grants
  for each row execute function app_audit();

-- ═════════════════════════════════════════════════════════════════════════════
-- 5) WHAT A GRANT OPENS
-- ═════════════════════════════════════════════════════════════════════════════
-- Every policy below is PERMISSIVE and therefore ORed with the policy already governing
-- the table. None of them replaces, drops or rewrites anything. The names all carry a
-- `_perm` suffix so a later migration recreating (say) `machines_sel` cannot silently take
-- one with it — which is exactly what happens to a `create or replace` from this file.

-- ── see_all_vehicles: the whole fleet, and everything hanging off it ─────────
-- One predicate, written once, applied by a loop — the shape 0341 and 0400 use, so the
-- rule cannot drift between eleven copies of it.
create policy machines_sel_perm on machines for select to authenticated
  using (deleted_at is null and app.has_permission(farm_id, 'see_all_vehicles'));

do $do$
declare t text;
begin
  foreach t in array array[
    'meter_readings','service_plan_lines','faults','job_cards','watch_items',
    'fuel_issues','usage_logs','licences','fines','work_requests'
  ] loop
    execute format(
      'create policy %1$I_sel_perm on public.%1$I for select to authenticated '
      'using (deleted_at is null and app.has_permission(farm_id, ''see_all_vehicles''))', t);
  end loop;
end $do$;

-- ── manage_stock: reopen the write 0452 closed, for one named person ─────────
-- Reading was never narrowed, so there is nothing to add for SELECT.
do $do$
declare t text;
begin
  foreach t in array array['stock_items','stock_movements'] loop
    execute format(
      'create policy %1$I_ins_perm on public.%1$I for insert to authenticated '
      'with check (app.has_permission(farm_id, ''manage_stock''))', t);
    execute format(
      'create policy %1$I_upd_perm on public.%1$I for update to authenticated '
      'using (app.has_permission(farm_id, ''manage_stock'')) '
      'with check (app.has_permission(farm_id, ''manage_stock''))', t);
    execute format(
      'create policy %1$I_del_perm on public.%1$I for delete to authenticated '
      'using (app.has_permission(farm_id, ''manage_stock''))', t);
  end loop;
end $do$;

-- ── manage_partners: the farm's own contractor directory ─────────────────────
-- `farm_id is not null` is not decoration. `partners.farm_id` is null on the GLOBAL
-- suggested rows RR curates for every customer, and no farm-level grant may ever reach
-- those. `app.has_permission` already refuses a null farm; this states the invariant where
-- a reader of the policy will see it.
create policy partners_ins_perm on partners for insert to authenticated
  with check (farm_id is not null and app.has_permission(farm_id, 'manage_partners'));
create policy partners_upd_perm on partners for update to authenticated
  using      (farm_id is not null and app.has_permission(farm_id, 'manage_partners'))
  with check (farm_id is not null and app.has_permission(farm_id, 'manage_partners'));
create policy partners_del_perm on partners for delete to authenticated
  using      (farm_id is not null and app.has_permission(farm_id, 'manage_partners'));
