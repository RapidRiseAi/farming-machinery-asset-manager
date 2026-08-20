-- 0508_public_api_and_qr_reissue.sql
-- Two P2 items that share nothing but a migration number: the public REST API
-- (FR-17.3) and re-issuing a QR sticker (FR-9.4).
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 1 — THE PUBLIC API, AND THE ONE PLACE THIS SCHEMA'S RULE DOES NOT HOLD
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- `api_access` has been an entitlement since 0251 and has gated nothing, because there
-- was no API. This migration is the storage half of one.
--
-- ── The problem, stated plainly ──────────────────────────────────────────────
--
-- Every other surface in this product is protected by RLS, and RLS decides through
-- `auth.uid()`. An API token is not a session: nobody has signed in, there is no
-- `auth.users` row behind the request, and therefore `auth.uid()` is NULL. A policy
-- asked to judge an API request has nothing to judge.
--
-- There is an easy answer, and it is the wrong one. We could resolve the token to a
-- user and then
--
--     select set_config('request.jwt.claims', json_build_object('sub', <that user>), true)
--
-- so that every policy fires and every policy passes. That is EXACTLY the shape of
-- `public._f14_probe`, the debugging helper migration 0440 removed from production, and
-- 0440 recorded why it was the more dangerous shape rather than the less: it does not
-- bypass RLS, it moves the caller to the other side of the fence and lets RLS answer
-- correctly for somebody else. Every policy still "passes", so nothing in a policy read
-- looks wrong. Whoever can influence which id goes into that call has, in effect, an
-- impersonation primitive. This migration does not do that, and no code under
-- `src/app/api/v1` does either.
--
-- ── What is done instead, and the boundary it draws ─────────────────────────
--
-- The API path is APP-ENFORCED, not RLS-enforced. That sentence is the point of this
-- header: it is written down rather than glossed, because a reader who assumes the house
-- rule holds everywhere would audit these routes wrongly.
--
-- The enforcement has three parts, and only the first two are in the database:
--
--   1. THE FARM IS DERIVED, NEVER CHOSEN. `app.api_token_resolve` takes a token HASH
--      and returns the farm that token belongs to. It takes no farm argument, so there
--      is no parameter a caller could get wrong or an attacker could supply. A request
--      cannot ask for a farm; it can only present a credential, and the database says
--      which farm that credential is.
--
--   2. THE WRITE PATH IS STRUCTURALLY TENANT-SAFE ANYWAY. The one write endpoint inserts
--      a `meter_readings` row, and `meter_readings_machine_fk` is the composite
--      `(machine_id, farm_id) → machines(id, farm_id)` this schema uses everywhere. A
--      reading whose farm and machine disagree is refused by the DATABASE, not by the
--      route. So even a wholly broken route cannot attach a reading to another farm's
--      machine. (Asserted in G31.)
--
--   3. THE READ PATH GOES THROUGH ONE CHOKEPOINT IN THE APP. `apiSelect()` in
--      `src/lib/api-tokens.ts` is the only function under `/api/v1` that touches the
--      database. It applies `.eq("farm_id", ctx.farmId)` BEFORE the route ever sees a
--      query builder, and supabase-js offers no way to remove a filter once applied, so a
--      route can narrow the query further but cannot widen it. Its table argument is a
--      closed union of six tables, every one of which carries `farm_id` — that is what
--      makes a single filter sufficient, and it is why the union is closed rather than
--      `string`.
--
--   This is weaker than RLS and is not pretended otherwise: it holds because ONE module
--   is correct, where RLS holds even if every module is wrong. It is the price of an API
--   key, and the mitigation is that the module is small, is the only importer of the
--   service client under `/api/v1`, and is proven by test rather than by reading.
--
-- ── Storing the credential ───────────────────────────────────────────────────
--
-- Only a SHA-256 hash of the token is stored, plus a short display prefix so a farm can
-- tell two tokens apart in a list. The token itself is shown once, at creation, and is
-- unrecoverable afterwards — there is no column it could be read back from.
--
-- Plain SHA-256 rather than bcrypt/argon2, deliberately: those exist to make GUESSING a
-- low-entropy human secret expensive. This secret is 32 bytes from a CSPRNG, so guessing
-- is not on the table, and a KDF would add tens of milliseconds to EVERY API request for
-- no gain. What a hash does buy is real, and is the reason it is here: a stolen database
-- backup contains no working credential.

-- ── The API can say where a reading came from ────────────────────────────────
-- `meter_source` has carried the capture channel since 0001 ('qr','job','manual',
-- 'whatsapp') and gained 'app' in 0230. A reading pushed by a third-party system is none
-- of those, and calling it 'manual' would put a machine's meter history in the mouth of a
-- person who never touched it.
alter type meter_source add value if not exists 'api';

-- ── The tokens ───────────────────────────────────────────────────────────────
create table api_tokens (
  id           uuid primary key default gen_random_uuid(),
  farm_id      uuid not null,
  -- What the farm calls it: "Fuel card feed", "Deere telematics".
  name         text not null,
  -- SHA-256 hex of the whole token string. The credential itself is NOT here and is not
  -- anywhere: this column is what a presented token is compared against, and nothing can
  -- be derived from it in the other direction.
  token_hash   text not null,
  -- The first few visible characters ("fwk_9f2aQ1x8"), so a person can match a row to the
  -- value they pasted into somebody else's system without either being able to read it.
  prefix       text not null,
  -- Closed set, enforced below. `read` covers every GET; `write:readings` covers the one
  -- POST. Deliberately coarse — a farm should not be asked to design a permission model.
  scopes       text[] not null default array['read']::text[],
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  -- Stamped by app.api_token_resolve on every successful authentication, so a farm can
  -- see a token nobody uses and retire it. Excluded from the audit trigger (see below).
  last_used_at timestamptz,
  -- Optional. Null = no expiry; a time in the past stops resolving the moment it passes.
  expires_at   timestamptz,
  -- Revocation is a timestamp, not a delete: the audit trail of what a token did is
  -- worth more than the row is worth reclaiming.
  revoked_at   timestamptz,
  revoked_by   uuid references users(id),
  deleted_at   timestamptz,
  deleted_by   uuid,
  constraint api_tokens_farm_fk    foreign key (farm_id) references farms(id),
  constraint api_tokens_id_farm_uq unique (id, farm_id),
  constraint api_tokens_hash_uq    unique (token_hash),
  constraint api_tokens_scopes_ck  check (
    array_length(scopes, 1) between 1 and 8
    and scopes <@ array['read','write:readings']::text[]
  ),
  -- 64 lowercase hex characters. A row that does not look like a SHA-256 digest was
  -- written by something that did not go through the minting path.
  constraint api_tokens_hash_shape_ck   check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint api_tokens_prefix_shape_ck check (prefix ~ '^fwk_[A-Za-z0-9_-]{4,16}$')
);
create index api_tokens_farm_idx on api_tokens (farm_id) where deleted_at is null;

comment on table api_tokens is
  'Farm-scoped API credentials for the public REST API (0508). Only a SHA-256 hash is '
  'stored; the token is displayed once at creation and is unrecoverable. Resolution goes '
  'through app.api_token_resolve, which derives the farm from the token and accepts no '
  'farm argument. See the 0508 header for why the /api/v1 read path is app-enforced '
  'rather than RLS-enforced.';
comment on column api_tokens.token_hash is
  'SHA-256 hex of the token string. Never the token. A stolen backup yields no credential.';
comment on column api_tokens.last_used_at is
  'Stamped by app.api_token_resolve on each successful authentication. Deliberately '
  'outside the audit trigger''s UPDATE OF list — one audit row per API call would drown '
  'the log that exists to record who changed what.';

-- ── RLS: farm side, owner/manager only ───────────────────────────────────────
--
-- Narrower than the usual farm-scoped table in two ways, both on purpose.
--
-- `app.is_farm_side()` excludes a linked CONTRACTOR. `app.has_farm_access` admits one
-- (that is how a partner reaches the farm at all), and F16 settled the principle: a
-- partner sees the narrowest slice that lets them do the work. A farm's API credentials
-- are not part of fixing a tractor, and there is no grant that opens them.
--
-- And READ is narrowed too, unlike stock (0452) where reading stays open to the whole
-- farm side. A parts shelf is a thing to consult; a credential list is a thing to
-- administer. The name, prefix and last-used time of every integration a farm runs is
-- administrative detail, so the same two roles that can create one are the ones who can
-- see one. An operator has no question this table answers.
alter table api_tokens enable row level security;
alter table api_tokens force  row level security;

create policy api_tokens_sel on api_tokens for select to authenticated
  using (app.has_farm_access(farm_id) and app.is_farm_side()
         and app.current_app_role() in ('owner','manager')
         and deleted_at is null);
create policy api_tokens_ins on api_tokens for insert to authenticated
  with check (app.has_farm_access(farm_id) and app.is_farm_side()
              and app.current_app_role() in ('owner','manager'));
create policy api_tokens_upd on api_tokens for update to authenticated
  using (app.has_farm_access(farm_id) and app.is_farm_side()
         and app.current_app_role() in ('owner','manager'))
  with check (app.has_farm_access(farm_id) and app.is_farm_side()
              and app.current_app_role() in ('owner','manager'));
create policy api_tokens_del on api_tokens for delete to authenticated
  using (app.has_farm_access(farm_id) and app.is_farm_side()
         and app.current_app_role() in ('owner','manager'));

grant select, insert, update, delete on public.api_tokens to authenticated;
grant all on public.api_tokens to service_role;

-- ── Audit, with the credential taken out ─────────────────────────────────────
--
-- Two departures from the generic `app_audit()` trigger, following the redaction
-- precedent set for the voice tables:
--
--   * `token_hash` is stripped. The audit log is read by more people, kept for longer and
--     restored from backups more often than the table it describes; there is no reason
--     for a second copy of the comparison value to live there.
--   * `last_used_at` is not in the trigger's UPDATE OF list, so a busy integration does
--     not write an audit row per request. Every change that MEANS something — created,
--     renamed, re-scoped, expiry moved, revoked, deleted — still lands.
create or replace function app.app_api_token_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user  uuid;
  v_diff  jsonb;
  v_strip text[] := array['token_hash'];
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  if tg_op = 'DELETE' then
    v_diff := jsonb_build_object('old', to_jsonb(old) - v_strip);
  elsif tg_op = 'UPDATE' then
    v_diff := jsonb_build_object('old', to_jsonb(old) - v_strip, 'new', to_jsonb(new) - v_strip);
  else
    v_diff := jsonb_build_object('new', to_jsonb(new) - v_strip);
  end if;

  if tg_op = 'DELETE' then
    insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
    values (old.farm_id, v_user, tg_table_name, old.id, 'delete', v_diff);
    return old;
  end if;

  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (new.farm_id, v_user, tg_table_name, new.id, lower(tg_op), v_diff);
  return new;
end $$;

revoke execute on function app.app_api_token_audit() from public, anon, authenticated;

create trigger api_tokens_audit
  after insert
     or delete
     or update of name, scopes, expires_at, revoked_at, revoked_by, deleted_at, deleted_by
  on public.api_tokens
  for each row execute function app.app_api_token_audit();

-- ── Resolution: the only way a token becomes a farm ──────────────────────────
--
-- Takes a hash and returns the farm. Note what it does NOT take: a farm id, a user id,
-- anything at all that a caller could choose. That is the whole security property, and
-- it is why this is not the `_f14_probe` shape — nothing here moves the caller anywhere.
--
-- SECURITY INVOKER (house rule: definer only where needed, and it is not needed here).
-- Execute is granted to `service_role` alone: that role already bypasses RLS, so the
-- function borrows no privilege it did not have, and no signed-in user or anon caller can
-- reach it to fish for hashes.
--
-- It is one statement rather than a select-then-update because the two must not be able
-- to disagree: `last_used_at` is stamped if and only if the token actually authenticated,
-- and a revoked or expired token leaves no trace of a successful use.
--
-- Four rules decide, all here rather than half here and half in a route:
--   * the token exists and is neither soft-deleted nor revoked;
--   * it has not expired;
--   * the farm is live (an inactive or deleted farm's tokens stop working — the same
--     rule the notification engines apply, so a suspended farm goes quiet everywhere);
--   * `api_allowed` reports whether that farm's PLAN unlocks the API, computed with the
--     0251 rank functions so the SQL mirror stays the authority. It is RETURNED rather
--     than filtered on, so the route can answer 403 "upgrade" instead of 401 "unknown
--     token" — a farm that bought the wrong plan should be told that, not told their
--     credential is wrong.
create or replace function app.api_token_resolve(p_token_hash text)
returns table (
  token_id    uuid,
  farm_id     uuid,
  scopes      text[],
  farm_plan   farm_plan,
  api_allowed boolean
)
language sql volatile security invoker set search_path = public, pg_temp as $$
  update public.api_tokens t
     set last_used_at = now()
    from public.farms f
   where f.id = t.farm_id
     and f.deleted_at is null
     and f.status = 'active'
     and t.token_hash = p_token_hash
     and t.deleted_at is null
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
  returning t.id, t.farm_id, t.scopes, f.plan,
            app.plan_rank(f.plan) >= app.feature_min_rank('api_access');
$$;

-- PostgREST only exposes `public`, so the app reaches it through this wrapper. Same
-- privileges, same shape, no extra logic — a second place to get the rules wrong is
-- exactly what this codebase's `public.cron_*` wrappers avoid.
create or replace function public.api_token_resolve(p_token_hash text)
returns table (
  token_id    uuid,
  farm_id     uuid,
  scopes      text[],
  farm_plan   farm_plan,
  api_allowed boolean
)
language sql volatile security invoker set search_path = public, pg_temp as $$
  select * from app.api_token_resolve(p_token_hash);
$$;

revoke execute on function app.api_token_resolve(text)    from public, anon, authenticated;
revoke execute on function public.api_token_resolve(text) from public, anon, authenticated;
grant  execute on function app.api_token_resolve(text)    to service_role;
grant  execute on function public.api_token_resolve(text) to service_role;

comment on function app.api_token_resolve(text) is
  'Token hash -> farm. Takes no farm argument: the farm is DERIVED from the credential '
  'and can never be chosen by a caller. Stamps last_used_at in the same statement, so it '
  'records authentications and nothing else. service_role only.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART 2 — RE-ISSUING A QR STICKER (FR-9.4)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Rotating `machines.public_token` already exists in the app (`reissueQr`, committed
-- 2026-07-28) and its role check lives entirely in a server action:
-- `requireRole(["owner","manager","rr_admin"])`. The UPDATE behind it is governed by
-- `machines_upd`, which is `app.has_farm_access(farm_id)` — so as far as the DATABASE is
-- concerned an OPERATOR, a MECHANIC, or a linked CONTRACTOR may rotate the token by
-- calling PostgREST directly, and every printed sticker on that machine dies.
--
-- That is the shape 0452 was written to close on the parts store: "a server action is a
-- door, and this schema's rule is that the lock is on the table". Same fix, narrower
-- instrument — `machines_upd` legitimately lets a mechanic edit a machine, so the policy
-- is left alone and a trigger guards the ONE column whose change is a re-issue.
--
-- Two more things the trigger does:
--
--   * it writes an explicit `qr_reissue` audit row, so the act is attributable AS a
--     re-issue rather than only inferable by diffing two uuids inside an `update` row;
--   * that row deliberately carries NEITHER the retired nor the new token. The generic
--     `machines` audit trigger already stores both in its diff (pre-existing, and no
--     wider than `machines_sel`, which lets the same people read the live token anyway) —
--     but there is no reason for a second copy under a name that invites reading.
create or replace function app.app_machines_guard_public_token() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid  uuid;
  v_role user_role;
begin
  if new.public_token is not distinct from old.public_token then
    return new;
  end if;

  begin v_uid := auth.uid(); exception when others then v_uid := null; end;

  -- No session at all: a migration, the seed, or a service-role server route. `anon` has
  -- zero table privileges in this schema (0102) and so can never reach an UPDATE here,
  -- and service_role is trusted by definition — it is the role that runs the public QR
  -- flow. There is nobody else in this branch.
  if v_uid is null then
    return new;
  end if;

  -- The role IN THIS FARM. An active membership is authoritative (multi-site, 0340);
  -- the profile's primary-farm role is the fallback for a user with no membership row,
  -- which is how the F7 backfill left every pre-existing account.
  select m.role into v_role
    from public.user_farm_memberships m
   where m.user_id = v_uid and m.farm_id = new.farm_id
     and m.active and m.deleted_at is null
   limit 1;

  if v_role is null then
    select u.role into v_role
      from public.users u
     where u.id = v_uid and u.active and u.deleted_at is null
       and (u.role = 'rr_admin' or u.farm_id = new.farm_id);
  end if;

  if v_role is null or v_role not in ('owner', 'manager', 'rr_admin') then
    raise exception
      'Only an owner or manager may re-issue a QR code for this vehicle'
      using errcode = '42501';
  end if;

  insert into public.audit_log(farm_id, user_id, entity, entity_id, action, diff)
  values (new.farm_id, v_uid, 'machines', new.id, 'qr_reissue',
          jsonb_build_object('machine', new.name, 'at', now()));

  return new;
end $$;

revoke execute on function app.app_machines_guard_public_token() from public, anon, authenticated;

create trigger machines_guard_public_token
  before update of public_token on public.machines
  for each row execute function app.app_machines_guard_public_token();

comment on function app.app_machines_guard_public_token() is
  'FR-9.4. Refuses a public_token rotation from anyone but an owner/manager of that farm '
  '(or rr_admin), and records an explicit qr_reissue audit row. machines_upd stays as it '
  'was, so a mechanic may still edit a machine - only the sticker is locked.';
