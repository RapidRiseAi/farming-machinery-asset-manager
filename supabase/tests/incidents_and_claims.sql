-- Accidents and insurance claims: what the record refuses to be half of, who may read the
-- other driver's details, and whether an unchased claim ever speaks again.
--
-- The money assertions are about SHAPE, not about a ledger: this table records a claim and
-- posts nothing (docs/BILLING.md §11b), so what is tested is that a settled claim cannot
-- exist without its figure and its date, the omission that would silently shrink the
-- "still owed by the insurer" total the whole feature exists to produce.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _inc_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _inc_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('1c000000-0000-4000-8000-000000000001', 'Incident Farm', 'complete', 'active'),
  ('1c000000-0000-4000-8000-000000000002', 'Other Farm', 'complete', 'active');

insert into auth.users (id, email) values
  ('1c100000-0000-4000-8000-000000000001', 'inc-owner@example.test'),
  ('1c100000-0000-4000-8000-000000000002', 'inc-driver@example.test'),
  ('1c100000-0000-4000-8000-000000000003', 'inc-other-driver@example.test'),
  ('1c100000-0000-4000-8000-000000000004', 'inc-neighbour@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('1c100000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-000000000001',
   'owner', 'Ingrid Owner', 'inc-owner@example.test'),
  ('1c100000-0000-4000-8000-000000000002', '1c000000-0000-4000-8000-000000000001',
   'operator', 'Assigned Driver', 'inc-driver@example.test'),
  ('1c100000-0000-4000-8000-000000000003', '1c000000-0000-4000-8000-000000000001',
   'operator', 'Unassigned Driver', 'inc-other-driver@example.test'),
  ('1c100000-0000-4000-8000-000000000004', '1c000000-0000-4000-8000-000000000002',
   'owner', 'Neighbour Owner', 'inc-neighbour@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id) values
  ('1c200000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-000000000001',
   'Bakkie', 'bakkie', 'km', 'active', '1c100000-0000-4000-8000-000000000002'),
  ('1c200000-0000-4000-8000-000000000002', '1c000000-0000-4000-8000-000000000001',
   'Truck', 'truck', 'km', 'active', null),
  ('1c200000-0000-4000-8000-000000000003', '1c000000-0000-4000-8000-000000000002',
   'Neighbour bakkie', 'bakkie', 'km', 'active', null);

insert into public.job_cards (id, farm_id, machine_id, type, status) values
  ('1c300000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000001', 'repair', 'open'),
  ('1c300000-0000-4000-8000-000000000002', '1c000000-0000-4000-8000-000000000002',
   '1c200000-0000-4000-8000-000000000003', 'repair', 'open');

-- == (a) A settled claim cannot be half a record =============================
do $$
declare v_failed boolean;
begin
  -- Settled with no figure and no date. This is the row that would quietly disappear from
  -- "still owed by the insurer" while looking, on screen, exactly like a claim that paid.
  v_failed := false;
  begin
    insert into public.incidents (farm_id, machine_id, kind, status, claim_lodged_on)
    values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000001',
            'collision', 'claim_settled', current_date - 60);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'INCIDENT FAIL [a]: a claim was marked settled with no amount and no date';
  end if;

  -- Lodged with no lodging date: the chase engine reads that date, so a claim without one
  -- is a claim that can never be chased.
  v_failed := false;
  begin
    insert into public.incidents (farm_id, machine_id, status)
    values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000001',
            'claim_lodged');
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'INCIDENT FAIL [a]: a claim was lodged on no date at all';
  end if;

  -- Negative money is not a correction, it is a typo.
  v_failed := false;
  begin
    insert into public.incidents (farm_id, machine_id, excess_incl_cents)
    values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000001', -1);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'INCIDENT FAIL [a]: a negative excess was accepted';
  end if;

  -- `no_claim` is a real decision and must be recordable with nothing else filled in:
  -- most farm incidents are below the excess.
  insert into public.incidents (farm_id, machine_id, kind, status, description)
  values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000001',
          'single_vehicle', 'no_claim', 'Reversed into the gate post. Below the excess.');

  -- A fire in a shed has no driver, and inventing one would be a false record.
  insert into public.incidents (farm_id, machine_id, kind, status, description)
  values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000002',
          'fire', 'reported', 'Burnt out overnight in the implement shed.');
end $$;

-- == (b) A job card from another farm cannot be attached =====================
do $$
declare v_failed boolean := false;
begin
  begin
    insert into public.incidents (farm_id, machine_id, job_card_id)
    values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000001',
            '1c300000-0000-4000-8000-000000000002');
  exception when foreign_key_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'INCIDENT FAIL [b]: a repair on another farm was attached to this one''s accident';
  end if;

  -- The farm's own job card attaches normally.
  insert into public.incidents (farm_id, machine_id, job_card_id, description)
  values ('1c000000-0000-4000-8000-000000000001', '1c200000-0000-4000-8000-000000000001',
          '1c300000-0000-4000-8000-000000000001', 'Repaired under job card.');
end $$;

-- == (c) The other driver's details stay inside the farm =====================
insert into public.incidents
  (id, farm_id, machine_id, kind, status, occurred_at, description,
   driver_user_id, saps_case_number, third_party_name, third_party_contact,
   insurer, claim_number, claim_lodged_on, claimed_incl_cents) values
  ('1c400000-0000-4000-8000-000000000001', '1c000000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000001', 'collision', 'claim_lodged',
   now() - interval '70 days', 'Collision at the R63 turn-off.',
   '1c100000-0000-4000-8000-000000000002', 'CAS 114/06/2026',
   'Pieter van Wyk', '082 555 0000', 'Santam', 'CLM-99812',
   current_date - 60, 4500000),
  -- A second one, on the unassigned truck, so the operator rule has something to hide.
  ('1c400000-0000-4000-8000-000000000002', '1c000000-0000-4000-8000-000000000001',
   '1c200000-0000-4000-8000-000000000002', 'theft', 'claim_lodged',
   now() - interval '10 days', 'Diesel and battery taken.',
   null, 'CAS 220/09/2026', null, null,
   'Santam', 'CLM-99813', current_date - 5, 800000);

set role authenticated;
select _inc_login('1c100000-0000-4000-8000-000000000001');
do $$
declare n integer;
begin
  select count(*) into n from public.incidents;
  if n < 2 then
    raise exception 'INCIDENT FAIL [c]: the owner sees only % incidents on their own farm', n;
  end if;
  if exists (select 1 from public.incidents where farm_id = '1c000000-0000-4000-8000-000000000002') then
    raise exception 'INCIDENT FAIL [c]: the owner reached another farm''s accidents';
  end if;
end $$;

-- An operator sees accidents on the machines assigned to them, and no others. The third
-- party is a member of the public who is not a customer of this product, and their name
-- and number have no business on the phone of somebody who was not involved.
select _inc_login('1c100000-0000-4000-8000-000000000003');
do $$
declare n integer;
begin
  select count(*) into n from public.incidents;
  if n <> 0 then
    raise exception 'INCIDENT FAIL [c]: an unassigned operator sees % accidents', n;
  end if;
  if exists (select 1 from public.incidents where third_party_name is not null) then
    raise exception 'INCIDENT FAIL [c]: an unassigned operator read a third party''s details';
  end if;
end $$;

select _inc_login('1c100000-0000-4000-8000-000000000002');
do $$
declare n integer;
begin
  -- The bakkie is theirs; the truck is not.
  if not exists (select 1 from public.incidents
                  where machine_id = '1c200000-0000-4000-8000-000000000001') then
    raise exception 'INCIDENT FAIL [c]: the assigned operator cannot see their own machine''s accident';
  end if;
  select count(*) into n from public.incidents
   where machine_id = '1c200000-0000-4000-8000-000000000002';
  if n <> 0 then
    raise exception 'INCIDENT FAIL [c]: the assigned operator sees % accidents on a machine that is not theirs', n;
  end if;
end $$;
reset role;

-- The neighbour, who shares nothing at all.
set role authenticated;
select _inc_login('1c100000-0000-4000-8000-000000000004');
do $$
begin
  if exists (select 1 from public.incidents
              where farm_id = '1c000000-0000-4000-8000-000000000001') then
    raise exception 'INCIDENT FAIL [c]: a neighbouring farm read these accidents';
  end if;
end $$;
reset role;

-- == (d) A claim nobody chased speaks up, once, then weekly ==================
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function _inc_chases() returns bigint
language sql stable as $$
  select count(distinct payload->>'incident_id')
    from public.notifications
   where farm_id = '1c000000-0000-4000-8000-000000000001'
     and template = 'claim_outstanding';
$$;

do $$
declare n_before bigint; n_rows_before bigint; n_rows_after bigint; i public.incidents%rowtype;
begin
  n_before := _inc_chases();
  perform app.enqueue_incident_claim_chases();

  -- Sixty days out: chased. Five days out: not yet, and the default threshold is thirty.
  if _inc_chases() - n_before <> 1 then
    raise exception 'INCIDENT FAIL [d]: % claims were chased, expected the sixty-day-old one alone',
      _inc_chases() - n_before;
  end if;
  if not exists (
    select 1 from public.notifications
     where template = 'claim_outstanding'
       and payload->>'incident_id' = '1c400000-0000-4000-8000-000000000001') then
    raise exception 'INCIDENT FAIL [d]: the wrong claim was chased';
  end if;
  -- It says HOW LONG. "A claim is outstanding" is a sentence a farm ignores; "lodged 60
  -- days ago" is one they ring the broker about.
  if (select (payload->>'days')::int from public.notifications
       where template = 'claim_outstanding'
         and payload->>'incident_id' = '1c400000-0000-4000-8000-000000000001' limit 1) <> 60 then
    raise exception 'INCIDENT FAIL [d]: the chase does not say how long it has been waiting';
  end if;

  -- Same night again: nothing new.
  perform app.enqueue_incident_claim_chases();
  if _inc_chases() - n_before <> 1 then
    raise exception 'INCIDENT FAIL [d]: a second pass the same night chased it again';
  end if;

  -- A week later it speaks again, because an unpaid claim does not stop being unpaid.
  select count(*) into n_rows_before from public.notifications where template = 'claim_outstanding';
  update public.incidents set chase_notified_at = now() - interval '8 days'
   where id = '1c400000-0000-4000-8000-000000000001';
  perform app.enqueue_incident_claim_chases();
  select count(*) into n_rows_after from public.notifications where template = 'claim_outstanding';
  if n_rows_after <= n_rows_before then
    raise exception 'INCIDENT FAIL [d]: a claim still unpaid after a week went quiet';
  end if;

  -- Settled: it stops. This is the whole point of the status being on the same row.
  update public.incidents
     set status = 'claim_settled', settled_incl_cents = 4200000, settled_on = current_date
   where id = '1c400000-0000-4000-8000-000000000001';
  select count(*) into n_rows_before from public.notifications where template = 'claim_outstanding';
  perform app.enqueue_incident_claim_chases();
  select count(*) into n_rows_after from public.notifications where template = 'claim_outstanding';
  if n_rows_after <> n_rows_before then
    raise exception 'INCIDENT FAIL [d]: a settled claim was still being chased';
  end if;

  -- And a farm that says thirty days is too soon is obeyed.
  update public.farms set settings = coalesce(settings, '{}'::jsonb) || '{"claim_chase_days": 120}'::jsonb
   where id = '1c000000-0000-4000-8000-000000000001';
  update public.incidents
     set chase_notified_status = null, chase_notified_at = null
   where id = '1c400000-0000-4000-8000-000000000002';
  update public.incidents set claim_lodged_on = current_date - 60
   where id = '1c400000-0000-4000-8000-000000000002';
  select count(*) into n_rows_before from public.notifications where template = 'claim_outstanding';
  perform app.enqueue_incident_claim_chases();
  select count(*) into n_rows_after from public.notifications where template = 'claim_outstanding';
  if n_rows_after <> n_rows_before then
    raise exception 'INCIDENT FAIL [d]: a farm''s own 120-day threshold was ignored at 60 days';
  end if;

  select * into i from public.incidents where id = '1c400000-0000-4000-8000-000000000002';
  if i.chase_notified_status is not null then
    raise exception 'INCIDENT FAIL [d]: a claim below the threshold kept a stale chase marker';
  end if;
end $$;

-- == (e) The engine is not reachable from a browser ==========================
do $$
begin
  if has_function_privilege('authenticated', 'app.enqueue_incident_claim_chases()', 'EXECUTE')
     or has_function_privilege('anon', 'app.enqueue_incident_claim_chases()', 'EXECUTE') then
    raise exception 'INCIDENT FAIL [e]: a browser session may run the chase engine';
  end if;
  if has_function_privilege('authenticated', 'public.cron_enqueue_claim_chases()', 'EXECUTE')
     or has_function_privilege('anon', 'public.cron_enqueue_claim_chases()', 'EXECUTE') then
    raise exception 'INCIDENT FAIL [e]: a browser session may run the nightly route';
  end if;
  if has_table_privilege('anon', 'public.incidents', 'SELECT') then
    raise exception 'INCIDENT FAIL [e]: anon may read accidents';
  end if;
end $$;

rollback;
