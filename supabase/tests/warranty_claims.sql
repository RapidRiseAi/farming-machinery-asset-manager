-- Warranty claims: was it covered ON THE DAY, and can the record lie about the money?
--
-- The cover question is the one this feature turns on. `app.warranty_status` answers "is
-- this machine under warranty now"; a claim is about a repair that already happened, and
-- six weeks later the answer to the first question can be no while the answer for the day
-- of the repair is still yes. That gap is where the money is lost, so most of what follows
-- is about dates and meter readings in the past.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _wc_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _wc_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('ac000000-0000-4000-8000-000000000001', 'Warranty Farm', 'complete', 'active');

insert into auth.users (id, email) values
  ('ac100000-0000-4000-8000-000000000001', 'wc-owner@example.test'),
  ('ac100000-0000-4000-8000-000000000002', 'wc-operator@example.test');

insert into public.users (id, farm_id, role, name, email) values
  ('ac100000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
   'owner', 'Warranty Owner', 'wc-owner@example.test'),
  ('ac100000-0000-4000-8000-000000000002', 'ac000000-0000-4000-8000-000000000001',
   'operator', 'Warranty Operator', 'wc-operator@example.test');

-- An hours machine whose warranty ran to 2026-03-31 or 2 000 hours, whichever came first.
insert into public.machines
  (id, farm_id, name, type, meter_type, status, current_reading,
   warranty_expiry_date, warranty_expiry_hours, assigned_operator_id) values
  ('ac200000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
   'Warranty tractor', 'tractor', 'hours', 'active', 2400,
   date '2026-03-31', 2000, 'ac100000-0000-4000-8000-000000000002'),
  -- A km machine: the hours basis must stay silent for it.
  ('ac200000-0000-4000-8000-000000000002', 'ac000000-0000-4000-8000-000000000001',
   'Warranty bakkie', 'bakkie', 'km', 'active', 90000,
   date '2026-03-31', null, null),
  -- No warranty recorded at all.
  ('ac200000-0000-4000-8000-000000000003', 'ac000000-0000-4000-8000-000000000001',
   'Unknown cover', 'implement', 'none', 'active', null, null, null, null);

insert into public.job_cards
  (id, farm_id, machine_id, type, status, date_in, meter_reading, total_cents) values
  -- Inside both bases: January, 1 500 hours.
  ('ac300000-0000-4000-8000-000000000001', 'ac000000-0000-4000-8000-000000000001',
   'ac200000-0000-4000-8000-000000000001', 'repair', 'approved',
   date '2026-01-15', 1500, 450000),
  -- Inside the date, PAST the hours: February, 2 100 hours.
  ('ac300000-0000-4000-8000-000000000002', 'ac000000-0000-4000-8000-000000000001',
   'ac200000-0000-4000-8000-000000000001', 'repair', 'approved',
   date '2026-02-10', 2100, 300000),
  -- Past the date: June.
  ('ac300000-0000-4000-8000-000000000003', 'ac000000-0000-4000-8000-000000000001',
   'ac200000-0000-4000-8000-000000000001', 'repair', 'approved',
   date '2026-06-01', 1900, 200000),
  -- The bakkie, inside its date. Hours must not be consulted.
  ('ac300000-0000-4000-8000-000000000004', 'ac000000-0000-4000-8000-000000000001',
   'ac200000-0000-4000-8000-000000000002', 'repair', 'approved',
   date '2026-02-01', 88000, 150000),
  -- No cover recorded.
  ('ac300000-0000-4000-8000-000000000005', 'ac000000-0000-4000-8000-000000000001',
   'ac200000-0000-4000-8000-000000000003', 'repair', 'approved',
   date '2026-02-01', null, 100000),
  -- Still open, no total yet.
  ('ac300000-0000-4000-8000-000000000006', 'ac000000-0000-4000-8000-000000000001',
   'ac200000-0000-4000-8000-000000000001', 'repair', 'open',
   date '2026-01-20', 1600, 0);

-- == (a) Cover is judged on the job card's day and reading ===================
set role authenticated;
select _wc_login('ac100000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  -- January, 1 500 hours: inside both. The machine reads 2 400 hours TODAY and its
  -- warranty date has passed, so anything asking "is it covered now" would say no.
  select * into r from public.job_card_warranty_cover('ac300000-0000-4000-8000-000000000001');
  if r.covered is not true or r.covered_by_date is not true or r.covered_by_hours is not true then
    raise exception 'WARRANTY FAIL [a]: a repair inside both bases reported covered=%, date=%, hours=%',
      r.covered, r.covered_by_date, r.covered_by_hours;
  end if;

  -- Inside the date, PAST the hours. Not covered: a dealer refuses this, and telling the
  -- farm otherwise sends them to an argument they lose.
  select * into r from public.job_card_warranty_cover('ac300000-0000-4000-8000-000000000002');
  if r.covered is not false then
    raise exception 'WARRANTY FAIL [a]: past the hours reported covered=%', r.covered;
  end if;
  if r.covered_by_date is not true or r.covered_by_hours is not false then
    raise exception 'WARRANTY FAIL [a]: the two bases were not reported separately (date=%, hours=%)',
      r.covered_by_date, r.covered_by_hours;
  end if;

  -- Past the date, inside the hours. Also not covered.
  select * into r from public.job_card_warranty_cover('ac300000-0000-4000-8000-000000000003');
  if r.covered is not false or r.covered_by_date is not false then
    raise exception 'WARRANTY FAIL [a]: past the date reported covered=%', r.covered;
  end if;

  -- A km machine has no hours basis, and consulting one would be inventing a limit.
  select * into r from public.job_card_warranty_cover('ac300000-0000-4000-8000-000000000004');
  if r.covered is not true or r.covered_by_hours is not null then
    raise exception 'WARRANTY FAIL [a]: a km machine got an hours verdict (%)', r.covered_by_hours;
  end if;

  -- Nothing recorded is NOT "no cover". It is "we do not know", and a farm should go and
  -- look at the paperwork rather than be told they have no claim.
  select * into r from public.job_card_warranty_cover('ac300000-0000-4000-8000-000000000005');
  if r.covered is not null then
    raise exception 'WARRANTY FAIL [a]: a machine with no warranty recorded reported covered=%', r.covered;
  end if;
end $$;
reset role;

-- == (b) The money cannot exceed the repair ==================================
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    insert into public.warranty_claims (farm_id, machine_id, job_card_id, claimed_ex_vat_cents)
    values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
            'ac300000-0000-4000-8000-000000000001', 450001);
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'WARRANTY FAIL [b]: a claim larger than its own job card was accepted';
  end if;

  v_failed := false;
  begin
    insert into public.warranty_claims
      (farm_id, machine_id, job_card_id, status, submitted_on, decided_on, recovered_ex_vat_cents)
    values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
            'ac300000-0000-4000-8000-000000000001', 'paid', current_date, current_date, 999999);
  exception when others then v_failed := true;
  end;
  if not v_failed then
    raise exception 'WARRANTY FAIL [b]: recovering more than the repair cost was accepted';
  end if;

  -- An OPEN job card has no total yet. A claim against it is allowed, because the day a
  -- farm posts the claim is the day they will remember to record it.
  insert into public.warranty_claims
    (farm_id, machine_id, job_card_id, status, submitted_on, claimed_ex_vat_cents, supplier)
  values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
          'ac300000-0000-4000-8000-000000000006', 'submitted', current_date - 60, 50000,
          'Dealer while still open');
end $$;

-- == (c) A paid claim cannot be half a record ================================
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    insert into public.warranty_claims
      (farm_id, machine_id, job_card_id, status, submitted_on)
    values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
            'ac300000-0000-4000-8000-000000000002', 'paid', current_date);
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'WARRANTY FAIL [c]: a claim was marked paid with no amount and no date';
  end if;

  -- Submitted with no submission date: the chase engine reads that date, so a claim
  -- without one can never be chased.
  v_failed := false;
  begin
    insert into public.warranty_claims (farm_id, machine_id, job_card_id, status)
    values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
            'ac300000-0000-4000-8000-000000000002', 'submitted');
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'WARRANTY FAIL [c]: a claim was submitted on no date at all';
  end if;
end $$;

-- == (d) One live claim per repair ===========================================
do $$
declare v_failed boolean := false;
begin
  insert into public.warranty_claims (farm_id, machine_id, job_card_id, supplier)
  values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
          'ac300000-0000-4000-8000-000000000001', 'First claim');
  begin
    insert into public.warranty_claims (farm_id, machine_id, job_card_id, supplier)
    values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
            'ac300000-0000-4000-8000-000000000001', 'Second claim');
  exception when unique_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'WARRANTY FAIL [d]: two live claims were filed against one repair';
  end if;

  -- Withdrawing the first must free the job card, or a mistake locks the repair for ever.
  update public.warranty_claims set deleted_at = now()
   where job_card_id = 'ac300000-0000-4000-8000-000000000001';
  insert into public.warranty_claims (farm_id, machine_id, job_card_id, supplier)
  values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
          'ac300000-0000-4000-8000-000000000001', 'Replacement claim');
end $$;

-- == (e) A job card from another farm cannot be claimed against ==============
insert into public.farms (id, name, plan, status) values
  ('ac000000-0000-4000-8000-000000000002', 'Other Warranty Farm', 'complete', 'active');
insert into public.machines (id, farm_id, name, type, meter_type, status) values
  ('ac200000-0000-4000-8000-000000000009', 'ac000000-0000-4000-8000-000000000002',
   'Their tractor', 'tractor', 'hours', 'active');
insert into public.job_cards (id, farm_id, machine_id, type, status, total_cents) values
  ('ac300000-0000-4000-8000-000000000009', 'ac000000-0000-4000-8000-000000000002',
   'ac200000-0000-4000-8000-000000000009', 'repair', 'approved', 900000);

do $$
declare v_failed boolean := false;
begin
  begin
    insert into public.warranty_claims (farm_id, machine_id, job_card_id)
    values ('ac000000-0000-4000-8000-000000000001', 'ac200000-0000-4000-8000-000000000001',
            'ac300000-0000-4000-8000-000000000009');
  exception when foreign_key_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'WARRANTY FAIL [e]: a claim was filed against another farm''s repair';
  end if;
end $$;

-- == (f) The claim nobody chased =============================================
do $$
declare n_before bigint; n_after bigint; w public.warranty_claims%rowtype;
begin
  select count(distinct payload->>'claim_id') into n_before from public.notifications
   where template = 'warranty_claim_outstanding';

  perform app.enqueue_warranty_claim_chases();

  select count(distinct payload->>'claim_id') into n_after from public.notifications
   where template = 'warranty_claim_outstanding';
  -- One claim is submitted and sixty days old (section b). Everything else is draft.
  if n_after - n_before <> 1 then
    raise exception 'WARRANTY FAIL [f]: % claims chased, expected the sixty-day-old one alone',
      n_after - n_before;
  end if;

  -- It says how long, because "a claim is outstanding" is a sentence a farm ignores.
  if (select (payload->>'days')::int from public.notifications
       where template = 'warranty_claim_outstanding' limit 1) <> 60 then
    raise exception 'WARRANTY FAIL [f]: the chase does not say how long it has waited';
  end if;

  -- Same night again: nothing new.
  perform app.enqueue_warranty_claim_chases();
  select count(distinct payload->>'claim_id') into n_after from public.notifications
   where template = 'warranty_claim_outstanding';
  if n_after - n_before <> 1 then
    raise exception 'WARRANTY FAIL [f]: a second pass the same night chased it again';
  end if;

  -- Paid: it stops.
  update public.warranty_claims
     set status = 'paid', recovered_ex_vat_cents = 40000, decided_on = current_date
   where job_card_id = 'ac300000-0000-4000-8000-000000000006';
  select count(*) into n_before from public.notifications
   where template = 'warranty_claim_outstanding';
  perform app.enqueue_warranty_claim_chases();
  select count(*) into n_after from public.notifications
   where template = 'warranty_claim_outstanding';
  if n_after <> n_before then
    raise exception 'WARRANTY FAIL [f]: a paid claim was still being chased';
  end if;
end $$;

-- == (g) Who may see it, and who may run the engine ==========================
set role authenticated;
select _wc_login('ac100000-0000-4000-8000-000000000002');
do $$
declare n integer;
begin
  -- The operator is assigned the tractor, so claims on it are theirs to see.
  select count(*) into n from public.warranty_claims
   where machine_id = 'ac200000-0000-4000-8000-000000000001';
  if n = 0 then
    raise exception 'WARRANTY FAIL [g]: the assigned operator sees no claims on their own machine';
  end if;
  -- The bakkie is not assigned to them.
  if exists (select 1 from public.warranty_claims
              where machine_id = 'ac200000-0000-4000-8000-000000000002') then
    raise exception 'WARRANTY FAIL [g]: an operator sees claims on a machine that is not theirs';
  end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('authenticated', 'app.enqueue_warranty_claim_chases()', 'EXECUTE')
     or has_function_privilege('anon', 'public.cron_enqueue_warranty_chases()', 'EXECUTE') then
    raise exception 'WARRANTY FAIL [g]: a browser session may run the chase engine';
  end if;
  if not has_function_privilege('authenticated', 'public.job_card_warranty_cover(uuid)', 'EXECUTE') then
    raise exception 'WARRANTY FAIL [g]: the screen cannot ask whether a repair was covered';
  end if;
  if has_function_privilege('anon', 'public.job_card_warranty_cover(uuid)', 'EXECUTE')
     or has_table_privilege('anon', 'public.warranty_claims', 'SELECT') then
    raise exception 'WARRANTY FAIL [g]: anon may read warranty claims';
  end if;
end $$;

rollback;
