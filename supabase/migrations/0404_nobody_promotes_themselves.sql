-- 0404_nobody_promotes_themselves.sql
-- Any signed-in user could make themselves an RR admin with one UPDATE.
--
-- ── WHAT WAS ACTUALLY POSSIBLE ───────────────────────────────────────────────
--
-- `users_upd` (0101) has always been `using (id = auth.uid() or …)`, so a user may edit
-- their own row — which is right for a name, a phone number, a language. But `role`,
-- `farm_id` and `workshop_id` live on that same row, and `app.is_rr_admin()` is defined
-- as `users.role = 'rr_admin'` for `auth.uid()`. So the row that decides what you may
-- read was writable by you.
--
-- Measured on the test database from an ordinary contractor login:
--
--     update users set role = 'rr_admin', farm_id = null, workshop_id = null
--      where id = auth.uid();
--
--     → 9 farms · 26 machines · 16 cost entries · 15 users · 9 partner documents
--
-- That is every tenant in the system. `users_scope_ck` blocks the naive version (an
-- rr_admin may not hold a farm or a workshop), which is why this was not obvious — but
-- nulling both columns in the same statement satisfies it.
--
-- It is reachable in production by anyone with a login: PostgREST exposes the table, the
-- anon key is in the client bundle by design, and the user's own JWT is in their browser.
-- `PATCH /rest/v1/users?id=eq.<self>` is the whole exploit. This predates every partner
-- feature; it has been open since 0101.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
--
-- A policy cannot express "you may edit this row but not these columns" — it sees the new
-- row, not the change. So the rule goes in a BEFORE UPDATE trigger, which can compare.
--
-- Administrative fields (role · farm_id · workshop_id · active · deleted_at) may be
-- changed only by rr_admin, or by an owner/manager of the farm the subject belongs to,
-- and NEVER on your own row. Everything else — name, email, phone, language, tone,
-- notification preferences — stays self-editable exactly as before, so nothing the app
-- does today changes.
--
-- Two further limits on a farm owner: they cannot mint an rr_admin (only Rapid Rise
-- creates Rapid Rise), and they cannot attach anyone to a workshop (a partner account is
-- created by the invite flow, not by editing a row).

create or replace function app_users_guard_privileges() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_admin_change boolean;
begin
  v_admin_change :=
       new.role       is distinct from old.role
    or new.farm_id    is distinct from old.farm_id
    or new.workshop_id is distinct from old.workshop_id
    or new.active     is distinct from old.active
    or new.deleted_at is distinct from old.deleted_at;

  if not v_admin_change then
    return new;                          -- a profile edit; the policy already judged it
  end if;

  -- No JWT means this is the service role, a migration, or the seed — server-side code
  -- that is trusted by definition and is how invites and admin tooling do their work.
  if auth.uid() is null then
    return new;
  end if;

  if app.is_rr_admin() then
    return new;
  end if;

  if old.id = auth.uid() then
    raise exception 'You cannot change your own role, farm or account status.'
      using errcode = '42501';
  end if;

  if app.current_app_role() not in ('owner', 'manager')
     or old.farm_id is null
     or not app.has_farm_access(old.farm_id) then
    raise exception 'Only an owner or manager of this person''s farm can change their access.'
      using errcode = '42501';
  end if;

  if new.role = 'rr_admin' then
    raise exception 'Only Rapid Rise can create a Rapid Rise administrator.'
      using errcode = '42501';
  end if;

  if new.workshop_id is distinct from old.workshop_id then
    raise exception 'A partner account is created by the invite flow, not by editing a person.'
      using errcode = '42501';
  end if;

  if new.farm_id is distinct from old.farm_id
     and (new.farm_id is null or not app.has_farm_access(new.farm_id)) then
    raise exception 'You cannot move someone to a farm you do not have access to.'
      using errcode = '42501';
  end if;

  return new;
end $$;

revoke execute on function app_users_guard_privileges() from public, anon, authenticated;

drop trigger if exists users_guard_privileges on users;
create trigger users_guard_privileges
  before update on users
  for each row execute function app_users_guard_privileges();

comment on function app_users_guard_privileges() is
  'Keeps the administrative columns of `users` (role, farm_id, workshop_id, active, '
  'deleted_at) out of reach of the person they describe. Without it, `users_upd` lets '
  'anyone set their own role to rr_admin and read every tenant.';

-- ── The same shape of mistake, one table over ────────────────────────────────
-- `notifications_upd` is still farm-wide, so a linked contractor could mark the farm's
-- alerts read. An UPDATE that names no columns in its WHERE clause does not consult the
-- SELECT policy, so 0403's narrowing does not cover this on its own. A notification is
-- addressed to a person; only that person marks it read, which is all the app ever does.
drop policy notifications_upd on notifications;
create policy notifications_upd on notifications for update to authenticated
  using (app.is_rr_admin() or user_id = auth.uid())
  with check (app.is_rr_admin() or user_id = auth.uid());
