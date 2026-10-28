-- The activity log never shows a reader more than the source table would
-- (20261028090000 to 20261028092500).
--
-- What has to hold, and what each section proves:
--   (a) every table whose trigger writes audit_log has a decided rule, so a new audited
--       table cannot inherit "filed under the farm" by accident;
--   (b) a card's Paystack authorization code and email, withheld from every signed-in role
--       by the column grant, are in no audit row at all, and the card's rows are filed for
--       Rapid Rise only;
--   (c) a farm owner, a mechanic, a cost-visible operator and a linked contractor read no
--       support ticket evidence, no notification, no billing row, no membership change;
--   (d) ordinary audited tables (machines, job cards, cost entries, the team) still audit
--       fully for the farm's owner and mechanic, minus the columns the grant withholds, and
--       a finance-only edit still shows as an edit ("withheld" names it, never its value);
--   (e) an operator and a contractor read the history of the vehicles they can see and of
--       nothing else (no other vehicle, no costs, no team);
--   (f) another farm reads nothing; Rapid Rise still reads what it should (the dossier,
--       which it can read in the table too) but not the withheld credential;
--   (g) the door covers every writer: a hand-written row is stripped and refiled, a named
--       event that is not a table passes untouched, an unclassified table fails closed;
--   (h) the backfill strips and refiles legacy rows, links older Rapid Rise rows to their
--       farm, records what it did, and changes nothing on a second run;
--   (i) the new helpers are not executable by anon or signed-in users;
--   (j) a failing redaction never stops the write it audits (last: it breaks a helper);
--   (k) the cross-farm data-subject guard still sees a person's refiled history (run before
--       (j), which breaks a helper).

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _ar_login(p_user uuid, p_aal text default 'aal1')
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text,
    false
  );
$$;
grant execute on function _ar_login(uuid, text) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

-- == (a) Every audited table has a decided rule ==============================================
do $$
declare v_missing text; v_bad text;
begin
  select string_agg(distinct c.relname, ', ' order by c.relname)
    into v_missing
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal
     and c.relnamespace = 'public'::regnamespace
     and c.relname <> 'audit_log'
     and (p.proname = 'app_audit' or p.prosrc ~* 'insert\s+into\s+(public\.)?audit_log')
     and not exists (select 1 from app.audit_table_rules r where r.table_name = c.relname);
  if v_missing is not null then
    raise exception 'AUDIT RULES FAIL [a]: these tables write audit_log but have no rule in '
      'app.audit_table_rules (decide farm or rapid_rise in a migration, see 20261028090000): %',
      v_missing;
  end if;

  -- A 'farm' rule only makes sense for a table that has a farm.
  select string_agg(r.table_name, ', ' order by r.table_name)
    into v_bad
    from app.audit_table_rules r
   where r.scope = 'farm'
     and not exists (
       select 1 from pg_attribute a
        where a.attrelid = to_regclass('public.' || quote_ident(r.table_name))
          and a.attname = 'farm_id' and not a.attisdropped);
  if v_bad is not null then
    raise exception 'AUDIT RULES FAIL [a]: farm rule on a table with no farm_id: %', v_bad;
  end if;

  if (select count(*) from app.audit_table_rules) < 82 then
    raise exception 'AUDIT RULES FAIL [a]: expected the 82 tables enumerated in 20261028090000, found %',
      (select count(*) from app.audit_table_rules);
  end if;
end $$;

-- == Fixtures (suite role, RLS bypassed) =====================================================
-- Farm A shows costs to operators, so its operator is one of the readers the old policy let
-- read the whole log. Farm B is somebody else.
insert into public.farms (id, name, plan, status, settings) values
  ('ad000000-0000-4000-8000-000000000001', 'Audit Farm A', 'complete', 'active',
   '{"cost_visible_to_operators": true}'::jsonb),
  ('ad000000-0000-4000-8000-000000000002', 'Audit Farm B', 'complete', 'active', '{}'::jsonb);

insert into public.workshops (id, name) values
  ('ad200000-0000-4000-8000-000000000001', 'Audit Contractor');

insert into auth.users (id, email) values
  ('ad100000-0000-4000-8000-000000000001', 'audit-owner@example.test'),
  ('ad100000-0000-4000-8000-000000000002', 'audit-mechanic@example.test'),
  ('ad100000-0000-4000-8000-000000000003', 'audit-operator@example.test'),
  ('ad100000-0000-4000-8000-000000000004', 'audit-contractor@example.test'),
  ('ad100000-0000-4000-8000-000000000005', 'audit-admin@example.test'),
  ('ad100000-0000-4000-8000-000000000006', 'audit-other-owner@example.test'),
  ('ad100000-0000-4000-8000-000000000007', 'audit-manager@example.test');

insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('ad100000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001', null,
   'owner', 'Audit Owner', 'audit-owner@example.test'),
  ('ad100000-0000-4000-8000-000000000002', 'ad000000-0000-4000-8000-000000000001', null,
   'mechanic', 'Audit Mechanic', 'audit-mechanic@example.test'),
  ('ad100000-0000-4000-8000-000000000003', 'ad000000-0000-4000-8000-000000000001', null,
   'operator', 'Audit Operator', 'audit-operator@example.test'),
  ('ad100000-0000-4000-8000-000000000004', null, 'ad200000-0000-4000-8000-000000000001',
   'workshop', 'Audit Contractor', 'audit-contractor@example.test'),
  ('ad100000-0000-4000-8000-000000000005', null, null,
   'rr_admin', 'Audit Admin', 'audit-admin@example.test'),
  ('ad100000-0000-4000-8000-000000000006', 'ad000000-0000-4000-8000-000000000002', null,
   'owner', 'Other Owner', 'audit-other-owner@example.test');

-- A bare link: no vehicles, history, costs or team scope.
insert into public.workshop_links
  (workshop_id, farm_id, status, see_all_vehicles, see_service_history, see_costs, see_team)
values
  ('ad200000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001', 'active',
   false, false, false, false);

-- Vehicle 1 is the operator's and carries the contractor's job; vehicle 2 is neither's.
insert into public.machines (id, farm_id, name, type, assigned_operator_id, purchase_date, purchase_price_cents, supplier) values
  ('ad300000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
   'Audit Tractor One', 'tractor', 'ad100000-0000-4000-8000-000000000003', current_date, 123400, 'Supplier One'),
  ('ad300000-0000-4000-8000-000000000002', 'ad000000-0000-4000-8000-000000000001',
   'Audit Tractor Two', 'tractor', null, current_date, 567800, 'Supplier Two'),
  ('ad300000-0000-4000-8000-000000000003', 'ad000000-0000-4000-8000-000000000002',
   'Other Farm Tractor', 'tractor', null, current_date, 99900, 'Supplier Three');

insert into public.work_requests (id, farm_id, machine_id, workshop_id, title) values
  ('ad400000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
   'ad300000-0000-4000-8000-000000000001', 'ad200000-0000-4000-8000-000000000001', 'Audit job');

-- A card on file. The code is assembled so no credential-shaped literal is committed.
insert into public.billing_payment_methods
  (id, farm_id, provider, authorization_code, authorization_email, reusable, card_brand, last4, is_default, status)
values
  ('ad500000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001', 'paystack',
   'AUTH' || '_' || 'adredactmarker1', 'card.holder.marker@example.test', true, 'visa', '4242', true, 'active');
update public.billing_payment_methods
   set authorization_code = 'AUTH' || '_' || 'adredactmarker2', last4 = '4343'
 where id = 'ad500000-0000-4000-8000-000000000001';

-- A dispute with the kind of dossier the billing builder writes.
insert into public.support_tickets (id, kind, status, farm_id, subject, evidence) values
  ('ad600000-0000-4000-8000-000000000001', 'dispute', 'open', 'ad000000-0000-4000-8000-000000000001',
   'Chargeback marker',
   '{"owner": {"phone": "DOSSIER-PHONE-MARKER", "email": "dossier.owner.marker@example.test"},
     "card": {"brand": "visa", "last4": "4242", "bank": "DOSSIER-BANK-MARKER"}}'::jsonb);

-- One notification to the operator, one to Rapid Rise about the farm.
insert into public.notifications (id, farm_id, user_id, channel, template, payload) values
  ('ad700000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
   'ad100000-0000-4000-8000-000000000003', 'inapp', 'service_due', '{"note": "NOTE-OPERATOR-MARKER"}'::jsonb),
  ('ad700000-0000-4000-8000-000000000002', 'ad000000-0000-4000-8000-000000000001',
   'ad100000-0000-4000-8000-000000000005', 'inapp', 'billing_dispute', '{"note": "NOTE-STAFF-MARKER"}'::jsonb);

-- A membership (owner and manager only).
insert into public.users (id, farm_id, role, name, email) values
  ('ad100000-0000-4000-8000-000000000007', 'ad000000-0000-4000-8000-000000000002',
   'manager', 'Audit Manager', 'audit-manager@example.test');
insert into public.user_farm_memberships (user_id, farm_id, role, active) values
  ('ad100000-0000-4000-8000-000000000007', 'ad000000-0000-4000-8000-000000000001', 'manager', true);

-- Ordinary farm activity: a vehicle edit that changes a name and a price, a job card whose
-- line moves the withheld totals, a cost, and a team member's phone.
update public.machines
   set name = 'Audit Tractor One Renamed', purchase_price_cents = 223400
 where id = 'ad300000-0000-4000-8000-000000000001';
update public.machines
   set purchase_price_cents = 667800
 where id = 'ad300000-0000-4000-8000-000000000002';
insert into public.job_cards (id, farm_id, machine_id, type) values
  ('ad800000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
   'ad300000-0000-4000-8000-000000000001', 'repair');
insert into public.job_card_lines (id, farm_id, job_card_id, kind, description, qty, unit_cost_cents) values
  ('ad810000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
   'ad800000-0000-4000-8000-000000000001', 'part', 'Audit filter', 2, 1500);
insert into public.cost_entries (id, farm_id, machine_id, type, amount_cents, note) values
  ('ad900000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001',
   'ad300000-0000-4000-8000-000000000002', 'other', 4200, 'COST-ENTRY-MARKER');
update public.users set phone = 'TEAM-PHONE-MARKER'
 where id = 'ad100000-0000-4000-8000-000000000002';

-- == (b) The credential is nowhere; the card is Rapid Rise's ================================
do $$
declare n bigint; r record;
begin
  select count(*) into n from audit_log
   where position('adredactmarker' in diff::text) > 0
      or position('card.holder.marker' in diff::text) > 0;
  if n <> 0 then
    raise exception 'AUDIT FAIL [b]: % audit rows still carry the card authorization code or email', n;
  end if;

  select count(*) into n from audit_log
   where entity = 'billing_payment_methods' and entity_id = 'ad500000-0000-4000-8000-000000000001';
  if n <> 2 then
    raise exception 'AUDIT FAIL [b]: expected the card''s insert and update rows, found %', n;
  end if;

  for r in
    select * from audit_log
     where entity = 'billing_payment_methods' and entity_id = 'ad500000-0000-4000-8000-000000000001'
  loop
    if r.farm_id is not null then
      raise exception 'AUDIT FAIL [b]: a card row is filed under farm % (owner-only table)', r.farm_id;
    end if;
    if r.about_farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid then
      raise exception 'AUDIT FAIL [b]: the card row lost the farm it is about (%)', r.about_farm_id;
    end if;
    if (r.diff -> 'new' ->> 'last4') is null then
      raise exception 'AUDIT FAIL [b]: the card row was redacted past being an audit row: %', r.diff;
    end if;
  end loop;

  select count(*) into n from audit_log
   where entity = 'billing_payment_methods' and action = 'update'
     and entity_id = 'ad500000-0000-4000-8000-000000000001'
     and diff -> 'withheld' ? 'authorization_code'
     and not (diff -> 'withheld' ? 'authorization_email');
  if n <> 1 then
    raise exception 'AUDIT FAIL [b]: the update should name the changed authorization_code (and only '
      'what changed) under withheld';
  end if;
end $$;

-- == (c) and (d), the owner ==================================================================
set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000001');
do $$
declare n bigint; v_diff jsonb;
begin
  select count(*) into n from audit_log
   where entity in ('billing_payment_methods', 'support_tickets', 'notifications',
                    'user_farm_memberships');
  if n <> 0 then
    raise exception 'AUDIT FAIL [c owner]: the owner read % rows of tables narrower than the log', n;
  end if;
  select count(*) into n from audit_log
   where position('DOSSIER' in diff::text) > 0 or position('NOTE-' in diff::text) > 0
      or position('adredactmarker' in diff::text) > 0;
  if n <> 0 then
    raise exception 'AUDIT FAIL [c owner]: % readable rows carry dossier, notification or card content', n;
  end if;

  -- (d) still a full record of the farm's own activity.
  select count(*) into n from audit_log
   where entity = 'machines'
     and entity_id in ('ad300000-0000-4000-8000-000000000001', 'ad300000-0000-4000-8000-000000000002');
  if n < 4 then
    raise exception 'AUDIT FAIL [d owner]: expected both vehicles'' inserts and edits, read %', n;
  end if;
  select count(*) into n from audit_log where entity = 'job_cards'
     and entity_id = 'ad800000-0000-4000-8000-000000000001';
  if n < 2 then raise exception 'AUDIT FAIL [d owner]: job card history missing (% rows)', n; end if;
  select count(*) into n from audit_log where entity = 'job_card_lines'
     and entity_id = 'ad810000-0000-4000-8000-000000000001'
     and diff -> 'new' ->> 'description' = 'Audit filter';
  if n < 1 then raise exception 'AUDIT FAIL [d owner]: job card line history missing'; end if;
  select count(*) into n from audit_log where entity = 'cost_entries'
     and entity_id = 'ad900000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'AUDIT FAIL [d owner]: cost entry history missing'; end if;
  select count(*) into n from audit_log where entity = 'users'
     and entity_id = 'ad100000-0000-4000-8000-000000000002' and action = 'update'
     and diff -> 'new' ->> 'phone' = 'TEAM-PHONE-MARKER';
  if n <> 1 then raise exception 'AUDIT FAIL [d owner]: the team change is missing'; end if;

  -- The vehicle edit: the name is there, the price is not, and the price change is named.
  select diff into v_diff from audit_log
   where entity = 'machines' and action = 'update'
     and entity_id = 'ad300000-0000-4000-8000-000000000001'
     and diff -> 'new' ->> 'name' = 'Audit Tractor One Renamed';
  if v_diff is null then
    raise exception 'AUDIT FAIL [d owner]: the vehicle rename is not in the log';
  end if;
  if (v_diff -> 'new') ? 'purchase_price_cents' or (v_diff -> 'old') ? 'purchase_price_cents'
     or (v_diff -> 'new') ? 'supplier' then
    raise exception 'AUDIT FAIL [d owner]: a column the grant withholds was copied: %', v_diff;
  end if;
  if not (v_diff -> 'withheld' ? 'purchase_price_cents') then
    raise exception 'AUDIT FAIL [d owner]: the price change is not named under withheld: %', v_diff;
  end if;
  if v_diff -> 'withheld' ? 'supplier' then
    raise exception 'AUDIT FAIL [d owner]: withheld names a column that did not change';
  end if;

  -- A finance-only edit keeps an event: nothing visible changed, the price is named.
  select count(*) into n from audit_log
   where entity = 'machines' and action = 'update'
     and entity_id = 'ad300000-0000-4000-8000-000000000002'
     and diff -> 'withheld' ? 'purchase_price_cents';
  if n <> 1 then
    raise exception 'AUDIT FAIL [d owner]: a finance-only edit left no named event';
  end if;

  -- The job card's totals moved when its line was added: named, never valued.
  select count(*) into n from audit_log
   where entity = 'job_cards' and action = 'update'
     and entity_id = 'ad800000-0000-4000-8000-000000000001'
     and diff -> 'withheld' ? 'total_cents'
     and not ((diff -> 'new') ? 'total_cents');
  if n < 1 then
    raise exception 'AUDIT FAIL [d owner]: the job card totals were copied or not named';
  end if;
  select count(*) into n from audit_log
   where entity = 'job_card_lines' and ((diff -> 'new') ? 'unit_cost_cents' or (diff -> 'new') ? 'total_cents');
  if n <> 0 then
    raise exception 'AUDIT FAIL [d owner]: job card line money was copied into % rows', n;
  end if;
end $$;
reset role;

-- == (c) and (d), the mechanic ===============================================================
set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000002');
do $$
declare n bigint;
begin
  select count(*) into n from audit_log
   where entity in ('billing_payment_methods', 'support_tickets', 'notifications',
                    'user_farm_memberships')
      or position('DOSSIER' in diff::text) > 0 or position('NOTE-' in diff::text) > 0
      or position('adredactmarker' in diff::text) > 0;
  if n <> 0 then
    raise exception 'AUDIT FAIL [c mechanic]: the mechanic read % narrower rows', n;
  end if;
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000002';
  if n < 2 then raise exception 'AUDIT FAIL [d mechanic]: the farm''s vehicle history is missing'; end if;
  select count(*) into n from audit_log where entity = 'job_cards'
     and entity_id = 'ad800000-0000-4000-8000-000000000001';
  if n < 2 then raise exception 'AUDIT FAIL [d mechanic]: job card history missing'; end if;
end $$;
reset role;

-- == (c) and (e), the contractor =============================================================
set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000004');
do $$
declare n bigint;
begin
  -- The table itself: vehicle one (its job), not vehicle two (no vehicles scope).
  select count(*) into n from machines where id = 'ad300000-0000-4000-8000-000000000001';
  if n <> 1 then raise exception 'AUDIT SETUP [e contractor]: cannot see its own job''s vehicle'; end if;
  select count(*) into n from machines where id = 'ad300000-0000-4000-8000-000000000002';
  if n <> 0 then raise exception 'AUDIT SETUP [e contractor]: sees a vehicle its link does not show'; end if;

  select count(*) into n from audit_log
   where entity in ('billing_payment_methods', 'support_tickets', 'notifications',
                    'user_farm_memberships')
      or position('DOSSIER' in diff::text) > 0 or position('NOTE-' in diff::text) > 0
      or position('adredactmarker' in diff::text) > 0;
  if n <> 0 then
    raise exception 'AUDIT FAIL [c contractor]: a linked contractor read % narrower rows', n;
  end if;

  -- (e) its vehicle's history, without the price.
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000001';
  if n < 2 then
    raise exception 'AUDIT FAIL [e contractor]: lost the history of a vehicle it can see (% rows)', n;
  end if;
  select count(*) into n from audit_log
   where entity = 'machines' and (diff -> 'new') ? 'purchase_price_cents';
  if n <> 0 then raise exception 'AUDIT FAIL [e contractor]: read a vehicle price through the log'; end if;

  -- ...and nothing its link does not show: other vehicles, costs, the team, job cards.
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000002';
  if n <> 0 then
    raise exception 'AUDIT FAIL [e contractor]: read % history rows of a vehicle it cannot see', n;
  end if;
  select count(*) into n from audit_log where entity in ('cost_entries', 'users', 'job_card_lines');
  if n <> 0 then
    raise exception 'AUDIT FAIL [e contractor]: a bare link read % cost, team or line rows', n;
  end if;
  select count(*) into n from audit_log where entity <> 'machines';
  if n <> 0 then
    raise exception 'AUDIT FAIL [e contractor]: read % rows beyond vehicle history', n;
  end if;
end $$;
reset role;

-- == (c) and (e), the operator on a farm that shows costs ====================================
set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000003');
do $$
declare n bigint;
begin
  select count(*) into n from audit_log
   where entity in ('billing_payment_methods', 'support_tickets', 'notifications',
                    'user_farm_memberships')
      or position('DOSSIER' in diff::text) > 0 or position('NOTE-' in diff::text) > 0;
  if n <> 0 then
    raise exception 'AUDIT FAIL [c operator]: the operator read % narrower rows (even its own '
      'notification belongs in the notification list, not in a farm-wide log)', n;
  end if;
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000001';
  if n < 2 then raise exception 'AUDIT FAIL [e operator]: lost its own vehicle''s history'; end if;
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000002';
  if n <> 0 then
    raise exception 'AUDIT FAIL [e operator]: read the history of a vehicle not assigned to it';
  end if;
  select count(*) into n from audit_log where entity <> 'machines';
  if n <> 0 then
    raise exception 'AUDIT FAIL [e operator]: read % rows beyond its vehicle''s history', n;
  end if;
end $$;
reset role;

-- == (f) Another farm reads nothing of this one ==============================================
set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000006');
do $$
declare n bigint;
begin
  select count(*) into n from audit_log
   where farm_id = 'ad000000-0000-4000-8000-000000000001'
      or about_farm_id = 'ad000000-0000-4000-8000-000000000001'
      or entity_id in ('ad300000-0000-4000-8000-000000000001', 'ad300000-0000-4000-8000-000000000002');
  if n <> 0 then raise exception 'AUDIT FAIL [f]: another farm''s owner read % rows', n; end if;
  select count(*) into n from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000003';
  if n < 1 then raise exception 'AUDIT FAIL [f]: the other owner lost its own vehicle''s history'; end if;
end $$;
reset role;

-- == (f) Rapid Rise reads what it should =====================================================
set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000005', 'aal2');
do $$
declare n bigint;
begin
  if not app.is_rr_admin() then
    raise exception 'AUDIT SETUP [f]: the admin fixture is not Rapid Rise';
  end if;
  select count(*) into n from audit_log
   where entity = 'support_tickets' and entity_id = 'ad600000-0000-4000-8000-000000000001'
     and position('DOSSIER-PHONE-MARKER' in diff::text) > 0
     and about_farm_id = 'ad000000-0000-4000-8000-000000000001';
  if n <> 1 then
    raise exception 'AUDIT FAIL [f admin]: Rapid Rise cannot read the dispute it works (% rows)', n;
  end if;
  select count(*) into n from audit_log
   where entity = 'notifications' and about_farm_id = 'ad000000-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'AUDIT FAIL [f admin]: Rapid Rise reads % of 2 notification rows', n; end if;
  select count(*) into n from audit_log
   where entity = 'billing_payment_methods' and about_farm_id = 'ad000000-0000-4000-8000-000000000001';
  if n <> 2 then raise exception 'AUDIT FAIL [f admin]: Rapid Rise reads % of 2 card rows', n; end if;
  select count(*) into n from audit_log where position('adredactmarker' in diff::text) > 0;
  if n <> 0 then
    raise exception 'AUDIT FAIL [f admin]: the credential is withheld from Rapid Rise in the table, '
      'so it must not be readable in the log either';
  end if;
  select count(*) into n from audit_log
   where entity = 'machines' and farm_id = 'ad000000-0000-4000-8000-000000000001';
  if n < 4 then raise exception 'AUDIT FAIL [f admin]: Rapid Rise lost farm rows'; end if;

  -- A support-access record stays the farm's to see.
  perform public.log_admin_farm_access('ad000000-0000-4000-8000-000000000001', 'impersonate');
end $$;
reset role;

set role authenticated;
select _ar_login('ad100000-0000-4000-8000-000000000001');
do $$
declare n bigint;
begin
  select count(*) into n from audit_log
   where entity = 'admin_farm_access' and farm_id = 'ad000000-0000-4000-8000-000000000001';
  if n <> 1 then
    raise exception 'AUDIT FAIL [f]: the owner cannot see that Rapid Rise opened the farm (%)', n;
  end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- == (g) The door covers every writer ========================================================
-- A hand-written row for a narrower table: stripped and refiled, whoever wrote it.
insert into audit_log (farm_id, entity, entity_id, action, diff) values
  ('ad000000-0000-4000-8000-000000000001', 'billing_payment_methods',
   'ad500000-0000-4000-8000-000000000001', 'update',
   jsonb_build_object(
     'old', jsonb_build_object('authorization_code', 'AUTH' || '_' || 'adhandmarker1', 'last4', '4242'),
     'new', jsonb_build_object('authorization_code', 'AUTH' || '_' || 'adhandmarker2', 'last4', '4242')));
-- A named event that is not a table: its writer chose the farm and the keys.
insert into audit_log (farm_id, entity, entity_id, action, diff) values
  ('ad000000-0000-4000-8000-000000000001', 'ad_named_event',
   'ad000000-0000-4000-8000-000000000001', 'view', '{"by": "suite"}'::jsonb);

do $$
declare r record;
begin
  select * into r from audit_log
   where entity = 'billing_payment_methods' and position('adhandmarker' in diff::text) > 0;
  if found then
    raise exception 'AUDIT FAIL [g]: a hand-written row kept the withheld credential';
  end if;
  select * into r from audit_log
   where entity = 'billing_payment_methods' and diff -> 'withheld' ? 'authorization_code'
     and diff -> 'new' ->> 'last4' = '4242' and diff -> 'old' ->> 'last4' = '4242';
  if not found or r.farm_id is not null
     or r.about_farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'AUDIT FAIL [g]: a hand-written card row was not stripped and refiled';
  end if;
  select * into r from audit_log where entity = 'ad_named_event';
  if r.farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid
     or r.about_farm_id is not null or r.diff <> '{"by": "suite"}'::jsonb then
    raise exception 'AUDIT FAIL [g]: a named event was changed by the door: %', row_to_json(r);
  end if;
end $$;

-- An audited table nobody has classified yet is filed for Rapid Rise (fail closed).
create table public.ad_unclassified (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid,
  note text
);
create trigger ad_unclassified_audit after insert or update or delete on public.ad_unclassified
  for each row execute function app_audit();
insert into public.ad_unclassified (id, farm_id, note) values
  ('adb00000-0000-4000-8000-000000000001', 'ad000000-0000-4000-8000-000000000001', 'UNCLASSIFIED');
do $$
declare r record;
begin
  select * into r from audit_log where entity = 'ad_unclassified';
  if not found then raise exception 'AUDIT FAIL [g]: an unclassified table was not audited'; end if;
  if r.farm_id is not null or r.about_farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'AUDIT FAIL [g]: an unclassified table was filed under farm % (must fail closed)', r.farm_id;
  end if;
end $$;
drop table public.ad_unclassified;

-- == (h) The backfill ========================================================================
-- Legacy rows as app_audit() wrote them before 20261028091000, put in behind the door.
alter table public.audit_log disable trigger audit_log_file;
insert into audit_log (farm_id, entity, entity_id, action, diff) values
  ('ad000000-0000-4000-8000-000000000001', 'billing_payment_methods',
   'ad500000-0000-4000-8000-000000000009', 'insert',
   jsonb_build_object('new', jsonb_build_object(
     'id', 'ad500000-0000-4000-8000-000000000009', 'farm_id', 'ad000000-0000-4000-8000-000000000001',
     'authorization_code', 'AUTH' || '_' || 'adlegacymarker', 'authorization_email', 'legacy.marker@example.test',
     'last4', '1111'))),
  ('ad000000-0000-4000-8000-000000000001', 'support_tickets',
   'ad600000-0000-4000-8000-000000000009', 'insert',
   '{"new": {"farm_id": "ad000000-0000-4000-8000-000000000001", "evidence": {"owner": {"phone": "LEGACY-DOSSIER"}}}}'::jsonb),
  ('ad000000-0000-4000-8000-000000000001', 'machines',
   'ad300000-0000-4000-8000-000000000002', 'update',
   '{"old": {"name": "Audit Tractor Two", "purchase_price_cents": 1, "supplier": "S"},
     "new": {"name": "Audit Tractor Two", "purchase_price_cents": 2, "supplier": "S"}}'::jsonb),
  (null, 'farms', 'ad000000-0000-4000-8000-000000000001', 'update',
   '{"old": {"name": "Audit Farm A"}, "new": {"name": "Audit Farm A"}}'::jsonb);
alter table public.audit_log enable trigger audit_log_file;

do $$
declare n bigint; r record; v_runs bigint;
begin
  select count(*) into v_runs from app.audit_redaction_runs;
  perform * from app.audit_redact_existing();

  select count(*) into n from audit_log
   where position('adlegacymarker' in diff::text) > 0 or position('legacy.marker' in diff::text) > 0;
  if n <> 0 then raise exception 'AUDIT FAIL [h]: the backfill left a legacy credential in % rows', n; end if;

  select * into r from audit_log
   where entity = 'billing_payment_methods' and entity_id = 'ad500000-0000-4000-8000-000000000009';
  if r.farm_id is not null or r.about_farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid
     or r.diff -> 'new' ->> 'last4' is distinct from '1111' then
    raise exception 'AUDIT FAIL [h]: the legacy card row was not refiled intact: %', row_to_json(r);
  end if;

  select * into r from audit_log
   where entity = 'support_tickets' and entity_id = 'ad600000-0000-4000-8000-000000000009';
  if r.farm_id is not null or r.about_farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'AUDIT FAIL [h]: the legacy dossier is still filed under the farm';
  end if;

  select * into r from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000002'
     and diff -> 'old' ->> 'name' = 'Audit Tractor Two' and diff ? 'withheld'
     and diff -> 'withheld' ? 'purchase_price_cents';
  if not found then
    raise exception 'AUDIT FAIL [h]: the legacy vehicle edit was not stripped with its change named';
  end if;
  if (r.diff -> 'old') ? 'purchase_price_cents' or (r.diff -> 'new') ? 'supplier'
     or r.diff -> 'withheld' ? 'supplier' or r.farm_id is null then
    raise exception 'AUDIT FAIL [h]: the legacy vehicle edit is wrong after the backfill: %', r.diff;
  end if;

  select * into r from audit_log where entity = 'farms' and entity_id = 'ad000000-0000-4000-8000-000000000001'
     and action = 'update' and diff -> 'new' ->> 'name' = 'Audit Farm A';
  if r.about_farm_id is distinct from 'ad000000-0000-4000-8000-000000000001'::uuid then
    raise exception 'AUDIT FAIL [h]: an older farms row was not linked to its farm';
  end if;

  select count(*) into n from app.audit_redaction_runs where id > 0;
  if n <= v_runs then raise exception 'AUDIT FAIL [h]: the run recorded nothing'; end if;

  -- Idempotent: a second run finds nothing to do.
  select count(*) into n from app.audit_redact_existing();
  if n <> 0 then raise exception 'AUDIT FAIL [h]: a second run changed % entities again', n; end if;
end $$;

-- == (i) The helpers are nobody's to call ====================================================
do $$
declare f text;
begin
  foreach f in array array[
    'app.audit_hidden_columns(regclass)', 'app.audit_withhold(jsonb,text[])',
    'app.audit_about_farm(text,uuid,jsonb)', 'app.audit_log_file()', 'app.audit_redact_existing()',
    'app.person_audit_elsewhere(uuid,uuid)'
  ] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception 'AUDIT FAIL [i]: % is executable by a client role', f;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'app.audit_table_rules', 'select')
     or has_table_privilege('authenticated', 'app.audit_redaction_runs', 'select') then
    raise exception 'AUDIT FAIL [i]: a client role can read the audit rules or the run log';
  end if;
end $$;

-- == (k) The cross-farm data-subject guard still sees refiled history (20261028093000) =======
-- A person of Farm A whose only trace on Farm B is a row now filed for Rapid Rise (farm_id
-- null, about_farm_id B) must still be handed to Rapid Rise, not exported by A's owner.
insert into auth.users (id, email) values
  ('ad100000-0000-4000-8000-000000000008', 'audit-subject@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('ad100000-0000-4000-8000-000000000008', 'ad000000-0000-4000-8000-000000000001',
   'operator', 'Audit Subject', 'audit-subject@example.test');

set role authenticated;
do $$
begin
  perform _ar_login('ad100000-0000-4000-8000-000000000001');
  -- Control: with no trace elsewhere, the farm's owner may export the person.
  perform public.export_personal_data('ad100000-0000-4000-8000-000000000008');
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.audit_log (farm_id, user_id, entity, entity_id, action, diff) values
  ('ad000000-0000-4000-8000-000000000002', 'ad100000-0000-4000-8000-000000000008',
   'notifications', 'ad700000-0000-4000-8000-000000000009', 'update',
   '{"old": {"read_at": null}, "new": {"read_at": "2026-10-28T08:00:00Z"}}'::jsonb);

do $$
begin
  if not exists (select 1 from audit_log
                  where user_id = 'ad100000-0000-4000-8000-000000000008'
                    and farm_id is null
                    and about_farm_id = 'ad000000-0000-4000-8000-000000000002') then
    raise exception 'AUDIT SETUP [k]: the subject''s Farm B row was not refiled for Rapid Rise';
  end if;
end $$;

set role authenticated;
do $$
declare v_blocked boolean := false;
begin
  perform _ar_login('ad100000-0000-4000-8000-000000000001');
  begin
    perform public.export_personal_data('ad100000-0000-4000-8000-000000000008');
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'AUDIT FAIL [k]: a farm owner exported a person with refiled history on another farm';
  end if;
end $$;
reset role;
select pg_catalog.set_config('request.jwt.claims', '', false);

-- == (j) A failing redaction never stops the write ===========================================
-- Break the helper both doors use, then write to a table with withheld columns.
create or replace function app.audit_withhold(p_diff jsonb, p_hidden text[])
returns jsonb language plpgsql immutable set search_path = '' as $$
begin
  raise exception 'suite: redaction broken on purpose';
end $$;

update public.machines set name = 'Written Despite Broken Audit'
 where id = 'ad300000-0000-4000-8000-000000000002';

do $$
declare r record;
begin
  if not exists (select 1 from public.machines where id = 'ad300000-0000-4000-8000-000000000002'
                   and name = 'Written Despite Broken Audit') then
    raise exception 'AUDIT FAIL [j]: a broken redaction stopped the write it audits';
  end if;
  select * into r from audit_log
   where entity = 'machines' and entity_id = 'ad300000-0000-4000-8000-000000000002'
   order by id desc limit 1;
  if r.diff is distinct from '{"redaction_failed": true}'::jsonb or r.farm_id is not null then
    raise exception 'AUDIT FAIL [j]: a failed redaction must keep the event for Rapid Rise without '
      'its data, got farm % diff %', r.farm_id, r.diff;
  end if;
end $$;

select 'ALL AUDIT REDACTION TESTS PASSED' as result;

rollback;
