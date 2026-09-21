-- Driver and operator credentials: who may read somebody's personal file, and whether the
-- farm is told before a lapsed licence becomes a signed statement to the authority.
--
-- This is the first table in the schema whose SELECT policy is NARROWER than
-- `app.has_farm_access`, so the assertions here are mostly about who is refused. A medical
-- certificate is special personal information under POPIA §26; a linked workshop gets
-- access to a farm's machines, and must not thereby get its employees' medicals.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _dc_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _dc_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('dc000000-0000-4000-8000-000000000001', 'Credential Farm', 'professional', 'active'),
  ('dc000000-0000-4000-8000-000000000002', 'Neighbour Farm', 'professional', 'active');

insert into public.workshops (id, name) values
  ('dcf00000-0000-4000-8000-000000000001', 'Linked Workshop');
insert into public.workshop_links (workshop_id, farm_id, status) values
  ('dcf00000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000001', 'active');

insert into auth.users (id, email) values
  ('dc100000-0000-4000-8000-000000000001', 'dc-owner@example.test'),
  ('dc100000-0000-4000-8000-000000000002', 'dc-manager@example.test'),
  ('dc100000-0000-4000-8000-000000000003', 'dc-driver@example.test'),
  ('dc100000-0000-4000-8000-000000000004', 'dc-other-driver@example.test'),
  ('dc100000-0000-4000-8000-000000000005', 'dc-workshop@example.test'),
  ('dc100000-0000-4000-8000-000000000006', 'dc-neighbour-owner@example.test');

insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('dc100000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000001', null,
   'owner', 'Dirk Owner', 'dc-owner@example.test'),
  ('dc100000-0000-4000-8000-000000000002', 'dc000000-0000-4000-8000-000000000001', null,
   'manager', 'Mari Manager', 'dc-manager@example.test'),
  ('dc100000-0000-4000-8000-000000000003', 'dc000000-0000-4000-8000-000000000001', null,
   'operator', 'Sipho Driver', 'dc-driver@example.test'),
  ('dc100000-0000-4000-8000-000000000004', 'dc000000-0000-4000-8000-000000000001', null,
   'operator', 'Thabo Driver', 'dc-other-driver@example.test'),
  ('dc100000-0000-4000-8000-000000000005', null, 'dcf00000-0000-4000-8000-000000000001',
   'workshop', 'Wayne Workshop', 'dc-workshop@example.test'),
  ('dc100000-0000-4000-8000-000000000006', 'dc000000-0000-4000-8000-000000000002', null,
   'owner', 'Neels Neighbour', 'dc-neighbour-owner@example.test');

insert into public.driver_credentials
  (id, farm_id, user_id, person_name, type, code, number, expiry_date, created_by) values
  -- Sipho: licence fine, PrDP expired last month.
  ('dc200000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000001',
   'dc100000-0000-4000-8000-000000000003', null, 'drivers_licence', 'EC', 'L-1',
   current_date + 400, 'dc100000-0000-4000-8000-000000000001'),
  ('dc200000-0000-4000-8000-000000000002', 'dc000000-0000-4000-8000-000000000001',
   'dc100000-0000-4000-8000-000000000003', null, 'prdp', 'G', 'P-1',
   current_date - 30, 'dc100000-0000-4000-8000-000000000001'),
  -- Thabo: a medical, so the "own row only" rule has something to hide from Sipho.
  ('dc200000-0000-4000-8000-000000000003', 'dc000000-0000-4000-8000-000000000001',
   'dc100000-0000-4000-8000-000000000004', null, 'medical', null, 'M-1',
   current_date + 10, 'dc100000-0000-4000-8000-000000000001'),
  -- Somebody who has never signed in: a name on a page, which is most farm drivers.
  ('dc200000-0000-4000-8000-000000000004', 'dc000000-0000-4000-8000-000000000001',
   null, '  Koos Casual  ', 'drivers_licence', 'C1', 'L-2',
   current_date - 5, 'dc100000-0000-4000-8000-000000000001'),
  -- The neighbour's own file, which nobody on the first farm may see.
  ('dc200000-0000-4000-8000-000000000005', 'dc000000-0000-4000-8000-000000000002',
   'dc100000-0000-4000-8000-000000000006', null, 'drivers_licence', 'B', 'L-3',
   current_date + 100, 'dc100000-0000-4000-8000-000000000006');

-- == (a) One of a user OR a name, never both and never neither ===============
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    insert into public.driver_credentials (farm_id, user_id, person_name, type, expiry_date)
    values ('dc000000-0000-4000-8000-000000000001',
            'dc100000-0000-4000-8000-000000000003', 'Sipho Driver', 'prdp', current_date);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'DRIVER FAIL [a]: a credential was filed against a user AND a name';
  end if;

  v_failed := false;
  begin
    insert into public.driver_credentials (farm_id, user_id, person_name, type, expiry_date)
    values ('dc000000-0000-4000-8000-000000000001', null, '   ', 'prdp', current_date);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'DRIVER FAIL [a]: a credential was filed against nobody at all';
  end if;

  -- An expiry before the issue date is a typo, and it would quietly read as "expired".
  v_failed := false;
  begin
    insert into public.driver_credentials
      (farm_id, person_name, type, issued_on, expiry_date)
    values ('dc000000-0000-4000-8000-000000000001', 'Backwards', 'prdp',
            current_date, current_date - 1);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'DRIVER FAIL [a]: a credential expired before it was issued';
  end if;
end $$;

-- == (b) The owner and the manager see the farm's files ======================
set role authenticated;
select _dc_login('dc100000-0000-4000-8000-000000000001');
do $$
declare n integer;
begin
  select count(*) into n from public.driver_credentials;
  if n <> 4 then
    raise exception 'DRIVER FAIL [b]: the owner sees % of the farm''s 4 credentials', n;
  end if;
  -- And not the neighbour's, which is the ordinary tenancy guarantee.
  if exists (select 1 from public.driver_credentials
              where farm_id = 'dc000000-0000-4000-8000-000000000002') then
    raise exception 'DRIVER FAIL [b]: the owner reached another farm''s personal files';
  end if;
end $$;

select _dc_login('dc100000-0000-4000-8000-000000000002');
do $$
declare n integer;
begin
  select count(*) into n from public.driver_credentials;
  if n <> 4 then
    raise exception 'DRIVER FAIL [b]: the manager sees % of the farm''s 4 credentials', n;
  end if;
end $$;
reset role;

-- == (c) A driver sees their own file and nobody else's ======================
set role authenticated;
select _dc_login('dc100000-0000-4000-8000-000000000003');
do $$
declare n integer;
begin
  select count(*) into n from public.driver_credentials;
  if n <> 2 then
    raise exception 'DRIVER FAIL [c]: a driver sees % rows, their own file is 2', n;
  end if;
  if exists (select 1 from public.driver_credentials
              where user_id = 'dc100000-0000-4000-8000-000000000004') then
    raise exception 'DRIVER FAIL [c]: a driver read a colleague''s medical certificate';
  end if;
  -- Nor the casual driver's, which belongs to no user at all.
  if exists (select 1 from public.driver_credentials where person_name is not null) then
    raise exception 'DRIVER FAIL [c]: a driver read a credential filed against a name';
  end if;
end $$;

-- A driver may not file or change one either: this is a personnel record, and the farm
-- has to be able to say who put a date in it.
do $$
declare v_denied boolean := false; n integer;
begin
  begin
    insert into public.driver_credentials (farm_id, person_name, type, expiry_date)
    values ('dc000000-0000-4000-8000-000000000001', 'Invented', 'prdp', current_date + 900);
  exception when insufficient_privilege then v_denied := true;
  end;
  if not v_denied then
    raise exception 'DRIVER FAIL [c]: a driver filed a credential';
  end if;

  -- The one that matters most: extending their OWN expired PrDP.
  update public.driver_credentials
     set expiry_date = current_date + 900
   where id = 'dc200000-0000-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'DRIVER FAIL [c]: a driver renewed their own PrDP by typing a date';
  end if;
end $$;
reset role;

-- == (d) A linked workshop gets machines, not medicals =======================
set role authenticated;
select _dc_login('dc100000-0000-4000-8000-000000000005');
do $$
declare n integer;
begin
  -- The link is real and active: it is the access this test is narrowing.
  if not app.has_farm_access('dc000000-0000-4000-8000-000000000001') then
    raise exception 'DRIVER SETUP [d]: the workshop link is not granting farm access at all';
  end if;
  select count(*) into n from public.driver_credentials;
  if n <> 0 then
    raise exception 'DRIVER FAIL [d]: linked workshop staff read % personnel records', n;
  end if;
end $$;
reset role;

-- == (e) Were they licensed on the day of the offence? =======================
--
-- The question AARTO makes a farm answer. Asked about a day in the past, because
-- "their licence is fine now" is not an answer to "were they licensed on the 14th".
set role authenticated;
select _dc_login('dc100000-0000-4000-8000-000000000001');
do $$
declare n integer; r record;
begin
  -- Today: the PrDP lapsed 30 days ago, the licence is good for another year.
  select count(*) into n from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000001',
    'dc100000-0000-4000-8000-000000000003', null, current_date);
  if n <> 1 then
    raise exception 'DRIVER FAIL [e]: % lapses today, expected the PrDP alone', n;
  end if;
  select * into r from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000001',
    'dc100000-0000-4000-8000-000000000003', null, current_date);
  if r.type <> 'prdp' or r.status <> 'expired' then
    raise exception 'DRIVER FAIL [e]: the lapse reported is % (%)', r.type, r.status;
  end if;

  -- Sixty days ago the PrDP was still valid. A nomination about THAT day must not be
  -- flagged, or the warning stops meaning anything and stops being read.
  select count(*) into n from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000001',
    'dc100000-0000-4000-8000-000000000003', null, current_date - 60);
  if n <> 0 then
    raise exception 'DRIVER FAIL [e]: % lapses reported for a day the PrDP was valid', n;
  end if;

  -- The casual driver, matched by name, trimmed and case-folded, because a name typed
  -- twice is typed twice.
  select count(*) into n from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000001', null, 'koos casual', current_date);
  if n <> 1 then
    raise exception 'DRIVER FAIL [e]: matching a casual driver by name found % rows', n;
  end if;

  -- A name is never matched against a row that belongs to a user, or one careless
  -- free-text entry would speak for a real person's file.
  select count(*) into n from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000001', null, 'Sipho Driver', current_date);
  if n <> 0 then
    raise exception 'DRIVER FAIL [e]: a typed name matched a signed-in driver''s file';
  end if;

  -- And it does not cross the fence.
  select count(*) into n from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000002',
    'dc100000-0000-4000-8000-000000000006', null, current_date);
  if n <> 0 then
    raise exception 'DRIVER FAIL [e]: the lapse check read another farm';
  end if;
end $$;
reset role;

-- A driver asking the same question gets their own answer and no one else's, because the
-- function is SECURITY INVOKER and the table's policy is the only rule there is.
set role authenticated;
select _dc_login('dc100000-0000-4000-8000-000000000003');
do $$
declare n integer;
begin
  select count(*) into n from public.driver_credential_lapses(
    'dc000000-0000-4000-8000-000000000001',
    'dc100000-0000-4000-8000-000000000004', null, current_date);
  if n <> 0 then
    raise exception 'DRIVER FAIL [e]: a driver used the lapse check to read a colleague';
  end if;
end $$;
reset role;

-- == (f) The farm is told, once per transition, and weekly while expired =====
select pg_catalog.set_config('request.jwt.claims', '', false);
-- `app.notify_farm` writes one row per owner/manager, so the count that means anything
-- here is how many CREDENTIALS spoke, not how many rows landed.
create or replace function _dc_notified() returns bigint
language sql stable as $$
  select count(distinct payload->>'credential_id')
    from public.notifications
   where farm_id = 'dc000000-0000-4000-8000-000000000001'
     and template like 'driver_credential%';
$$;

do $$
declare
  n_before bigint;
  n_after  bigint;
  c        public.driver_credentials%rowtype;
begin
  n_before := _dc_notified();
  perform app.enqueue_driver_credential_reminders();
  n_after := _dc_notified();

  -- Expired PrDP, expired casual licence, and Thabo's medical inside its 30-day lead.
  -- Sipho's licence is a year out and must stay quiet.
  if n_after - n_before <> 3 then
    raise exception 'DRIVER FAIL [f]: the first pass reminded about % credentials, expected 3',
      n_after - n_before;
  end if;

  -- It goes to the people who can do something about it, and to nobody else. A driver
  -- receiving "Thabo Driver's medical expires on the 30th" in their inbox is a POPIA
  -- problem arriving through the back door of a feature that reads correctly everywhere
  -- else, the table's policy does not govern what notify_farm fans out to.
  if exists (
    select 1 from public.notifications n
     join public.users u on u.id = n.user_id
    where n.template like 'driver_credential%'
      and u.role not in ('owner', 'manager')) then
    raise exception 'DRIVER FAIL [f]: a personnel reminder was sent to somebody who is not owner or manager';
  end if;
  if (select count(distinct user_id) from public.notifications
       where farm_id = 'dc000000-0000-4000-8000-000000000001'
         and template like 'driver_credential%') <> 2 then
    raise exception 'DRIVER FAIL [f]: the reminder did not reach both the owner and the manager';
  end if;

  -- The money and the number stay out of the inbox. A notification is delivered by push
  -- and by email and read on a phone somebody else may be holding.
  if exists (
    select 1 from public.notifications
     where farm_id = 'dc000000-0000-4000-8000-000000000001'
       and template like 'driver_credential%'
       and payload::text like '%L-2%') then
    raise exception 'DRIVER FAIL [f]: a licence number was put in a notification';
  end if;

  -- Run it again the same night: nothing new. Without the dedupe a farm gets the same
  -- three reminders every morning and stops reading any of them.
  perform app.enqueue_driver_credential_reminders();
  if _dc_notified() - n_before <> 3 then
    raise exception 'DRIVER FAIL [f]: a second pass the same night reminded about % more',
      _dc_notified() - n_before - 3;
  end if;

  -- Seven days later an EXPIRED one speaks again; an expiring one does not nag.
  update public.driver_credentials
     set last_notified_at = now() - interval '8 days'
   where id in ('dc200000-0000-4000-8000-000000000002',  -- expired PrDP
                'dc200000-0000-4000-8000-000000000003'); -- expiring medical
  -- Counted as ROWS this time: the same credential speaks a second time, so a distinct
  -- count of credentials cannot see it. Two recipients, one credential, two new rows.
  select count(*) into n_before from public.notifications
   where farm_id = 'dc000000-0000-4000-8000-000000000001'
     and template like 'driver_credential%';
  perform app.enqueue_driver_credential_reminders();
  select count(*) into n_after from public.notifications
   where farm_id = 'dc000000-0000-4000-8000-000000000001'
     and template like 'driver_credential%';
  if n_after - n_before <> 2 then
    raise exception 'DRIVER FAIL [f]: the weekly re-fire produced % rows, expected the expired PrDP to both recipients',
      n_after - n_before;
  end if;

  -- Somebody who has left. The file stays for the record; the reminders stop.
  update public.users set active = false
   where id = 'dc100000-0000-4000-8000-000000000003';
  update public.driver_credentials
     set notified_status = null, last_notified_at = null
   where id = 'dc200000-0000-4000-8000-000000000002';
  n_before := n_after;
  perform app.enqueue_driver_credential_reminders();
  select count(*) into n_after from public.notifications
   where farm_id = 'dc000000-0000-4000-8000-000000000001'
     and template like 'driver_credential%';
  if n_after <> n_before then
    raise exception 'DRIVER FAIL [f]: a departed employee still generates reminders';
  end if;
  select * into c from public.driver_credentials
   where id = 'dc200000-0000-4000-8000-000000000002';
  if c.id is null then
    raise exception 'DRIVER FAIL [f]: the departed employee''s record was removed';
  end if;
  update public.users set active = true
   where id = 'dc100000-0000-4000-8000-000000000003';
end $$;

-- == (g) The engine is not reachable from a browser ==========================
do $$
begin
  if has_function_privilege('authenticated',
       'app.enqueue_driver_credential_reminders()', 'EXECUTE')
     or has_function_privilege('anon',
       'app.enqueue_driver_credential_reminders()', 'EXECUTE') then
    raise exception 'DRIVER FAIL [g]: a browser session may run the reminder engine';
  end if;
  if has_function_privilege('authenticated',
       'public.cron_enqueue_driver_credentials()', 'EXECUTE')
     or has_function_privilege('anon',
       'public.cron_enqueue_driver_credentials()', 'EXECUTE') then
    raise exception 'DRIVER FAIL [g]: a browser session may run the nightly route';
  end if;
  -- The lapse check IS for the browser, it is what the AARTO screen asks, but not for
  -- a stranger.
  if not has_function_privilege('authenticated',
       'public.driver_credential_lapses(uuid,uuid,text,date)', 'EXECUTE') then
    raise exception 'DRIVER FAIL [g]: the screen cannot ask whether a driver was licensed';
  end if;
  if has_function_privilege('anon',
       'public.driver_credential_lapses(uuid,uuid,text,date)', 'EXECUTE') then
    raise exception 'DRIVER FAIL [g]: anon may probe who is licensed';
  end if;
  if has_table_privilege('anon', 'public.driver_credentials', 'SELECT') then
    raise exception 'DRIVER FAIL [g]: anon may read personnel records';
  end if;
end $$;

rollback;
