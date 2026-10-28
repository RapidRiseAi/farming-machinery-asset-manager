-- Machinery finance and lease tracking (20261028110000 to 20261028111100).
--
--   (a) the schedule arithmetic, on worked examples the TS tests assert too
--       (src/lib/asset-finance.test.ts): amortisation with interest, a balloon, rounding
--       to the cent, month ends, quarterly, the lender's own figure and the implied rate
--   (b) an owner captures an agreement: schedule, earlier rows taken as paid, costs
--   (c) payments, part payments, refusals, and the balance they produce
--   (d) who sees it: owner and manager yes; mechanic, operator, contractor and the other
--       farm no, through the tables, the history, the documents, the calendar and the
--       cash flow; interest still reaches TCO for those who see costs
--   (e) a rate change rebuilds only the unpaid rows
--   (f) early settlement
--   (g) leases and contracts: costs per payment, VAT, end and renew
--   (h) idempotency of the cost sync and the nightly pass, debit orders, renewals
--   (i) reminders, once each, to owners and managers, with no amounts
--   (j) the old machine lump gives way to an agreement
--   (k) the journal codes interest and leases
--   (l) grants

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

create or replace function _af_login(p_user uuid)
returns void
language sql
as $$
  select pg_catalog.set_config(
    'request.jwt.claims',
    pg_catalog.json_build_object('sub', p_user, 'role', 'authenticated')::text,
    false
  );
$$;
grant execute on function _af_login(uuid) to public;

select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, settings) values
  -- The cheapest plan: finance tracking is core, on every plan.
  ('af000000-0000-4000-8000-000000000001', 'Finance Farm', 'essential', 'active',
   '{"cost_visible_to_operators": false}'::jsonb),
  ('af000000-0000-4000-8000-000000000002', 'Other Farm', 'complete', 'active', '{}'::jsonb);

insert into public.workshops (id, name) values
  ('af300000-0000-4000-8000-000000000001', 'Linked Workshop');
-- The widest contractor link there is, costs included: still no finance.
insert into public.workshop_links (workshop_id, farm_id, status, see_all_vehicles, see_costs) values
  ('af300000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000001', 'active', true, true);

insert into auth.users (id, email) values
  ('af100000-0000-4000-8000-000000000001', 'af-owner@example.test'),
  ('af100000-0000-4000-8000-000000000002', 'af-manager@example.test'),
  ('af100000-0000-4000-8000-000000000003', 'af-mechanic@example.test'),
  ('af100000-0000-4000-8000-000000000004', 'af-operator@example.test'),
  ('af100000-0000-4000-8000-000000000005', 'af-workshop@example.test'),
  ('af100000-0000-4000-8000-000000000006', 'af-neighbour@example.test');

insert into public.users (id, farm_id, workshop_id, role, name, email) values
  ('af100000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000001', null, 'owner', 'Owner', 'af-owner@example.test'),
  ('af100000-0000-4000-8000-000000000002', 'af000000-0000-4000-8000-000000000001', null, 'manager', 'Manager', 'af-manager@example.test'),
  ('af100000-0000-4000-8000-000000000003', 'af000000-0000-4000-8000-000000000001', null, 'mechanic', 'Mechanic', 'af-mechanic@example.test'),
  ('af100000-0000-4000-8000-000000000004', 'af000000-0000-4000-8000-000000000001', null, 'operator', 'Operator', 'af-operator@example.test'),
  ('af100000-0000-4000-8000-000000000005', null, 'af300000-0000-4000-8000-000000000001', 'workshop', 'Workshop', 'af-workshop@example.test'),
  ('af100000-0000-4000-8000-000000000006', 'af000000-0000-4000-8000-000000000002', null, 'owner', 'Neighbour', 'af-neighbour@example.test');

insert into public.machines (id, farm_id, name, type, meter_type, status, assigned_operator_id, purchase_date, purchase_price_cents) values
  ('af200000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000001', 'Financed tractor', 'tractor', 'hours', 'active',
   'af100000-0000-4000-8000-000000000004', date '2026-01-01', 60000000),
  ('af200000-0000-4000-8000-000000000002', 'af000000-0000-4000-8000-000000000002', 'Neighbour tractor', 'tractor', 'hours', 'active',
   null, null, null);

-- == (a) The arithmetic ==========================================================
do $$
declare
  n bigint; c bigint; s bigint; r record;
begin
  -- A: R500 000 at 11.75% over 60 months from 31 January.
  if app.finance_annuity_payment(50000000, 1175, 60, 1, 0) <> 1105916 then
    raise exception 'FINANCE FAIL [a]: annuity is %, expected 1105916', app.finance_annuity_payment(50000000, 1175, 60, 1, 0);
  end if;
  select count(*), sum(capital_cents), sum(interest_cents) into n, c, s
    from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31');
  if n <> 60 or c <> 50000000 then
    raise exception 'FINANCE FAIL [a]: A has % rows and capital %', n, c;
  end if;
  if (select sum(interest_cents) from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31')) <> 16354967 then
    raise exception 'FINANCE FAIL [a]: A interest total wrong';
  end if;
  select * into r from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31') s where s.seq = 1;
  if r.interest_cents <> 489583 or r.capital_cents <> 616333 or r.due_date <> date '2026-01-31' or r.balance_after_cents <> 49383667 then
    raise exception 'FINANCE FAIL [a]: A row 1 is %', row_to_json(r);
  end if;
  select * into r from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31') s where s.seq = 2;
  if r.interest_cents <> 483548 or r.capital_cents <> 622368 or r.due_date <> date '2026-02-28' then
    raise exception 'FINANCE FAIL [a]: A row 2 (month end) is %', row_to_json(r);
  end if;
  -- The last instalment absorbs the rounding cents and lands on the 31st again.
  select * into r from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31') s where s.seq = 60;
  if r.interest_cents + r.capital_cents <> 1105923 or r.capital_cents <> 1095199 or r.balance_after_cents <> 0
     or r.due_date <> date '2030-12-31' then
    raise exception 'FINANCE FAIL [a]: A last row is %', row_to_json(r);
  end if;

  -- B: R1 000 000 at 10.5% over 48 months with a R300 000 balloon.
  select count(*) into n from app.finance_schedule(100000000, 1050, 48, 1, date '2026-03-15', 30000000);
  if n <> 49 then raise exception 'FINANCE FAIL [a]: B has % rows, expected 48 and a balloon', n; end if;
  select * into r from app.finance_schedule(100000000, 1050, 48, 1, date '2026-03-15', 30000000) s where s.seq = 1;
  if r.interest_cents <> 875000 or r.capital_cents <> 1179737 then
    raise exception 'FINANCE FAIL [a]: B row 1 is %', row_to_json(r);
  end if;
  select * into r from app.finance_schedule(100000000, 1050, 48, 1, date '2026-03-15', 30000000) s where s.seq = 48;
  if r.interest_cents + r.capital_cents <> 2054713 or r.balance_after_cents <> 30000000 then
    raise exception 'FINANCE FAIL [a]: B last instalment is %', row_to_json(r);
  end if;
  select * into r from app.finance_schedule(100000000, 1050, 48, 1, date '2026-03-15', 30000000) s where s.seq = 49;
  if r.kind <> 'balloon' or r.capital_cents <> 30000000 or r.interest_cents <> 0 or r.due_date <> date '2030-02-15' then
    raise exception 'FINANCE FAIL [a]: B balloon is %', row_to_json(r);
  end if;
  if (select sum(interest_cents) from app.finance_schedule(100000000, 1050, 48, 1, date '2026-03-15', 30000000)) <> 28627352
     or (select sum(capital_cents) from app.finance_schedule(100000000, 1050, 48, 1, date '2026-03-15', 30000000)) <> 100000000 then
    raise exception 'FINANCE FAIL [a]: B totals wrong';
  end if;

  -- C: R1 000 interest-free over three months: 333.33, 333.33, 333.34.
  if (select string_agg(capital_cents::text, ',' order by seq) from app.finance_schedule(100000, 0, 3, 1, date '2026-11-01'))
     <> '33333,33333,33334' then
    raise exception 'FINANCE FAIL [a]: C rounding wrong';
  end if;

  -- D: quarterly, from the 28th of February.
  if (select string_agg(due_date::text, ',' order by seq) from app.finance_schedule(20000000, 900, 4, 3, date '2026-02-28'))
     <> '2026-02-28,2026-05-28,2026-08-28,2026-11-28' then
    raise exception 'FINANCE FAIL [a]: D dates wrong';
  end if;
  select * into r from app.finance_schedule(20000000, 900, 4, 3, date '2026-02-28') s where s.seq = 4;
  if r.interest_cents + r.capital_cents <> 5284377 or r.interest_cents <> 116282 then
    raise exception 'FINANCE FAIL [a]: D last row is %', row_to_json(r);
  end if;

  -- The rate a lender's figure implies; with a service fee taken off first.
  if app.finance_implied_rate_bps(50000000, 1105900, 60, 1, 0) <> 1175 then
    raise exception 'FINANCE FAIL [a]: implied rate is %', app.finance_implied_rate_bps(50000000, 1105900, 60, 1, 0);
  end if;
  if app.finance_implied_rate_bps(50000000, 1110000 - 6900, 60, 1, 0) <> 1164 then
    raise exception 'FINANCE FAIL [a]: implied rate with a fee is %', app.finance_implied_rate_bps(50000000, 1110000 - 6900, 60, 1, 0);
  end if;
  select * into r from app.finance_schedule(50000000, 1164, 60, 1, date '2026-01-31', 0, 1110000, 6900) s where s.seq = 1;
  if r.interest_cents <> 485000 or r.capital_cents <> 618100 or r.fee_cents <> 6900 then
    raise exception 'FINANCE FAIL [a]: lender figure row 1 is %', row_to_json(r);
  end if;
  select * into r from app.finance_schedule(50000000, 1164, 60, 1, date '2026-01-31', 0, 1110000, 6900) s where s.seq = 60;
  if r.interest_cents + r.capital_cents + r.fee_cents <> 1113865 then
    raise exception 'FINANCE FAIL [a]: lender figure last row is %', row_to_json(r);
  end if;

  -- Refusals, with the reason.
  begin
    perform * from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31', 0, 400000);
    raise exception 'FINANCE FAIL [a]: an instalment below the interest was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-instalment-too-low' then raise; end if;
  end;
  begin
    perform * from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31', 0, 2000000);
    raise exception 'FINANCE FAIL [a]: an instalment that repays early was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-instalment-too-high' then raise; end if;
  end;
  begin
    perform * from app.finance_schedule(50000000, 1175, 60, 1, date '2026-01-31', 50000000);
    raise exception 'FINANCE FAIL [a]: a balloon as large as the loan was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-balloon-too-large' then raise; end if;
  end;

  -- Contract dates: monthly from the 31st, a window, once-off.
  if (select string_agg(d::text, ',') from app.asset_contract_dates(date '2026-01-31', 'monthly', date '2026-02-01', date '2026-04-30') d)
     <> '2026-02-28,2026-03-31,2026-04-30' then
    raise exception 'FINANCE FAIL [a]: contract dates wrong';
  end if;
  if (select count(*) from app.asset_contract_dates(date '2026-05-01', 'once', date '2026-01-01', date '2026-12-31')) <> 1 then
    raise exception 'FINANCE FAIL [a]: a once-off payment is not one date';
  end if;
end $$;

-- == (b) An owner captures an agreement ==========================================
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_m0 date := date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date)::date;
  v_m1 date := (date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date) - interval '1 month')::date;
  v_m2 date := (date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date) - interval '2 months')::date;
  v_id uuid; n bigint; c bigint; r record;
begin
  if not public.can_view_farm_finance('af000000-0000-4000-8000-000000000001') then
    raise exception 'FINANCE FAIL [b]: the owner may not see finance';
  end if;

  -- Example A's terms, first instalment two months ago; the one before last month is paid.
  v_id := public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
    jsonb_build_object('lender', 'Test Bank', 'agreement_number', 'TB-1', 'kind', 'instalment_sale',
      'principal_cents', 50000000, 'deposit_cents', 10000000, 'interest_rate_bps', 1175, 'term_months', 60,
      'frequency', 'monthly', 'start_date', v_m2, 'first_instalment_date', v_m2, 'reminder_lead_days', 7),
    v_m1);

  select count(*), sum(capital_cents) into n, c from public.finance_instalments where agreement_id = v_id;
  if n <> 60 or c <> 50000000 then
    raise exception 'FINANCE FAIL [b]: % rows, capital %', n, c;
  end if;
  select * into r from public.finance_instalments where agreement_id = v_id and seq = 1;
  if r.status <> 'paid' or r.paid_cents <> 1105916 or r.paid_on <> v_m2 or r.interest_cents <> 489583 then
    raise exception 'FINANCE FAIL [b]: row 1 is %', row_to_json(r);
  end if;
  select * into r from public.finance_instalments where agreement_id = v_id and seq = 2;
  if r.status <> 'open' or r.due_date <> v_m1 or r.interest_cents <> 483548 then
    raise exception 'FINANCE FAIL [b]: row 2 is %', row_to_json(r);
  end if;
  if (select end_date from public.finance_agreements where id = v_id) <> (v_m2 + interval '59 months')::date then
    raise exception 'FINANCE FAIL [b]: end date not the last due date';
  end if;

  -- The balance after one paid instalment.
  select * into r from public.finance_agreement_summaries('af000000-0000-4000-8000-000000000001') s where s.agreement_id = v_id;
  if r.instalments <> 60 or r.instalments_paid <> 1 or r.capital_paid_cents <> 616333
     or r.outstanding_capital_cents <> 50000000 - 616333 or r.balance_source <> 'schedule'
     or r.next_seq <> 2 or r.overdue_count < 1 then
    raise exception 'FINANCE FAIL [b]: summary is %', row_to_json(r);
  end if;
end $$;
reset role;

-- The cost ledger: interest per instalment due by today, never capital, never ahead.
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_id uuid; n bigint; c bigint; v_want bigint;
begin
  select id into v_id from public.finance_agreements where agreement_number = 'TB-1';
  select count(*), coalesce(sum(amount_cents), 0) into n, c
    from public.cost_entries
   where source_type = 'finance_instalment' and deleted_at is null
     and source_id in (select id from public.finance_instalments where agreement_id = v_id);
  select sum(interest_cents + fee_cents) into v_want
    from public.finance_instalments where agreement_id = v_id and deleted_at is null and due_date <= v_today;
  if n <> 3 or c <> v_want then
    raise exception 'FINANCE FAIL [b]: % interest entries totalling %, expected 3 totalling %', n, c, v_want;
  end if;
  if exists (select 1 from public.cost_entries where source_type = 'finance_instalment' and deleted_at is null
              and type <> 'finance') then
    raise exception 'FINANCE FAIL [b]: an instalment booked as something other than finance';
  end if;
  -- Capital is the purchase entry, once, and nothing else: no entry carries a capital figure.
  if (select count(*) from public.cost_entries where machine_id = 'af200000-0000-4000-8000-000000000001'
        and type = 'purchase' and deleted_at is null) <> 1 then
    raise exception 'FINANCE FAIL [b]: the purchase entry changed';
  end if;
  if exists (select 1 from public.cost_entries ce
               join public.finance_instalments i on i.id = ce.source_id
              where ce.source_type = 'finance_instalment' and ce.deleted_at is null
                and ce.amount_cents <> i.interest_cents + i.fee_cents) then
    raise exception 'FINANCE FAIL [b]: an instalment cost is not its interest and fee';
  end if;
  if (select coalesce(sum(amount_cents), 0) from public.cost_entries
       where machine_id = 'af200000-0000-4000-8000-000000000001' and deleted_at is null)
     <> 60000000 + v_want then
    raise exception 'FINANCE FAIL [b]: TCO is not the price plus the interest due';
  end if;
end $$;

-- == (c) Payments ================================================================
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000002');
do $$
declare
  v_id uuid; v_row2 uuid; v_row3 uuid; v_row4 uuid; r record; v_paid bigint; v_int3 bigint;
begin
  select id into v_id from public.finance_agreements where agreement_number = 'TB-1';
  if v_id is null then raise exception 'FINANCE FAIL [c]: the manager cannot read the agreement'; end if;
  select id into v_row2 from public.finance_instalments where agreement_id = v_id and seq = 2;
  select id, interest_cents into v_row3, v_int3 from public.finance_instalments where agreement_id = v_id and seq = 3;
  select id into v_row4 from public.finance_instalments where agreement_id = v_id and seq = 4;

  -- In full, with a reference.
  v_paid := public.finance_record_payment(v_row2, null, null, 'EFT 2');
  if v_paid <> 1105916 then raise exception 'FINANCE FAIL [c]: paid total is %', v_paid; end if;
  if (select status from public.finance_instalments where id = v_row2) <> 'paid' then
    raise exception 'FINANCE FAIL [c]: a full payment did not mark the row paid';
  end if;

  -- A part payment smaller than the interest covers no capital.
  perform public.finance_record_payment(v_row3, 100000);
  select * into r from public.finance_agreement_summaries('af000000-0000-4000-8000-000000000001') s where s.agreement_id = v_id;
  if r.capital_paid_cents <> 616333 + 622368 or r.outstanding_capital_cents <> 50000000 - 616333 - 622368 then
    raise exception 'FINANCE FAIL [c]: a part payment moved capital: %', row_to_json(r);
  end if;
  if (select status from public.finance_instalments where id = v_row3) <> 'open' then
    raise exception 'FINANCE FAIL [c]: a part-paid row is not open';
  end if;
  -- The rest of it.
  perform public.finance_record_payment(v_row3);
  if (select status from public.finance_instalments where id = v_row3) <> 'paid' then
    raise exception 'FINANCE FAIL [c]: the rest of a part payment did not close the row';
  end if;

  begin
    perform public.finance_record_payment(v_row4, 99999999);
    raise exception 'FINANCE FAIL [c]: an overpayment was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-payment-too-much' then raise; end if;
  end;
  begin
    perform public.finance_record_payment(v_row4, null, ((now() at time zone 'Africa/Johannesburg')::date + 5));
    raise exception 'FINANCE FAIL [c]: a payment dated in the future was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-payment-future' then raise; end if;
  end;

  -- A payment recorded by mistake is cleared, then recorded again.
  perform public.finance_clear_payment(v_row3);
  if (select paid_cents from public.finance_instalments where id = v_row3) <> 0 then
    raise exception 'FINANCE FAIL [c]: clearing left a payment';
  end if;
  perform public.finance_record_payment(v_row3);

  -- Editing a row: its interest stays, the difference is capital, balances follow.
  perform public.finance_update_instalment(v_row4, (select due_date from public.finance_instalments where id = v_row4),
    (select amount_cents + 5000 from public.finance_instalments where id = v_row4));
  if (select balance_after_cents from public.finance_instalments where agreement_id = v_id and seq = 4)
     <> 50000000 - (select sum(capital_cents) from public.finance_instalments where agreement_id = v_id and seq <= 4) then
    raise exception 'FINANCE FAIL [c]: balances not recomputed after an edit';
  end if;
  begin
    perform public.finance_update_instalment(v_row4, current_date, 10);
    raise exception 'FINANCE FAIL [c]: an instalment below its interest was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-instalment-below-interest' then raise; end if;
  end;
end $$;
reset role;

-- == (d) Who sees it =============================================================
-- Documents: the owner attaches the signed agreement.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
insert into public.attachments (farm_id, parent_type, parent_id, kind, storage_path)
select 'af000000-0000-4000-8000-000000000001', 'finance_agreement', a.id, 'doc',
       'af000000-0000-4000-8000-000000000001/' || a.id || '/agreement.pdf'
  from public.finance_agreements a where a.agreement_number = 'TB-1';
reset role;

-- The mechanic: sees costs (so interest in TCO), never the agreement.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000003');
do $$
declare n bigint; v_agreement uuid;
begin
  if public.can_view_farm_finance('af000000-0000-4000-8000-000000000001') then
    raise exception 'FINANCE FAIL [d]: the mechanic may see finance';
  end if;
  select count(*) into n from public.finance_agreements;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the mechanic reads % agreements', n; end if;
  select count(*) into n from public.finance_instalments;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the mechanic reads % instalments', n; end if;
  select count(*) into n from public.asset_contracts;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the mechanic reads % contracts', n; end if;
  select count(*) into n from public.finance_agreement_summaries('af000000-0000-4000-8000-000000000001');
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the mechanic reads % summaries', n; end if;
  select count(*) into n from public.attachments where parent_type in ('finance_agreement', 'asset_contract');
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the mechanic reads % finance documents', n; end if;
  select count(*) into n from public.audit_log
   where entity in ('finance_agreements', 'finance_instalments', 'asset_contracts')
      or (entity = 'attachments' and diff -> 'new' ->> 'parent_type' = 'finance_agreement');
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the mechanic reads % finance history rows', n; end if;
  -- ...but the interest is in the costs a mechanic already sees.
  select count(*) into n from public.cost_entries where source_type = 'finance_instalment';
  if n = 0 then raise exception 'FINANCE FAIL [d]: interest is missing from the mechanic''s costs'; end if;
  -- And no door through a write function.
  begin
    perform public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
      jsonb_build_object('lender', 'X', 'principal_cents', 100, 'interest_rate_bps', 0, 'term_months', 1,
        'start_date', current_date, 'first_instalment_date', current_date));
    raise exception 'FINANCE FAIL [d]: the mechanic created an agreement';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.attachments (farm_id, parent_type, parent_id, kind, storage_path)
    values ('af000000-0000-4000-8000-000000000001', 'asset_contract', gen_random_uuid(), 'doc', 'x/y.pdf');
    raise exception 'FINANCE FAIL [d]: the mechanic attached a finance document';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Owner and manager do see the history.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000002');
do $$ begin
  if not exists (select 1 from public.audit_log where entity = 'finance_instalments') then
    raise exception 'FINANCE FAIL [d]: the manager cannot read finance history';
  end if;
  if not exists (select 1 from public.attachments where parent_type = 'finance_agreement') then
    raise exception 'FINANCE FAIL [d]: the manager cannot read the agreement document';
  end if;
end $$;
reset role;

-- The operator: no costs on this farm, no finance either.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000004');
do $$
declare n bigint;
begin
  select count(*) into n from public.finance_agreements;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the operator reads % agreements', n; end if;
  select count(*) into n from public.finance_instalments;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the operator reads % instalments', n; end if;
  select count(*) into n from public.cost_entries where source_type = 'finance_instalment';
  if n <> 0 then raise exception 'FINANCE FAIL [d]: an opted-out operator reads interest costs'; end if;
end $$;
reset role;

-- The contractor with every grant, costs included.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000005');
do $$
declare n bigint;
begin
  if public.can_view_farm_finance('af000000-0000-4000-8000-000000000001') then
    raise exception 'FINANCE FAIL [d]: the contractor may see finance';
  end if;
  select count(*) into n from public.finance_agreements;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the contractor reads % agreements', n; end if;
  select count(*) into n from public.finance_instalments;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the contractor reads % instalments', n; end if;
  select count(*) into n from public.attachments where parent_type = 'finance_agreement';
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the contractor reads finance documents'; end if;
end $$;
reset role;

-- The other farm's owner.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000006');
do $$
declare n bigint; v_row uuid;
begin
  select count(*) into n from public.finance_agreements;
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the neighbour reads % agreements', n; end if;
  select count(*) into n from public.finance_agreement_summaries('af000000-0000-4000-8000-000000000001');
  if n <> 0 then raise exception 'FINANCE FAIL [d]: the neighbour reads summaries'; end if;
  begin
    perform public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
      jsonb_build_object('lender', 'X', 'principal_cents', 100, 'interest_rate_bps', 0, 'term_months', 1,
        'start_date', current_date, 'first_instalment_date', current_date));
    raise exception 'FINANCE FAIL [d]: the neighbour financed another farm''s machine';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$
declare v_row uuid;
begin
  select i.id into v_row from public.finance_instalments i
    join public.finance_agreements a on a.id = i.agreement_id
   where a.agreement_number = 'TB-1' and i.seq = 10;
  perform _af_login('af100000-0000-4000-8000-000000000006');
  set local role authenticated;
  begin
    perform public.finance_record_payment(v_row);
    raise exception 'FINANCE FAIL [d]: the neighbour paid another farm''s instalment';
  exception when insufficient_privilege then null;
  end;
  reset role;
end $$;

-- == (e) A rate change rebuilds only the unpaid rows ===============================
do $$
declare
  v_id uuid; v_before text; v_after text; v_fields jsonb; r record;
begin
  select id into v_id from public.finance_agreements where agreement_number = 'TB-1';
  select string_agg(id::text || ':' || amount_cents, ',' order by seq) into v_before
    from public.finance_instalments where agreement_id = v_id and deleted_at is null and seq <= 3;
  select jsonb_build_object('lender', lender, 'agreement_number', agreement_number, 'kind', kind,
           'principal_cents', principal_cents, 'deposit_cents', deposit_cents, 'interest_rate_bps', 1275,
           'term_months', term_months, 'frequency', frequency, 'start_date', start_date,
           'first_instalment_date', first_instalment_date, 'reminder_lead_days', reminder_lead_days)
    into v_fields from public.finance_agreements where id = v_id;

  perform _af_login('af100000-0000-4000-8000-000000000001');
  set local role authenticated;
  perform public.finance_save_agreement(v_id, null, v_fields);
  reset role;

  select string_agg(id::text || ':' || amount_cents, ',' order by seq) into v_after
    from public.finance_instalments where agreement_id = v_id and deleted_at is null and seq <= 3;
  if v_before <> v_after then
    raise exception 'FINANCE FAIL [e]: paid rows changed: % then %', v_before, v_after;
  end if;
  if (select count(*) from public.finance_instalments where agreement_id = v_id and deleted_at is null) <> 60
     or (select sum(capital_cents) from public.finance_instalments where agreement_id = v_id and deleted_at is null) <> 50000000 then
    raise exception 'FINANCE FAIL [e]: the rebuilt schedule does not repay the principal';
  end if;
  select i4.interest_cents as int4, i3.balance_after_cents as bal3 into r
    from public.finance_instalments i4, public.finance_instalments i3
   where i4.agreement_id = v_id and i4.seq = 4 and i4.deleted_at is null
     and i3.agreement_id = v_id and i3.seq = 3 and i3.deleted_at is null;
  if r.int4 <> round(r.bal3::numeric * 1275 / 12000 / 10) then
    raise exception 'FINANCE FAIL [e]: row 4 is not charged at the new rate: %', row_to_json(r);
  end if;
end $$;

-- == (f) Early settlement ==========================================================
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_m2 date := (date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date) - interval '2 months')::date;
  v_id uuid; r record;
begin
  -- Example B, with a balloon; nothing marked paid.
  v_id := public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
    jsonb_build_object('lender', 'Balloon Bank', 'agreement_number', 'BB-1', 'principal_cents', 100000000,
      'interest_rate_bps', 1050, 'term_months', 48, 'start_date', v_m2, 'first_instalment_date', v_m2,
      'balloon_cents', 30000000));
  if (select count(*) from public.finance_instalments where agreement_id = v_id and kind = 'balloon') <> 1 then
    raise exception 'FINANCE FAIL [f]: no balloon row';
  end if;
  select * into r from public.finance_agreement_summaries('af000000-0000-4000-8000-000000000001') s where s.agreement_id = v_id;
  if r.outstanding_capital_cents <> 100000000 then
    raise exception 'FINANCE FAIL [f]: unpaid agreement owes %', r.outstanding_capital_cents;
  end if;

  -- Settled for the capital plus R250 of interest to the day.
  perform public.finance_settle_agreement(v_id, v_today, 100000000 + 25000);
  if (select status from public.finance_agreements where id = v_id) <> 'settled'
     or (select settlement_charge_cents from public.finance_agreements where id = v_id) <> 25000 then
    raise exception 'FINANCE FAIL [f]: the settlement was not recorded';
  end if;
  if exists (select 1 from public.finance_instalments where agreement_id = v_id and status = 'open') then
    raise exception 'FINANCE FAIL [f]: rows left open after settlement';
  end if;
  select * into r from public.finance_agreement_summaries('af000000-0000-4000-8000-000000000001') s where s.agreement_id = v_id;
  if r.balance_cents <> 0 or r.balance_source <> 'closed' or r.next_due_date is not null then
    raise exception 'FINANCE FAIL [f]: a settled agreement still owes: %', row_to_json(r);
  end if;
  begin
    perform public.finance_record_payment((select id from public.finance_instalments where agreement_id = v_id and seq = 10));
    raise exception 'FINANCE FAIL [f]: a payment on a settled agreement was accepted';
  exception when others then
    if sqlerrm <> 'finance-not-active' then raise; end if;
  end;
end $$;
reset role;

do $$
declare v_id uuid;
begin
  select id into v_id from public.finance_agreements where agreement_number = 'BB-1';
  -- The settlement charge is booked once; settled rows accrue nothing.
  if (select coalesce(sum(amount_cents), 0) from public.cost_entries
       where source_type = 'finance_settlement' and source_id = v_id and deleted_at is null) <> 25000 then
    raise exception 'FINANCE FAIL [f]: settlement charge not booked';
  end if;
  if exists (select 1 from public.cost_entries ce join public.finance_instalments i on i.id = ce.source_id
              where ce.source_type = 'finance_instalment' and ce.deleted_at is null
                and i.agreement_id = v_id) then
    raise exception 'FINANCE FAIL [f]: interest booked for rows the settlement closed';
  end if;
end $$;

-- == (g) Leases and contracts ======================================================
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_m0 date := date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date)::date;
  v_m2 date := (date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date) - interval '2 months')::date;
  v_lease uuid; v_service uuid; v_invoiced uuid; n bigint;
begin
  -- A farm-wide lease, R5 000 a month ex-VAT plus VAT, two months in; notice 60 days.
  v_lease := public.asset_contract_save(null, 'af000000-0000-4000-8000-000000000001',
    jsonb_build_object('kind', 'operating_lease', 'party', 'Lease Co', 'reference', 'LC-1',
      'start_date', v_m2, 'end_date', (v_m0 + interval '10 months')::date, 'amount_cents', 500000,
      'vat_charged', true, 'frequency', 'monthly', 'notice_days', 60, 'reminder_lead_days', 30));
  if (select vat_rate_bps from public.asset_contracts where id = v_lease) <> 1500 then
    raise exception 'FINANCE FAIL [g]: the farm VAT rate was not captured';
  end if;
  if (select notice_date from public.asset_contracts where id = v_lease) <> ((v_m0 + interval '10 months')::date - 60) then
    raise exception 'FINANCE FAIL [g]: notice date wrong';
  end if;

  -- A service plan on the tractor: booked as 'other'.
  v_service := public.asset_contract_save(null, 'af000000-0000-4000-8000-000000000001',
    jsonb_build_object('kind', 'service_contract', 'party', 'Dealer', 'machine_id', 'af200000-0000-4000-8000-000000000001',
      'start_date', v_m2, 'amount_cents', 120000, 'frequency', 'monthly'));

  -- One already invoiced by a contractor: books nothing.
  v_invoiced := public.asset_contract_save(null, 'af000000-0000-4000-8000-000000000001',
    jsonb_build_object('kind', 'maintenance_plan', 'party', 'Invoiced Co', 'start_date', v_m2,
      'amount_cents', 99900, 'frequency', 'monthly', 'post_costs', false));

  -- A machine of another farm is refused.
  begin
    perform public.asset_contract_save(null, 'af000000-0000-4000-8000-000000000001',
      jsonb_build_object('kind', 'rental', 'party', 'X', 'machine_id', 'af200000-0000-4000-8000-000000000002',
        'start_date', v_m2, 'amount_cents', 1));
    raise exception 'FINANCE FAIL [g]: a contract on another farm''s machine was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'finance-machine-invalid' then raise; end if;
  end;

  -- Cash flow: the lease's next payment is gross R5 750.
  select count(*) into n from public.farm_finance_commitments('af000000-0000-4000-8000-000000000001', v_today + 1, v_today + 400)
   where kind = 'contract_payment' and source_id = v_lease and amount_cents = 500000 and vat_cents = 75000;
  if n < 9 then raise exception 'FINANCE FAIL [g]: % lease payments ahead', n; end if;
  if not exists (select 1 from public.farm_finance_commitments('af000000-0000-4000-8000-000000000001', v_today, v_today + 400)
                  where kind = 'contract_notice' and source_id = v_lease) then
    raise exception 'FINANCE FAIL [g]: the notice date is not in the cash flow list';
  end if;
end $$;
reset role;

do $$
declare
  v_lease uuid; v_service uuid; v_invoiced uuid; n bigint;
begin
  select id into v_lease from public.asset_contracts where party = 'Lease Co';
  select id into v_service from public.asset_contracts where party = 'Dealer';
  select id into v_invoiced from public.asset_contracts where party = 'Invoiced Co';
  -- Three payments have fallen due (two months ago, last month, this month's first).
  if (select count(*) from public.cost_entries where source_type = 'asset_contract' and source_id = v_lease
        and deleted_at is null and type = 'lease' and amount_cents = 500000 and vat_rate_bps = 1500 and machine_id is null) <> 3 then
    raise exception 'FINANCE FAIL [g]: lease payments not booked as three lease entries';
  end if;
  if (select count(*) from public.cost_entries where source_type = 'asset_contract' and source_id = v_service
        and deleted_at is null and type = 'other' and machine_id = 'af200000-0000-4000-8000-000000000001') <> 3 then
    raise exception 'FINANCE FAIL [g]: service plan payments not booked on the tractor';
  end if;
  if exists (select 1 from public.cost_entries where source_type = 'asset_contract' and source_id = v_invoiced) then
    raise exception 'FINANCE FAIL [g]: a contract with post_costs off booked costs';
  end if;
end $$;

-- End early and renew.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
do $$
declare
  v_m0 date := date_trunc('month', (now() at time zone 'Africa/Johannesburg')::date)::date;
  v_service uuid;
begin
  select id into v_service from public.asset_contracts where party = 'Dealer';
  -- Ended the day before this month began: this month's payment is withdrawn.
  perform public.asset_contract_end(v_service, v_m0 - 1);
  if (select status from public.asset_contracts where id = v_service) <> 'ended' then
    raise exception 'FINANCE FAIL [g]: the contract did not end';
  end if;
  perform public.asset_contract_renew(v_service, (v_m0 + interval '12 months')::date, 130000);
  if (select status from public.asset_contracts where id = v_service) <> 'active'
     or (select amount_cents from public.asset_contracts where id = v_service) <> 130000 then
    raise exception 'FINANCE FAIL [g]: the renewal did not take';
  end if;
  begin
    perform public.asset_contract_renew(v_service, v_m0, null);
    raise exception 'FINANCE FAIL [g]: a renewal to an earlier date was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'contract-renew-date' then raise; end if;
  end;
end $$;
reset role;

do $$
declare v_service uuid;
begin
  select id into v_service from public.asset_contracts where party = 'Dealer';
  -- Renewed at the new amount: this month's payment is booked again, at R1 300.
  if (select count(*) from public.cost_entries where source_type = 'asset_contract' and source_id = v_service
        and deleted_at is null) <> 3
     or (select count(*) from public.cost_entries where source_type = 'asset_contract' and source_id = v_service
        and deleted_at is null and amount_cents = 130000) <> 3 then
    raise exception 'FINANCE FAIL [g]: renewed contract costs wrong';
  end if;
end $$;

-- == (h) Idempotent, and the nightly pass ==========================================
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_before bigint; v_after bigint; v_sum_before bigint; v_sum_after bigint; v_id uuid; v_c uuid;
begin
  select count(*), sum(amount_cents) into v_before, v_sum_before
    from public.cost_entries where farm_id = 'af000000-0000-4000-8000-000000000001' and deleted_at is null;
  perform app.sync_asset_finance_costs('af000000-0000-4000-8000-000000000001');
  perform app.sync_asset_finance_costs('af000000-0000-4000-8000-000000000001');
  perform app.asset_finance_nightly(null);
  select count(*), sum(amount_cents) into v_after, v_sum_after
    from public.cost_entries where farm_id = 'af000000-0000-4000-8000-000000000001' and deleted_at is null;
  if v_before <> v_after or v_sum_before <> v_sum_after then
    raise exception 'FINANCE FAIL [h]: a second run changed the ledger: % / % then % / %', v_before, v_sum_before, v_after, v_sum_after;
  end if;

  -- A debit-order agreement: the nightly pass pays what is due, on its due date.
  perform _af_login('af100000-0000-4000-8000-000000000001');
  set local role authenticated;
  v_id := public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
    jsonb_build_object('lender', 'Debit Bank', 'agreement_number', 'DB-1', 'principal_cents', 2400000,
      'interest_rate_bps', 0, 'term_months', 24, 'start_date', v_today - 40, 'first_instalment_date', v_today - 40,
      'auto_mark_paid', true));
  -- An auto-renewing contract already past its end date.
  v_c := public.asset_contract_save(null, 'af000000-0000-4000-8000-000000000001',
    jsonb_build_object('kind', 'insurance', 'party', 'Insurer', 'start_date', v_today - 400,
      'end_date', v_today - 30, 'amount_cents', 0, 'frequency', 'annual', 'auto_renews', true, 'renewal_months', 12));
  reset role;

  perform app.asset_finance_nightly(null);
  if (select count(*) from public.finance_instalments where agreement_id = v_id and status = 'paid') <> 2 then
    raise exception 'FINANCE FAIL [h]: the debit order did not pay the two due instalments';
  end if;
  if (select end_date from public.asset_contracts where id = v_c) <> ((v_today - 30) + interval '12 months')::date then
    raise exception 'FINANCE FAIL [h]: the auto-renewing contract did not roll on';
  end if;
end $$;

-- == (i) Reminders =================================================================
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  v_due uuid; v_late uuid; v_c uuid; n bigint;
begin
  perform _af_login('af100000-0000-4000-8000-000000000001');
  set local role authenticated;
  -- Due in five days, lead seven: reminded.
  v_due := public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
    jsonb_build_object('lender', 'Soon Bank', 'agreement_number', 'SB-1', 'principal_cents', 1200000,
      'interest_rate_bps', 0, 'term_months', 12, 'start_date', v_today + 5, 'first_instalment_date', v_today + 5,
      'reminder_lead_days', 7));
  -- Three days late and unpaid: one overdue reminder.
  v_late := public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000001',
    jsonb_build_object('lender', 'Late Bank', 'agreement_number', 'LB-1', 'principal_cents', 1200000,
      'interest_rate_bps', 0, 'term_months', 12, 'start_date', v_today - 3, 'first_instalment_date', v_today - 3,
      'reminder_lead_days', 7));
  -- Notice due in ten days.
  v_c := public.asset_contract_save(null, 'af000000-0000-4000-8000-000000000001',
    jsonb_build_object('kind', 'rental', 'party', 'Notice Co', 'start_date', v_today - 100,
      'end_date', v_today + 40, 'notice_days', 30, 'amount_cents', 100000, 'reminder_lead_days', 30));
  reset role;

  delete from public.notifications where farm_id = 'af000000-0000-4000-8000-000000000001';
  perform app.enqueue_asset_finance_reminders(null);
  perform app.enqueue_asset_finance_reminders(null);

  select count(*) into n from public.notifications
   where template = 'finance_instalment_due' and payload ->> 'agreement_id' = v_due::text;
  if n <> 2 then raise exception 'FINANCE FAIL [i]: % due reminders, expected one each for owner and manager', n; end if;
  select count(*) into n from public.notifications
   where template = 'finance_instalment_overdue' and payload ->> 'agreement_id' = v_late::text;
  if n <> 2 then raise exception 'FINANCE FAIL [i]: % overdue reminders, expected 2', n; end if;
  select count(*) into n from public.notifications
   where template = 'contract_notice_due' and payload ->> 'contract_id' = v_c::text;
  if n <> 2 then raise exception 'FINANCE FAIL [i]: % notice reminders, expected 2', n; end if;
  if exists (select 1 from public.notifications
              where farm_id = 'af000000-0000-4000-8000-000000000001'
                and user_id not in ('af100000-0000-4000-8000-000000000001', 'af100000-0000-4000-8000-000000000002')) then
    raise exception 'FINANCE FAIL [i]: a finance reminder went to somebody other than the owner and manager';
  end if;
  if exists (select 1 from public.notifications n2, jsonb_object_keys(n2.payload) k
              where n2.farm_id = 'af000000-0000-4000-8000-000000000001'
                and (k like '%\_cents' escape '\' or k in ('amount', 'cost', 'total'))) then
    raise exception 'FINANCE FAIL [i]: a reminder carries an amount';
  end if;
  -- Nothing for a debit order past due, or for years-old arrears.
  if exists (select 1 from public.notifications where template = 'finance_instalment_overdue'
              and payload ->> 'lender' in ('Debit Bank', 'Test Bank', 'Balloon Bank')) then
    raise exception 'FINANCE FAIL [i]: an overdue reminder for a debit order or an old row';
  end if;
end $$;

-- The calendar: finance dates for the owner, none for the mechanic.
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
do $$
declare v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  if not exists (select 1 from public.farm_calendar('af000000-0000-4000-8000-000000000001', v_today, v_today + 60)
                  where kind = 'finance_instalment') then
    raise exception 'FINANCE FAIL [i]: no instalment on the owner''s calendar';
  end if;
  if not exists (select 1 from public.farm_calendar('af000000-0000-4000-8000-000000000001', v_today, v_today + 60)
                  where kind = 'contract_notice') then
    raise exception 'FINANCE FAIL [i]: no notice date on the owner''s calendar';
  end if;
end $$;
reset role;

set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000003');
do $$
declare v_today date := (now() at time zone 'Africa/Johannesburg')::date;
begin
  if exists (select 1 from public.farm_calendar('af000000-0000-4000-8000-000000000001', v_today - 400, v_today + 400)
              where kind in ('finance_instalment', 'contract_notice', 'contract_end')) then
    raise exception 'FINANCE FAIL [i]: finance dates on the mechanic''s calendar';
  end if;
  if exists (select 1 from public.farm_finance_commitments('af000000-0000-4000-8000-000000000001', v_today - 400, v_today + 400)) then
    raise exception 'FINANCE FAIL [i]: the mechanic reads the cash flow';
  end if;
end $$;
reset role;

-- == (j) The old machine lump gives way ==========================================
do $$
declare v_id uuid;
begin
  insert into public.machines (id, farm_id, name, type, meter_type, status, purchase_date, purchase_price_cents,
    finance_provider, finance_total_cents, finance_monthly_cents, finance_term_months, finance_interest_bps)
  values ('af200000-0000-4000-8000-000000000003', 'af000000-0000-4000-8000-000000000001', 'Old note tractor',
    'tractor', 'hours', 'active', date '2026-01-01', 30000000, 'Old Bank', 20000000, 500000, 48, 1100);
  if not exists (select 1 from public.cost_entries where source_type = 'machine_finance'
                  and source_id = 'af200000-0000-4000-8000-000000000003' and deleted_at is null) then
    raise exception 'FINANCE FAIL [j]: the legacy lump was not booked for a machine without an agreement';
  end if;
  perform _af_login('af100000-0000-4000-8000-000000000001');
  set local role authenticated;
  v_id := public.finance_save_agreement(null, 'af200000-0000-4000-8000-000000000003',
    jsonb_build_object('lender', 'Old Bank', 'principal_cents', 20000000, 'interest_rate_bps', 1100,
      'term_months', 48, 'start_date', date '2026-01-01', 'first_instalment_date', date '2026-02-01'));
  reset role;
  if exists (select 1 from public.cost_entries where source_type = 'machine_finance'
              and source_id = 'af200000-0000-4000-8000-000000000003' and deleted_at is null) then
    raise exception 'FINANCE FAIL [j]: the lump and the agreement both count the interest';
  end if;
  -- An older build writing the fields again does not bring it back.
  update public.machines set finance_monthly_cents = 510000 where id = 'af200000-0000-4000-8000-000000000003';
  if exists (select 1 from public.cost_entries where source_type = 'machine_finance'
              and source_id = 'af200000-0000-4000-8000-000000000003' and deleted_at is null) then
    raise exception 'FINANCE FAIL [j]: the lump came back beside an agreement';
  end if;

  -- Removing an agreement withdraws its interest.
  perform _af_login('af100000-0000-4000-8000-000000000001');
  set local role authenticated;
  perform public.finance_delete_agreement(v_id);
  reset role;
  if exists (select 1 from public.cost_entries ce join public.finance_instalments i on i.id = ce.source_id
              where ce.source_type = 'finance_instalment' and ce.deleted_at is null and i.agreement_id = v_id) then
    raise exception 'FINANCE FAIL [j]: a removed agreement left its interest in the ledger';
  end if;
end $$;

-- == (k) The journal ===============================================================
set role authenticated;
select _af_login('af100000-0000-4000-8000-000000000001');
do $$
declare
  v_today date := (now() at time zone 'Africa/Johannesburg')::date;
  r record;
begin
  select sum(debit_cents) as dr, sum(credit_cents) as cr,
         count(*) filter (where account_code = '6250' and account_key = 'cost_lease' and vat_code = 'STD') as lease_lines,
         count(*) filter (where account_code = '6200' and vat_code = 'NONE' and line_no = 1) as interest_lines,
         count(*) filter (where account_code = '6250' and (vat_rate_bps > 0) <> (vat_code = 'STD')) as lease_wrong
    into r
    from public.farm_journal('af000000-0000-4000-8000-000000000001', v_today - 400, v_today);
  if r.dr <> r.cr then raise exception 'FINANCE FAIL [k]: the journal does not balance'; end if;
  if r.lease_lines < 3 or r.lease_wrong > 0 then
    raise exception 'FINANCE FAIL [k]: lease lines % (wrong VAT %)', r.lease_lines, r.lease_wrong;
  end if;
  if r.interest_lines < 3 then raise exception 'FINANCE FAIL [k]: interest lines %', r.interest_lines; end if;
  -- The assistant's columns still add up to its total with leases in the ledger.
  if exists (select 1 from public.assistant_cost_summary('af000000-0000-4000-8000-000000000001', v_today - 400, v_today, 'month')
              where total_cents <> fuel_cents + parts_cents + labour_cents + invoice_cents + other_cents
                                   + purchase_cents + finance_cents) then
    raise exception 'FINANCE FAIL [k]: the assistant total no longer equals its columns';
  end if;
end $$;
reset role;

-- == (l) Grants ====================================================================
do $$ begin
  if has_table_privilege('authenticated', 'public.finance_agreements', 'insert')
     or has_table_privilege('authenticated', 'public.finance_instalments', 'update')
     or has_table_privilege('authenticated', 'public.asset_contracts', 'delete') then
    raise exception 'FINANCE FAIL [l]: browser clients can write finance tables directly';
  end if;
  if has_table_privilege('anon', 'public.finance_agreements', 'select')
     or has_table_privilege('anon', 'public.asset_contracts', 'select') then
    raise exception 'FINANCE FAIL [l]: anon can read finance tables';
  end if;
  if has_function_privilege('anon', 'public.finance_save_agreement(uuid,uuid,jsonb,date)', 'execute')
     or has_function_privilege('anon', 'public.asset_contract_save(uuid,uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.can_view_farm_finance(uuid)', 'execute')
     or has_function_privilege('anon', 'public.farm_finance_commitments(uuid,date,date)', 'execute') then
    raise exception 'FINANCE FAIL [l]: anon can execute a finance function';
  end if;
  if has_function_privilege('authenticated', 'app.sync_asset_finance_costs(uuid,date)', 'execute')
     or has_function_privilege('authenticated', 'public.cron_asset_finance_nightly()', 'execute')
     or has_function_privilege('authenticated', 'public.cron_enqueue_asset_finance_reminders()', 'execute') then
    raise exception 'FINANCE FAIL [l]: a signed-in user can run the engines';
  end if;
  if not has_function_privilege('service_role', 'public.cron_asset_finance_nightly()', 'execute')
     or not has_function_privilege('service_role', 'public.cron_enqueue_asset_finance_reminders()', 'execute') then
    raise exception 'FINANCE FAIL [l]: the nightly route cannot run the engines';
  end if;
end $$;

rollback;
