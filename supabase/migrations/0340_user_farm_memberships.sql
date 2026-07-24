-- 0340_user_farm_memberships.sql
-- F7 — Multi-site under one account (FR-1.5).
--
-- One account (auth user / public.users row) can now reach MULTIPLE farms/sites while
-- per-site isolation is preserved. The many-to-many spine is `user_farm_memberships`.
--
-- Design rules that keep every existing isolation guarantee intact:
--   * `public.users.farm_id` stays the user's DEFAULT / PRIMARY farm and remains a valid
--     access path on its own — nothing that relied on it changes. Memberships are PURELY
--     ADDITIVE: they widen a user's reachable-farm set, they never narrow it.
--   * `app.accessible_farm_ids()` and `app.has_farm_access()` are rewritten to UNION the
--     user's active memberships on top of the primary-farm + workshop-link paths. The
--     workshop path (workshop_links) is untouched — contractors still reach farms only via
--     an active link.
--   * Every current user gets a backfilled membership row for their primary farm, so the
--     union is a strict superset of the old behaviour (== old for anyone with no extra
--     membership). Isolation tests that seed users directly still pass via the primary path.
--
-- Standard house rules: farm-scoped, force-RLS, audit trigger, soft-delete, explicit
-- grants, anon zero-DB.

-- ── Table ─────────────────────────────────────────────────────────
create table user_farm_memberships (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  farm_id     uuid not null references farms(id),
  role        user_role   not null,
  active      boolean     not null default true,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid,
  -- Memberships grant FARM access; rr_admin (cross-tenant) and workshop (workshop_links)
  -- have their own paths and must not appear here.
  constraint user_farm_memberships_role_ck check (role in ('owner','manager','mechanic','operator')),
  constraint user_farm_memberships_uq unique (user_id, farm_id)
);
create index user_farm_memberships_user_idx on user_farm_memberships(user_id);
create index user_farm_memberships_farm_idx on user_farm_memberships(farm_id);

-- ── RLS ───────────────────────────────────────────────────────────
-- You always see your OWN membership rows. A farm's owner/manager (and rr_admin) see and
-- manage the memberships of farms they administer. Mutation is owner/manager/rr_admin only.
alter table user_farm_memberships enable row level security;
alter table user_farm_memberships force  row level security;

create policy ufm_sel on user_farm_memberships for select to authenticated
  using (
    deleted_at is null and (
      user_id = auth.uid()
      or app.is_rr_admin()
      or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
    )
  );
create policy ufm_ins on user_farm_memberships for insert to authenticated
  with check (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
  );
create policy ufm_upd on user_farm_memberships for update to authenticated
  using (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
  )
  with check (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
  );
create policy ufm_del on user_farm_memberships for delete to authenticated
  using (
    app.is_rr_admin()
    or (app.has_farm_access(farm_id) and app.current_app_role() in ('owner','manager'))
  );

-- ── Grants (0102 pattern; anon gets nothing) ──────────────────────
grant select, insert, update, delete on public.user_farm_memberships to authenticated;
grant all on public.user_farm_memberships to service_role;

-- ── Audit (append-only history, 0008 pattern) ─────────────────────
create trigger user_farm_memberships_audit
  after insert or update or delete on user_farm_memberships
  for each row execute function app_audit();

-- ── Backfill: a primary-farm membership for every current farm user ──
-- Idempotent. Runs against whatever users exist at migration time (none in the fresh
-- test DB; the real farm users in production). Makes the new union == the old behaviour.
insert into user_farm_memberships (user_id, farm_id, role, active)
select u.id, u.farm_id, u.role, u.active
  from public.users u
 where u.farm_id is not null
   and u.role in ('owner','manager','mechanic','operator')
   and u.deleted_at is null
on conflict (user_id, farm_id) do nothing;

-- ── Rewrite the two access helpers to UNION memberships ────────────
-- has_farm_access gains a membership branch (active membership + active user). Order of
-- OR branches is irrelevant to correctness; primary-farm + workshop paths are preserved
-- verbatim so nothing that worked before can break.
create or replace function app.has_farm_access(fid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select
    app.is_rr_admin()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.active and u.deleted_at is null and u.farm_id = fid
    )
    or exists (
      select 1
      from public.user_farm_memberships m
      join public.users u on u.id = auth.uid() and u.active and u.deleted_at is null
      where m.user_id = auth.uid()
        and m.farm_id = fid
        and m.active
        and m.deleted_at is null
    )
    or exists (
      select 1
      from public.workshop_links wl
      join public.users u on u.id = auth.uid() and u.active and u.deleted_at is null
      where wl.farm_id = fid
        and wl.workshop_id = u.workshop_id
        and wl.status = 'active'
        and wl.deleted_at is null
    );
$$;

create or replace function app.accessible_farm_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select f.id from public.farms f
    where app.is_rr_admin() and f.deleted_at is null
  union
  select u.farm_id from public.users u
    where u.id = auth.uid() and u.farm_id is not null and u.active and u.deleted_at is null
  union
  select m.farm_id
    from public.user_farm_memberships m
    join public.users u on u.id = auth.uid() and u.active and u.deleted_at is null
    where m.user_id = auth.uid() and m.active and m.deleted_at is null
  union
  select wl.farm_id
    from public.workshop_links wl
    join public.users u on u.id = auth.uid() and u.active and u.deleted_at is null
    where wl.workshop_id = u.workshop_id and wl.status = 'active' and wl.deleted_at is null;
$$;
