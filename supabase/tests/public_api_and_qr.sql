-- ═════════════════════════════════════════════════════════════════════════════
-- G31 — THE PUBLIC API (0508), AND RE-ISSUING A QR STICKER
--
-- Two things are being proved here, and they are not the same kind of thing.
--
-- The QR half is ordinary: a rule that belongs in the database is now in the database,
-- and these assertions are the usual RLS/role/audit shape.
--
-- The API half is not ordinary, and the section is written to say so. An API token is
-- not a session, so `auth.uid()` is null and NO POLICY CAN JUDGE AN API REQUEST. The
-- easy fix — resolve the token to a user and `set_config('request.jwt.claims', …)` —
-- is the `_f14_probe` shape that migration 0440 removed from production, and G11 above
-- already fails the suite for any function that does it. 0508 therefore does something
-- else, and what these assertions can and cannot reach follows from that:
--
--   IN SQL, and asserted here:
--     * the farm is DERIVED from the credential. `app.api_token_resolve` has no farm
--       parameter — asserted against pg_proc, not by reading — so there is no argument
--       a caller could supply to ask for somebody else's farm.
--     * the write path is tenant-safe in the DATABASE. The composite FK
--       `(machine_id, farm_id) → machines(id, farm_id)` refuses a reading whose farm and
--       machine disagree, so even a broken route cannot cross a tenant boundary.
--     * every table the app chokepoint may address carries a NOT NULL `farm_id`. That is
--       the precondition that makes one filter sufficient; if somebody widens the union
--       to a table without it, this fires.
--     * the credential is stored as a hash and appears nowhere in the row.
--     * who may read, create and revoke a token, and who may not.
--
--   NOT IN SQL, and deliberately not pretended otherwise: that no /api/v1 ROUTE can
--   return another farm's row. That is app-enforced, it holds because `apiSelect()` is
--   correct, and it is proved by driving the running API with five kinds of token —
--   valid, revoked, expired, malformed and another farm's. See the mission report.
-- ═════════════════════════════════════════════════════════════════════════════

-- Harness helper, so this section also runs STANDALONE against a freshly migrated
-- database. Identical to the definition at the top of the suite; `_t_`-prefixed, which
-- is the prefix G11 (a) exempts.
create or replace function _t_login(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
$$;
grant execute on function _t_login(uuid) to public;

reset role;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Three farms, because the API decision has three different answers:
--   P  done_for_you + active  → the API works
--   Q  professional + active  → a real token, a real farm, and no entitlement (403, not 401)
--   S  done_for_you + suspended → a real token on a farm that has been switched off
insert into farms (id, name, plan, status) values
  ('8b000000-0000-0000-0000-000000000001', 'Farm P (api)',        'done_for_you', 'active'),
  ('8b000000-0000-0000-0000-000000000002', 'Farm Q (no api)',     'professional', 'active'),
  ('8b000000-0000-0000-0000-000000000003', 'Farm S (suspended)',  'done_for_you', 'suspended');

insert into workshops (id, name) values
  ('8b200000-0000-0000-0000-000000000001', 'Workshop X (api section)');
insert into workshop_links (workshop_id, farm_id, status) values
  ('8b200000-0000-0000-0000-000000000001', '8b000000-0000-0000-0000-000000000001', 'active');

insert into auth.users (id, email) values
  ('8b100000-0000-0000-0000-000000000001', 'ownerP@test'),
  ('8b100000-0000-0000-0000-000000000002', 'managerP@test'),
  ('8b100000-0000-0000-0000-000000000003', 'mechanicP@test'),
  ('8b100000-0000-0000-0000-000000000004', 'driverP@test'),
  ('8b100000-0000-0000-0000-000000000005', 'ownerQ@test'),
  ('8b100000-0000-0000-0000-000000000006', 'workshopX@test');

insert into users (id, farm_id, workshop_id, role, name) values
  ('8b100000-0000-0000-0000-000000000001', '8b000000-0000-0000-0000-000000000001', null, 'owner',    'Owner P'),
  ('8b100000-0000-0000-0000-000000000002', '8b000000-0000-0000-0000-000000000001', null, 'manager',  'Manager P'),
  ('8b100000-0000-0000-0000-000000000003', '8b000000-0000-0000-0000-000000000001', null, 'mechanic', 'Mechanic P'),
  ('8b100000-0000-0000-0000-000000000004', '8b000000-0000-0000-0000-000000000001', null, 'operator', 'Driver P'),
  ('8b100000-0000-0000-0000-000000000005', '8b000000-0000-0000-0000-000000000002', null, 'owner',    'Owner Q'),
  ('8b100000-0000-0000-0000-000000000006', null, '8b200000-0000-0000-0000-000000000001', 'workshop', 'Workshop X Staff');

insert into machines (id, farm_id, name, type, meter_type, status, assigned_operator_id, public_token) values
  ('8b300000-0000-0000-0000-000000000001', '8b000000-0000-0000-0000-000000000001', 'P Tractor',  'tractor', 'hours', 'active',
   '8b100000-0000-0000-0000-000000000004', '8b900000-0000-0000-0000-000000000001'),
  ('8b300000-0000-0000-0000-000000000002', '8b000000-0000-0000-0000-000000000001', 'P Sold Bakkie', 'bakkie', 'km', 'sold', null,
   '8b900000-0000-0000-0000-000000000002'),
  ('8b300000-0000-0000-0000-000000000003', '8b000000-0000-0000-0000-000000000002', 'Q Tractor',  'tractor', 'hours', 'active', null,
   '8b900000-0000-0000-0000-000000000003');

-- The tokens. Raw values are written out here because the whole point of assertion (a)
-- is to look for them in the stored row and not find them. In life they come from a
-- CSPRNG and are never written down anywhere.
insert into api_tokens (id, farm_id, name, token_hash, prefix, scopes, created_by, expires_at, revoked_at) values
  ('8b400000-0000-0000-0000-000000000001', '8b000000-0000-0000-0000-000000000001', 'P live',
   encode(sha256('fwk_TESTliveP_0000000000000000000000000000'::bytea), 'hex'), 'fwk_TESTlive',
   array['read','write:readings']::text[], '8b100000-0000-0000-0000-000000000001', null, null),
  ('8b400000-0000-0000-0000-000000000002', '8b000000-0000-0000-0000-000000000001', 'P revoked',
   encode(sha256('fwk_TESTrevkP_0000000000000000000000000000'::bytea), 'hex'), 'fwk_TESTrevk',
   array['read']::text[], '8b100000-0000-0000-0000-000000000001', null, now() - interval '1 hour'),
  ('8b400000-0000-0000-0000-000000000003', '8b000000-0000-0000-0000-000000000001', 'P expired',
   encode(sha256('fwk_TESTexpdP_0000000000000000000000000000'::bytea), 'hex'), 'fwk_TESTexpd',
   array['read']::text[], '8b100000-0000-0000-0000-000000000001', now() - interval '1 minute', null),
  ('8b400000-0000-0000-0000-000000000004', '8b000000-0000-0000-0000-000000000002', 'Q live',
   encode(sha256('fwk_TESTliveQ_0000000000000000000000000000'::bytea), 'hex'), 'fwk_TESTlivQ',
   array['read']::text[], '8b100000-0000-0000-0000-000000000005', null, null),
  ('8b400000-0000-0000-0000-000000000005', '8b000000-0000-0000-0000-000000000003', 'S live',
   encode(sha256('fwk_TESTliveS_0000000000000000000000000000'::bytea), 'hex'), 'fwk_TESTlivS',
   array['read']::text[], null, null, null);

-- ── (a) The credential is not in the table ───────────────────────────────────
-- Not "token_hash looks like a digest" — the stronger claim, that the raw value appears
-- in NO column of the row. A future column that helpfully caches the token would fail
-- here rather than in a breach report.
do $$ declare hit int; begin
  select count(*) into hit from api_tokens t
   where to_jsonb(t)::text like '%fwk_TESTliveP_0000000000000000000000000000%';
  if hit <> 0 then
    raise exception 'G31 FAIL [PLAINTEXT]: the issued token itself is readable back out of api_tokens';
  end if;

  select count(*) into hit from api_tokens
   where id = '8b400000-0000-0000-0000-000000000001'
     and token_hash = encode(sha256('fwk_TESTliveP_0000000000000000000000000000'::bytea), 'hex');
  if hit <> 1 then
    raise exception 'G31 FAIL [HASH]: the stored hash is not the SHA-256 of the issued token';
  end if;
end $$;

-- ── (b) The farm is DERIVED. There is no argument that could ask for another one ──
-- This is the assertion that distinguishes 0508 from the shape 0440 removed. A function
-- that took (p_token_hash, p_farm) would be a request to trust every caller; one that
-- takes only the credential cannot be asked the wrong question.
do $$ declare v_args text; v_n int; begin
  select p.pronargs, pg_get_function_identity_arguments(p.oid) into v_n, v_args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app' and p.proname = 'api_token_resolve';
  -- Exactly one argument, and it is the credential. A second argument, or a uuid, is a
  -- farm the caller chose; the whole property is that there is nowhere to put one.
  if v_n <> 1 or v_args !~ ' text$' then
    raise exception 'G31 FAIL [DERIVED FARM]: app.api_token_resolve now takes (%) - a token resolver that accepts a farm is a resolver a caller can lie to', v_args;
  end if;
  if v_args ~* 'uuid|farm' then
    raise exception 'G31 FAIL [DERIVED FARM]: app.api_token_resolve takes (%) - the farm must be derived from the credential, never supplied with it', v_args;
  end if;
end $$;

-- ── (c) …and it does not relocate the caller ─────────────────────────────────
-- G11 (a) already sweeps every function in public/app for this. Named here as well,
-- because "we did not build an impersonation primitive" is the single claim the API
-- design rests on, and a claim that lives only in a global sweep is easy to lose.
do $$ declare bad text; begin
  select string_agg(n.nspname || '.' || p.proname, ', ')
    into bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname in ('api_token_resolve', 'app_api_token_audit', 'app_machines_guard_public_token')
     and pg_get_functiondef(p.oid) ilike '%request.jwt.claims%';
  if bad is not null then
    raise exception 'G31 FAIL [_f14_probe SHAPE]: % touches request.jwt.claims. See 0440: it does not bypass RLS, it moves the caller and lets RLS answer for somebody else', bad;
  end if;
end $$;

-- ── (d) A live token resolves to its own farm, and to nothing else ───────────
do $$ declare r record; n int; begin
  select count(*) into n from app.api_token_resolve(encode(sha256('fwk_TESTliveP_0000000000000000000000000000'::bytea), 'hex'));
  if n <> 1 then raise exception 'G31 FAIL: a live token resolved to % rows, not 1', n; end if;

  select * into r from app.api_token_resolve(encode(sha256('fwk_TESTliveP_0000000000000000000000000000'::bytea), 'hex'));
  if r.farm_id <> '8b000000-0000-0000-0000-000000000001' then
    raise exception 'G31 FAIL [WRONG FARM]: Farm P''s token resolved to %', r.farm_id;
  end if;
  if r.token_id <> '8b400000-0000-0000-0000-000000000001' then
    raise exception 'G31 FAIL: resolved the wrong token row';
  end if;
  if not (r.scopes @> array['read','write:readings']::text[]) then
    raise exception 'G31 FAIL [SCOPES]: resolved scopes are % - a route cannot gate what it is not told', r.scopes;
  end if;
  if r.farm_plan <> 'done_for_you' or not r.api_allowed then
    raise exception 'G31 FAIL [ENTITLEMENT]: a done_for_you farm was told it may not use the API';
  end if;
end $$;

-- ── (e) Revoked, expired, unknown and suspended all resolve to NOTHING ───────
-- Four separate reasons, one answer, because the route must not be able to tell them
-- apart either: "revoked" and "never existed" are the same 401 to a caller, which is
-- what stops an API being used to confirm that a stolen token was once real.
do $$ declare n int; begin
  select count(*) into n from app.api_token_resolve(encode(sha256('fwk_TESTrevkP_0000000000000000000000000000'::bytea), 'hex'));
  if n <> 0 then raise exception 'G31 FAIL [REVOKED]: a revoked token still resolves'; end if;

  select count(*) into n from app.api_token_resolve(encode(sha256('fwk_TESTexpdP_0000000000000000000000000000'::bytea), 'hex'));
  if n <> 0 then raise exception 'G31 FAIL [EXPIRED]: an expired token still resolves'; end if;

  select count(*) into n from app.api_token_resolve(encode(sha256('not-a-token-anybody-ever-issued'::bytea), 'hex'));
  if n <> 0 then raise exception 'G31 FAIL [UNKNOWN]: an unissued hash resolved to a farm'; end if;

  select count(*) into n from app.api_token_resolve('');
  if n <> 0 then raise exception 'G31 FAIL [EMPTY]: an empty hash resolved to a farm'; end if;

  select count(*) into n from app.api_token_resolve(encode(sha256('fwk_TESTliveS_0000000000000000000000000000'::bytea), 'hex'));
  if n <> 0 then
    raise exception 'G31 FAIL [SUSPENDED FARM]: a suspended farm''s token still works - switching a farm off must switch off its integrations too';
  end if;
end $$;

-- ── (f) A real token on a farm that did not buy the API ──────────────────────
-- It RESOLVES (the credential is genuine) and reports that the plan does not allow it, so
-- the route can answer 403 upgrade rather than 401 bad credential. Telling a paying
-- customer their key is wrong when their PLAN is wrong sends them looking in the wrong
-- place for a day.
do $$ declare r record; begin
  select * into r from app.api_token_resolve(encode(sha256('fwk_TESTliveQ_0000000000000000000000000000'::bytea), 'hex'));
  if r.token_id is null then
    raise exception 'G31 FAIL: a genuine token on a professional farm did not resolve at all - the route can no longer tell "wrong plan" from "wrong key"';
  end if;
  if r.api_allowed then
    raise exception 'G31 FAIL [ENTITLEMENT]: a professional farm was allowed the API. FR-19.2 puts api_access on done_for_you';
  end if;
  -- …and the answer agrees with the 0251 mirror rather than being a second opinion.
  if r.api_allowed <> (app.plan_rank(r.farm_plan) >= app.feature_min_rank('api_access')) then
    raise exception 'G31 FAIL: api_allowed disagrees with app.plan_rank/app.feature_min_rank - there must be one authority, not two';
  end if;
end $$;

-- ── (g) last_used_at records authentications and only authentications ────────
do $$ declare v_used timestamptz; v_before int; v_after int; begin
  select last_used_at into v_used from api_tokens where id = '8b400000-0000-0000-0000-000000000001';
  if v_used is null then
    raise exception 'G31 FAIL [LAST USED]: a token that resolved four times above has never been used';
  end if;

  select last_used_at into v_used from api_tokens where id = '8b400000-0000-0000-0000-000000000002';
  if v_used is not null then
    raise exception 'G31 FAIL [LAST USED]: a REVOKED token was stamped as used - the column would then read as evidence of an authentication that never happened';
  end if;

  -- …and stamping it does not write an audit row. One row per API call would bury the
  -- log that exists to record who changed what.
  select count(*) into v_before from audit_log
   where entity = 'api_tokens' and entity_id = '8b400000-0000-0000-0000-000000000001';
  perform app.api_token_resolve(encode(sha256('fwk_TESTliveP_0000000000000000000000000000'::bytea), 'hex'));
  select count(*) into v_after from audit_log
   where entity = 'api_tokens' and entity_id = '8b400000-0000-0000-0000-000000000001';
  if v_after <> v_before then
    raise exception 'G31 FAIL [AUDIT FLOOD]: an API call wrote % audit row(s). last_used_at is outside the trigger''s UPDATE OF list for exactly this reason', v_after - v_before;
  end if;
end $$;

-- ── (h) The audit trail exists, and does not carry the credential ────────────
do $$ declare v_diff jsonb; n int; begin
  select count(*) into n from audit_log
   where entity = 'api_tokens' and entity_id = '8b400000-0000-0000-0000-000000000001' and action = 'insert';
  if n <> 1 then
    raise exception 'G31 FAIL [AUDIT]: creating a token wrote % insert rows, not 1', n;
  end if;

  select diff into v_diff from audit_log
   where entity = 'api_tokens' and entity_id = '8b400000-0000-0000-0000-000000000001' and action = 'insert';
  if v_diff -> 'new' ? 'token_hash' then
    raise exception 'G31 FAIL [AUDIT LEAK]: the audit row carries token_hash. The log is read by more people, kept longer and restored more often than the table it describes';
  end if;
  if v_diff -> 'new' ->> 'name' is distinct from 'P live' then
    raise exception 'G31 FAIL [AUDIT]: the audit row was redacted past the point of being an audit row';
  end if;
end $$;

-- ── (i) The chokepoint's precondition, in the schema rather than in a comment ──
-- `apiSelect()` scopes a query with a single `farm_id` filter, and that is only
-- sufficient because every table it may address carries a NOT NULL farm_id. The union in
-- TypeScript is closed; this is what closes it here. Widen it to a table without farm_id
-- and the API stops being tenant-safe silently — unless this fires.
do $$
declare t text; v_notnull boolean;
begin
  foreach t in array array['machines','meter_readings','service_plan_lines','faults','job_cards','cost_entries'] loop
    select a.attnotnull into v_notnull
      from pg_attribute a
     where a.attrelid = ('public.' || t)::regclass and a.attname = 'farm_id' and not a.attisdropped;
    if v_notnull is null then
      raise exception 'G31 FAIL [CHOKEPOINT]: table % has no farm_id column, so apiSelect cannot scope it', t;
    end if;
    if not v_notnull then
      raise exception 'G31 FAIL [CHOKEPOINT]: %.farm_id is nullable - a null farm_id survives `.eq(farm_id, …)` in neither direction reliably', t;
    end if;
    perform 1 from pg_attribute
     where attrelid = ('public.' || t)::regclass and attname = 'deleted_at' and not attisdropped;
    if not found then
      raise exception 'G31 FAIL [CHOKEPOINT]: table % has no deleted_at, so the API would serve soft-deleted rows', t;
    end if;
  end loop;
end $$;

-- ── (j) The WRITE path is tenant-safe in the DATABASE, not in the route ──────
-- The one write endpoint inserts a meter reading. Point the farm at P and the machine at
-- Q's and the composite FK refuses it. This is the assertion that says a wholly broken
-- route still cannot cross a tenant boundary — the direction that matters, because the
-- route is the part that is app-enforced.
do $$ declare ok boolean := false; begin
  begin
    insert into meter_readings (farm_id, machine_id, reading, source)
    values ('8b000000-0000-0000-0000-000000000001', '8b300000-0000-0000-0000-000000000003', 4321, 'api');
  exception when foreign_key_violation then ok := true;
  end;
  if not ok then
    raise exception 'G31 FAIL [CROSS-FARM WRITE]: a reading was attached to another farm''s machine. meter_readings_machine_fk is the composite (machine_id, farm_id) FK and it must refuse this';
  end if;
end $$;

-- …and the honest write, with the API's own source, is accepted and advances the meter
-- through the SAME 0202 trigger every other channel uses. An API that wrote history the
-- service engine could not see would be worse than no API.
do $$ declare v_cur numeric; begin
  insert into meter_readings (farm_id, machine_id, reading, reading_date, source)
  values ('8b000000-0000-0000-0000-000000000001', '8b300000-0000-0000-0000-000000000001', 1234, current_date, 'api');
  select current_reading into v_cur from machines where id = '8b300000-0000-0000-0000-000000000001';
  if v_cur is distinct from 1234 then
    raise exception 'G31 FAIL: an api reading left current_reading at % - the 0202 trigger did not run for this source', v_cur;
  end if;
end $$;

-- ── (k) The scope and shape constraints refuse a row that skipped the minter ──
do $$ declare ok boolean := false; begin
  begin
    insert into api_tokens (farm_id, name, token_hash, prefix, scopes)
    values ('8b000000-0000-0000-0000-000000000001', 'invented scope',
            encode(sha256('x1'::bytea), 'hex'), 'fwk_aaaa', array['read','write:everything']::text[]);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G31 FAIL [SCOPES]: an unknown scope was accepted. A scope nothing enforces reads as a permission that was granted'; end if;

  ok := false;
  begin
    insert into api_tokens (farm_id, name, token_hash, prefix)
    values ('8b000000-0000-0000-0000-000000000001', 'not a digest', 'plaintext-token-value', 'fwk_aaaa');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'G31 FAIL [HASH SHAPE]: token_hash accepted something that is not a SHA-256 digest - which is what storing the token itself would look like'; end if;
end $$;

-- ── (l) Who may see and manage a farm's credentials ──────────────────────────
set role authenticated;

do $$ declare n int; begin
  perform _t_login('8b100000-0000-0000-0000-000000000001');   -- Owner P
  select count(*) into n from api_tokens;
  if n <> 3 then raise exception 'G31 FAIL [OWNER]: Owner P sees % of their own 3 tokens', n; end if;

  perform _t_login('8b100000-0000-0000-0000-000000000002');   -- Manager P
  select count(*) into n from api_tokens;
  if n <> 3 then raise exception 'G31 FAIL [MANAGER]: a manager sees % tokens, not 3 - they administer the farm', n; end if;

  perform _t_login('8b100000-0000-0000-0000-000000000005');   -- Owner Q
  select count(*) into n from api_tokens where farm_id = '8b000000-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'G31 FAIL [CROSS-TENANT]: the neighbour reads % of Farm P''s credentials', n; end if;
  select count(*) into n from api_tokens;
  if n <> 1 then raise exception 'G31 FAIL: Owner Q sees % tokens rather than their own 1', n; end if;

  perform _t_login('8b100000-0000-0000-0000-000000000003');   -- Mechanic P
  select count(*) into n from api_tokens;
  if n <> 0 then
    raise exception 'G31 FAIL [MECHANIC]: a mechanic reads % API credentials. Unlike the parts shelf (0452), this is a thing to administer, not a thing to consult', n;
  end if;

  perform _t_login('8b100000-0000-0000-0000-000000000004');   -- Driver P
  select count(*) into n from api_tokens;
  if n <> 0 then raise exception 'G31 FAIL [OPERATOR]: a driver reads % API credentials', n; end if;

  perform _t_login('8b100000-0000-0000-0000-000000000006');   -- Workshop X, actively linked to Farm P
  select count(*) into n from api_tokens;
  if n <> 0 then
    raise exception 'G31 FAIL [CONTRACTOR]: a linked contractor reads % of the farm''s API credentials. app.has_farm_access admits them; app.is_farm_side is what must not', n;
  end if;
end $$;

-- A mechanic cannot mint one, and cannot revoke one either. Both directions, because a
-- write policy that only guards INSERT leaves revocation open to the same person.
do $$ declare ok boolean := false; v_rows int; begin
  perform _t_login('8b100000-0000-0000-0000-000000000003');
  begin
    insert into api_tokens (farm_id, name, token_hash, prefix)
    values ('8b000000-0000-0000-0000-000000000001', 'mechanic mint',
            encode(sha256('m1'::bytea), 'hex'), 'fwk_mech');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL: a mechanic minted an API credential for the farm'; end if;

  update api_tokens set revoked_at = now() where id = '8b400000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'G31 FAIL: a mechanic revoked % token(s) - revoking somebody''s live integration is an owner''s decision', v_rows;
  end if;
end $$;

-- Cross-tenant write, the classic: a real owner, somebody else's farm.
do $$ declare ok boolean := false; begin
  perform _t_login('8b100000-0000-0000-0000-000000000005');
  begin
    insert into api_tokens (farm_id, name, token_hash, prefix)
    values ('8b000000-0000-0000-0000-000000000001', 'neighbour mint',
            encode(sha256('m2'::bytea), 'hex'), 'fwk_nbor');
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL [CROSS-TENANT WRITE]: Owner Q minted a credential against Farm P'; end if;
end $$;

-- Nobody signed in may run the resolver, whatever their role. It is the one function that
-- turns a hash into a farm; a farm user who could call it could confirm whether a hash
-- they found belongs to anybody.
do $$ declare ok boolean := false; begin
  perform _t_login('8b100000-0000-0000-0000-000000000001');
  begin perform app.api_token_resolve('x'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL: a signed-in owner executed app.api_token_resolve'; end if;

  ok := false;
  begin perform public.api_token_resolve('x'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL: a signed-in owner executed the PostgREST wrapper public.api_token_resolve'; end if;
end $$;

reset role;

-- ── (m) anon reads nothing and executes nothing ──────────────────────────────
set role anon;
do $$ declare ok boolean := false; begin
  begin perform 1 from api_tokens; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL [ANON]: anon reached api_tokens'; end if;
end $$;
reset role;

-- The grants are asserted rather than attempted, because a function with no explicit
-- grant defaults to EXECUTE TO PUBLIC (G11) and an attempt that fails for some OTHER
-- reason would read as a pass.
do $$ declare f text; begin
  foreach f in array array[
    'app.api_token_resolve(text)',
    'public.api_token_resolve(text)',
    'app.app_api_token_audit()',
    'app.app_machines_guard_public_token()'
  ] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'G31 FAIL [ANON EXECUTE]: anon may execute % - the PUBLIC default was never revoked (G11)', f;
    end if;
    if has_function_privilege('authenticated', f, 'EXECUTE') then
      raise exception 'G31 FAIL [AUTHENTICATED EXECUTE]: a signed-in user may execute %', f;
    end if;
  end loop;

  if not has_function_privilege('service_role', 'app.api_token_resolve(text)', 'EXECUTE') then
    raise exception 'G31 FAIL: service_role cannot execute the resolver, so the API cannot authenticate anybody';
  end if;
end $$;

-- ── (n) Privilege flags, measured ────────────────────────────────────────────
-- House rule: SECURITY INVOKER for readers, DEFINER only where it is needed. The
-- resolver needs nothing — service_role already bypasses RLS — so it must not be DEFINER,
-- which would make it a standing privilege escalation if a grant were ever widened.
do $$ declare r record; begin
  for r in
    select n.nspname || '.' || p.proname as fn, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname, p.proname) in (('app','api_token_resolve'), ('public','api_token_resolve'))
  loop
    if r.prosecdef then
      raise exception 'G31 FAIL: % became SECURITY DEFINER. It borrows no privilege it needs, so DEFINER would only widen what a future grant could reach', r.fn;
    end if;
  end loop;

  -- The two triggers are DEFINER by necessity (they write audit_log, which authenticated
  -- may never insert into) and must therefore pin search_path.
  for r in
    select n.nspname || '.' || p.proname as fn, p.prosecdef, p.proconfig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname in ('app_api_token_audit', 'app_machines_guard_public_token')
  loop
    if not r.prosecdef then
      raise exception 'G31 FAIL: % is no longer SECURITY DEFINER, so it can no longer write the audit row it exists to write', r.fn;
    end if;
    if r.proconfig is null or not (r.proconfig::text like '%search_path%') then
      raise exception 'G31 FAIL: % is SECURITY DEFINER with no pinned search_path', r.fn;
    end if;
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- RE-ISSUING A QR STICKER (FR-9.4)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The app has had `reissueQr` since July, guarded by requireRole in a server action.
-- `machines_upd` is `app.has_farm_access(farm_id)`, so the DATABASE was letting an
-- operator, a mechanic or a linked contractor rotate the token and kill every printed
-- sticker on a machine. 0452 settled the principle on the parts store: a server action is
-- a door; the lock belongs on the table.

set role authenticated;

-- ── (o) An owner rotates it, and the old sticker dies the same instant ───────
-- Resolved before and after, because "the column changed" is not the claim. The claim is
-- that the thing printed on a sticker in a shed no longer finds a machine.
do $$ declare v_old uuid; v_new uuid; n int; begin
  perform _t_login('8b100000-0000-0000-0000-000000000001');

  select public_token into v_old from machines where id = '8b300000-0000-0000-0000-000000000001';
  select count(*) into n from machines where public_token = v_old and deleted_at is null;
  if n <> 1 then raise exception 'G31 FAIL [QR]: the sticker did not resolve BEFORE rotation, so the after-test proves nothing'; end if;

  update machines set public_token = gen_random_uuid() where id = '8b300000-0000-0000-0000-000000000001';

  select public_token into v_new from machines where id = '8b300000-0000-0000-0000-000000000001';
  if v_new = v_old then raise exception 'G31 FAIL [QR]: the token did not change'; end if;

  select count(*) into n from machines where public_token = v_old;
  if n <> 0 then
    raise exception 'G31 FAIL [QR]: the RETIRED token still resolves to a machine - a torn-off or photographed sticker would keep working';
  end if;
end $$;

-- ── (p) …and it is attributable, as a re-issue ───────────────────────────────
do $$ declare r record; n int; begin
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = '8b300000-0000-0000-0000-000000000001' and action = 'qr_reissue';
  if n <> 1 then raise exception 'G31 FAIL [QR AUDIT]: % qr_reissue rows for one rotation', n; end if;

  select * into r from audit_log
   where entity = 'machines' and entity_id = '8b300000-0000-0000-0000-000000000001' and action = 'qr_reissue';
  if r.user_id <> '8b100000-0000-0000-0000-000000000001' then
    raise exception 'G31 FAIL [QR AUDIT]: the row names % rather than the owner who pressed it', r.user_id;
  end if;
  if r.farm_id <> '8b000000-0000-0000-0000-000000000001' then
    raise exception 'G31 FAIL [QR AUDIT]: the row is not farm-scoped';
  end if;
  -- It names the act and the machine. It deliberately carries neither token: a log row
  -- called "qr_reissue" invites reading, and the live credential has no business in it.
  if r.diff ? 'old' or r.diff ? 'new' or r.diff::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' then
    raise exception 'G31 FAIL [QR AUDIT]: the qr_reissue row carries a token';
  end if;
end $$;

-- ── (q) Nobody else may do it — and this is the half that was app-only ───────
do $$ declare ok boolean; v_tok uuid; v_now uuid; v_rows integer; begin
  select public_token into v_tok from machines where id = '8b300000-0000-0000-0000-000000000001';

  ok := false;
  perform _t_login('8b100000-0000-0000-0000-000000000003');   -- Mechanic P
  begin
    update machines set public_token = gen_random_uuid() where id = '8b300000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL [QR ROLE]: a mechanic re-issued the QR code'; end if;

  ok := false;
  perform _t_login('8b100000-0000-0000-0000-000000000004');   -- Driver P, the assigned operator
  begin
    update machines set public_token = gen_random_uuid() where id = '8b300000-0000-0000-0000-000000000001';
  exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'G31 FAIL [QR ROLE]: the assigned driver re-issued the QR code, invalidating every sticker on it'; end if;

  ok := false;
  perform _t_login('8b100000-0000-0000-0000-000000000006');   -- Workshop X, active link
  begin
    update machines set public_token = gen_random_uuid() where id = '8b300000-0000-0000-0000-000000000001';
    get diagnostics v_rows = row_count;
    if v_rows = 0 then ok := true; end if;
  exception when insufficient_privilege then ok := true; end;
  if not ok then
    raise exception 'G31 FAIL [QR ROLE]: a linked contractor re-issued the farm''s QR code. app.has_farm_access admits them to machines_upd, which is exactly why the guard exists';
  end if;

  perform _t_login('8b100000-0000-0000-0000-000000000001');
  select public_token into v_now from machines where id = '8b300000-0000-0000-0000-000000000001';
  if v_now <> v_tok then raise exception 'G31 FAIL [QR ROLE]: one of the refused rotations landed anyway'; end if;
end $$;

-- The neighbour is refused by RLS rather than by the trigger: zero rows, no exception.
-- Worth separating, because a guard that raised here would be answering a question RLS
-- had already answered, and would leak that the machine exists.
do $$ declare v_rows int; begin
  perform _t_login('8b100000-0000-0000-0000-000000000005');
  update machines set public_token = gen_random_uuid() where id = '8b300000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then raise exception 'G31 FAIL [QR CROSS-TENANT]: the neighbour rotated % of Farm P''s stickers', v_rows; end if;
end $$;

-- ── (r) The policy was NOT tightened — a mechanic still edits machines ───────
-- The failure mode of a fix like this is collateral: lock the sticker, lock the mechanic
-- out of the vehicle record. `machines_upd` is untouched and must stay untouched.
do $$ declare v_rows int; begin
  perform _t_login('8b100000-0000-0000-0000-000000000003');
  update machines set location = 'Shed 4' where id = '8b300000-0000-0000-0000-000000000001';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'G31 FAIL [COLLATERAL]: a mechanic can no longer edit a machine. Only the public_token column was meant to narrow';
  end if;
end $$;

-- ── (s) A retired or sold machine can still be re-stickered ──────────────────
-- Deliberately not excluded. Retired/sold machines are out of counts, reports and alerts
-- (Scope §4.1) — but a sold bakkie still on the yard, or a retired one being disposed of,
-- can still have a damaged label, and refusing here would be a rule applied to the wrong
-- question.
do $$ declare v_rows int; begin
  perform _t_login('8b100000-0000-0000-0000-000000000001');
  update machines set public_token = gen_random_uuid() where id = '8b300000-0000-0000-0000-000000000002';
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then raise exception 'G31 FAIL: an owner could not re-sticker a sold vehicle'; end if;
end $$;

reset role;

select 'ALL G31 PUBLIC-API + QR-REISSUE TESTS PASSED' as result;
