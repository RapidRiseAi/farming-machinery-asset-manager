-- Book value: the arithmetic, and who is allowed to know it.
--
-- The second half matters more than the first. A book value IS the purchase price with the
-- years taken off, and 20260903074350 went to some trouble to keep the purchase price away
-- from operators, from farms that have not opted their operators in, and from linked
-- workshops. A register that computed the same figure through a different door would undo
-- all of it, so `farm_book_values` is asserted against the same cases
-- `operator_cost_confidentiality.sql` asserts `machine_financials` against.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _dep_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _dep_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, settings) values
  ('de000000-0000-4000-8000-000000000001', 'Book Farm', 'complete', 'active',
   '{"cost_visible_to_operators": false}'::jsonb),
  ('de000000-0000-4000-8000-000000000002', 'Other Book Farm', 'complete', 'active', '{}'::jsonb);

insert into public.workshops (id, name) values
  ('def00000-0000-4000-8000-000000000001', 'Linked Workshop');
insert into public.workshop_links (workshop_id, farm_id, status) values
  ('def00000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'active');

insert into auth.users (id, email) values
  ('de100000-0000-4000-8000-000000000001', 'dep-owner@example.test'),
  ('de100000-0000-4000-8000-000000000002', 'dep-operator@example.test'),
  ('de100000-0000-4000-8000-000000000003', 'dep-workshop@example.test'),
  ('de100000-0000-4000-8000-000000000004', 'dep-neighbour@example.test');

insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('de100000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', null,
   'owner', 'Book Owner', 'dep-owner@example.test'),
  ('de100000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001', null,
   'operator', 'Book Operator', 'dep-operator@example.test'),
  ('de100000-0000-4000-8000-000000000003', null, 'def00000-0000-4000-8000-000000000001',
   'workshop', 'Book Workshop', 'dep-workshop@example.test'),
  ('de100000-0000-4000-8000-000000000004', 'de000000-0000-4000-8000-000000000002', null,
   'owner', 'Neighbour', 'dep-neighbour@example.test');

-- R1 000 000 tractor, straight line over ten years down to a R100 000 residual.
insert into public.machines
  (id, farm_id, name, type, meter_type, status, assigned_operator_id,
   purchase_date, purchase_price_cents, depreciation_method,
   depreciation_rate_bps, useful_life_months, residual_value_cents, depreciation_start_date) values
  ('de200000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001',
   'Straight tractor', 'tractor', 'hours', 'active', 'de100000-0000-4000-8000-000000000002',
   date '2020-01-01', 100000000, 'straight_line', null, 120, 10000000, date '2020-01-01'),
  -- R500 000 bakkie, 20% reducing balance, no residual.
  ('de200000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001',
   'Reducing bakkie', 'bakkie', 'km', 'active', null,
   date '2020-01-01', 50000000, 'reducing_balance', 2000, null, null, date '2020-01-01'),
  -- No policy set: worth what it cost until somebody decides otherwise.
  ('de200000-0000-4000-8000-000000000003', 'de000000-0000-4000-8000-000000000001',
   'Undecided implement', 'implement', 'none', 'active', null,
   date '2020-01-01', 20000000, 'none', null, null, null, null),
  -- Sold: not an asset to insure, and not in the register.
  ('de200000-0000-4000-8000-000000000004', 'de000000-0000-4000-8000-000000000001',
   'Sold harvester', 'harvester', 'hours', 'sold', null,
   date '2019-01-01', 80000000, 'straight_line', null, 120, null, date '2019-01-01');

-- ── (a) The sums ────────────────────────────────────────────────────────────
do $$
declare v bigint;
begin
  -- Straight line, five years in: half the depreciable amount is gone.
  -- (1 000 000 − 100 000) × 60/120 = 450 000 off, leaving 550 000.
  v := app.book_value_cents(100000000, 'straight_line', null, 120, 10000000,
                            date '2020-01-01', date '2025-01-01');
  if v <> 55000000 then
    raise exception 'DEPRECIATION FAIL [a]: straight line five years in gave %', v;
  end if;

  -- The day it starts, nothing has been written off yet.
  v := app.book_value_cents(100000000, 'straight_line', null, 120, 10000000,
                            date '2020-01-01', date '2020-01-01');
  if v <> 100000000 then
    raise exception 'DEPRECIATION FAIL [a]: it lost value on day one (%)', v;
  end if;

  -- Past the end of its life it floors at the residual and STAYS there. Without the
  -- floor a fifteen-year-old tractor would be insured for a negative amount.
  v := app.book_value_cents(100000000, 'straight_line', null, 120, 10000000,
                            date '2020-01-01', date '2040-01-01');
  if v <> 10000000 then
    raise exception 'DEPRECIATION FAIL [a]: twenty years in it is worth % rather than the residual', v;
  end if;

  -- Reducing balance, one year at 20%: 500 000 → 400 000.
  v := app.book_value_cents(50000000, 'reducing_balance', 2000, null, null,
                            date '2020-01-01', date '2021-01-01');
  if v <> 40000000 then
    raise exception 'DEPRECIATION FAIL [a]: one year of reducing balance gave %', v;
  end if;
  -- Two years: 500 000 → 400 000 → 320 000. Compounding, not 40% off the original.
  v := app.book_value_cents(50000000, 'reducing_balance', 2000, null, null,
                            date '2020-01-01', date '2022-01-01');
  if v <> 32000000 then
    raise exception 'DEPRECIATION FAIL [a]: two years of reducing balance gave % (straight line would be 30 000 000)', v;
  end if;

  -- Before the start date nothing has happened. A machine bought in December and
  -- commissioned in March is not three months old in January.
  v := app.book_value_cents(50000000, 'reducing_balance', 2000, null, null,
                            date '2026-03-01', date '2026-01-01');
  if v <> 50000000 then
    raise exception 'DEPRECIATION FAIL [a]: it depreciated before it started (%)', v;
  end if;

  -- No policy, no cost: no answer invented.
  if app.book_value_cents(50000000, 'none', null, null, null, date '2020-01-01', date '2026-01-01')
     <> 50000000 then
    raise exception 'DEPRECIATION FAIL [a]: a machine with no policy lost value anyway';
  end if;
  if app.book_value_cents(null, 'straight_line', null, 120, null, date '2020-01-01', date '2026-01-01')
     is not null then
    raise exception 'DEPRECIATION FAIL [a]: a machine with no purchase price was given a book value';
  end if;
end $$;

-- ── (b) A method without its input is refused at the row ────────────────────
do $$
declare v_failed boolean;
begin
  v_failed := false;
  begin
    update public.machines set depreciation_method = 'straight_line', useful_life_months = null
     where id = 'de200000-0000-4000-8000-000000000003';
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'DEPRECIATION FAIL [b]: straight line was accepted with no useful life';
  end if;

  v_failed := false;
  begin
    update public.machines set depreciation_method = 'reducing_balance', depreciation_rate_bps = null
     where id = 'de200000-0000-4000-8000-000000000003';
  exception when check_violation then v_failed := true;
  end;
  if not v_failed then
    raise exception 'DEPRECIATION FAIL [b]: reducing balance was accepted with no rate';
  end if;
end $$;

-- ── (c) The register, and who gets one ──────────────────────────────────────
set role authenticated;
select _dep_login('de100000-0000-4000-8000-000000000001');
do $$
declare n integer; r record;
begin
  select count(*) into n from public.farm_book_values('de000000-0000-4000-8000-000000000001', date '2025-01-01');
  -- Three live machines. The sold harvester is not an asset to insure.
  if n <> 3 then
    raise exception 'DEPRECIATION FAIL [c]: the register has % rows, expected 3 live machines', n;
  end if;
  if exists (select 1 from public.farm_book_values('de000000-0000-4000-8000-000000000001', null)
              where machine_id = 'de200000-0000-4000-8000-000000000004') then
    raise exception 'DEPRECIATION FAIL [c]: a sold machine is in the insurance schedule';
  end if;

  select * into r from public.farm_book_values('de000000-0000-4000-8000-000000000001', date '2025-01-01')
   where machine_id = 'de200000-0000-4000-8000-000000000001';
  if r.book_value_cents <> 55000000 then
    raise exception 'DEPRECIATION FAIL [c]: the register says % for the straight-line tractor', r.book_value_cents;
  end if;
  -- What has been written off and what is left add back up to what it cost. A register
  -- where they do not is one an accountant will not use twice.
  if r.book_value_cents + r.depreciated_cents <> r.purchase_price_cents then
    raise exception 'DEPRECIATION FAIL [c]: % + % <> %',
      r.book_value_cents, r.depreciated_cents, r.purchase_price_cents;
  end if;
  if r.months_held <> 60 then
    raise exception 'DEPRECIATION FAIL [c]: five years is % months', r.months_held;
  end if;

  -- Another farm's register is empty, not another farm's.
  if exists (select 1 from public.farm_book_values('de000000-0000-4000-8000-000000000002', null)) then
    raise exception 'DEPRECIATION FAIL [c]: the register crossed the fence';
  end if;
end $$;
reset role;

-- An operator on a farm that has NOT opted operators in gets nothing, exactly as
-- `machine_financials` gives them nothing — including for the machine assigned to them.
set role authenticated;
select _dep_login('de100000-0000-4000-8000-000000000002');
do $$
declare n integer;
begin
  select count(*) into n from public.farm_book_values('de000000-0000-4000-8000-000000000001', null);
  if n <> 0 then
    raise exception 'DEPRECIATION FAIL [c]: an operator read % book values on a cost-closed farm', n;
  end if;
  -- And the raw inputs are not readable either, or the sum could be done by hand.
  if has_column_privilege('authenticated', 'public.machines', 'purchase_price_cents', 'select')
     or has_column_privilege('authenticated', 'public.machines', 'residual_value_cents', 'select')
     or has_column_privilege('authenticated', 'public.machines', 'depreciation_rate_bps', 'select') then
    raise exception 'DEPRECIATION FAIL [c]: the browser can read the inputs and reproduce the sum';
  end if;
end $$;
reset role;

-- A linked workshop can see the machine and has no business with what it is worth.
set role authenticated;
select _dep_login('de100000-0000-4000-8000-000000000003');
do $$
declare n integer;
begin
  select count(*) into n from public.farm_book_values('de000000-0000-4000-8000-000000000001', null);
  if n <> 0 then
    raise exception 'DEPRECIATION FAIL [c]: a linked workshop read % of a farm''s book values', n;
  end if;
end $$;
reset role;

-- ── (d) Only the farm's own owner or manager may set the policy ─────────────
set role authenticated;
select _dep_login('de100000-0000-4000-8000-000000000002');
do $$
declare v_denied boolean := false; m public.machines%rowtype;
begin
  begin
    perform public.set_machine_depreciation(
      'de200000-0000-4000-8000-000000000001', 'straight_line', null, 12, 0, date '2020-01-01');
  exception when others then v_denied := true;
  end;
  if not v_denied then
    raise exception 'DEPRECIATION FAIL [d]: an operator set the farm''s book-value policy';
  end if;
end $$;
reset role;

set role authenticated;
select _dep_login('de100000-0000-4000-8000-000000000003');
do $$
declare v_denied boolean := false;
begin
  begin
    perform public.set_machine_depreciation(
      'de200000-0000-4000-8000-000000000001', 'none', null, null, null, null);
  exception when others then v_denied := true;
  end;
  if not v_denied then
    raise exception 'DEPRECIATION FAIL [d]: a linked workshop set a customer''s book-value policy';
  end if;
end $$;
reset role;

set role authenticated;
select _dep_login('de100000-0000-4000-8000-000000000001');
do $$
declare r record;
begin
  perform public.set_machine_depreciation(
    'de200000-0000-4000-8000-000000000002', 'straight_line', 2000, 60, 5000000, date '2021-06-01');

  -- Read back through the REGISTER, not off the table. `select *` on `machines` is a
  -- permission error for `authenticated` by design (20260903074350 withheld the cost
  -- columns), and the register is the supported way in — so this asserts what the screen
  -- will actually be able to see.
  select * into r from public.farm_book_values('de000000-0000-4000-8000-000000000001', null)
   where machine_id = 'de200000-0000-4000-8000-000000000002';
  if r.method <> 'straight_line' or r.life_months <> 60 then
    raise exception 'DEPRECIATION FAIL [d]: the owner could not set the policy (% / %)',
      r.method, r.life_months;
  end if;
  -- Switching method clears the OTHER method's input, so a rate left over from a previous
  -- policy cannot sit on the row looking like it applies.
  if r.rate_bps is not null then
    raise exception 'DEPRECIATION FAIL [d]: a reducing-balance rate survived a switch to straight line';
  end if;

  -- And going back to `none` clears everything, rather than leaving a policy that is not
  -- in force but is still on the record.
  perform public.set_machine_depreciation('de200000-0000-4000-8000-000000000002', 'none');
  select * into r from public.farm_book_values('de000000-0000-4000-8000-000000000001', null)
   where machine_id = 'de200000-0000-4000-8000-000000000002';
  -- `start_date` is not checked: the register reports `coalesce(depreciation_start_date,
  -- purchase_date)`, so it correctly falls back to the day the machine was bought once the
  -- policy's own start date is cleared.
  if r.life_months is not null or r.residual_value_cents is not null then
    raise exception 'DEPRECIATION FAIL [d]: turning depreciation off left its settings behind';
  end if;
  -- With no policy it is worth what it cost, which is the honest answer until somebody
  -- decides otherwise.
  if r.book_value_cents <> r.purchase_price_cents then
    raise exception 'DEPRECIATION FAIL [d]: a machine with no policy is valued at %', r.book_value_cents;
  end if;
end $$;
reset role;

-- ── (e) Grants ──────────────────────────────────────────────────────────────
do $$
begin
  if has_function_privilege('anon', 'public.farm_book_values(uuid,date)', 'EXECUTE')
     or has_function_privilege('anon', 'public.set_machine_depreciation(uuid,depreciation_method,integer,integer,bigint,date)', 'EXECUTE') then
    raise exception 'DEPRECIATION FAIL [e]: anon may read or set book values';
  end if;
  if not has_function_privilege('authenticated', 'public.farm_book_values(uuid,date)', 'EXECUTE') then
    raise exception 'DEPRECIATION FAIL [e]: the screen cannot ask for the register';
  end if;
  if has_function_privilege('authenticated',
       'app.book_value_cents(bigint,depreciation_method,integer,integer,bigint,date,date)', 'EXECUTE') then
    raise exception 'DEPRECIATION FAIL [e]: the raw sum is reachable from a browser';
  end if;
end $$;

rollback;
