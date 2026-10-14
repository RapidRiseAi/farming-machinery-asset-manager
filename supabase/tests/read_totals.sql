\set ON_ERROR_STOP on
-- Database totals for screens that summed rows the API caps at a thousand
-- (20261013090000): the machines list's lifetime cost per machine, a partner's expense
-- figures, and Rapid Rise's per-farm and per-partner activity. Each under the caller's own
-- policies.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('ae000000-0000-4000-9000-000000000001', 'Totals farm', 'complete', 'active'),
  ('ae000000-0000-4000-9000-000000000002', 'Totals other farm', 'complete', 'active');
insert into auth.users (id, email) values
  ('ae100000-0000-4000-9000-000000000001', 'totals.owner@example.test'),
  ('ae100000-0000-4000-9000-000000000002', 'totals.operator@example.test'),
  ('ae100000-0000-4000-9000-000000000003', 'totals.other@example.test'),
  ('ae100000-0000-4000-9000-000000000004', 'totals.admin@example.test'),
  ('ae100000-0000-4000-9000-000000000005', 'totals.gone@example.test');
insert into public.users (id, farm_id, role, name, email, active) values
  ('ae100000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'owner',    'Owner',    'totals.owner@example.test', true),
  ('ae100000-0000-4000-9000-000000000002', 'ae000000-0000-4000-9000-000000000001', 'operator', 'Operator', 'totals.operator@example.test', true),
  ('ae100000-0000-4000-9000-000000000003', 'ae000000-0000-4000-9000-000000000002', 'owner',    'Other',    'totals.other@example.test', true),
  ('ae100000-0000-4000-9000-000000000004', null,                                   'rr_admin', 'Admin',    'totals.admin@example.test', true),
  ('ae100000-0000-4000-9000-000000000005', 'ae000000-0000-4000-9000-000000000001', 'operator', 'Gone',     'totals.gone@example.test', false);
insert into public.machines (id, farm_id, name, type, meter_type, status, deleted_at) values
  ('ae200000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'Red tractor',   'tractor', 'hours', 'active', null),
  ('ae200000-0000-4000-9000-000000000002', 'ae000000-0000-4000-9000-000000000001', 'White bakkie',  'bakkie',  'km',    'active', null),
  ('ae200000-0000-4000-9000-000000000003', 'ae000000-0000-4000-9000-000000000001', 'Sold disc',     'implement', 'none',  'active', now()),
  ('ae200000-0000-4000-9000-000000000004', 'ae000000-0000-4000-9000-000000000002', 'Other tractor', 'tractor', 'hours', 'active', null);

-- Red tractor: 1 500 + 2 500 + a 400 credit = 3 600, plus a deleted 99 999 that must not
-- count. White bakkie: 700. A farm-level entry (no machine) belongs to no machine. The
-- other farm's tractor: 5 000.
insert into public.cost_entries (farm_id, machine_id, type, amount_cents, occurred_on, source_type, note, deleted_at) values
  ('ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000001', 'parts',    150000, date '2026-09-12', 'manual', 'Filters', null),
  ('ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000001', 'purchase', 250000, date '2020-01-01', 'manual', 'Bought', null),
  ('ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000001', 'other',    -40000, date '2026-09-20', 'manual', 'Credit', null),
  ('ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000001', 'parts',  9999900, date '2026-09-21', 'manual', 'Deleted', now()),
  ('ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000002', 'labour',    70000, date '2026-09-22', 'manual', 'Service', null),
  ('ae000000-0000-4000-9000-000000000001', null,                                   'other',    12300, date '2026-09-23', 'manual', 'Farm level', null),
  ('ae000000-0000-4000-9000-000000000002', 'ae200000-0000-4000-9000-000000000004', 'parts',    500000, date '2026-09-24', 'manual', 'Other farm', null);

insert into public.job_cards (id, farm_id, machine_id, type, status, created_at) values
  ('ae300000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000001', 'repair', 'open', timestamptz '2026-10-05 08:00+02'),
  ('ae300000-0000-4000-9000-000000000002', 'ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000001', 'repair', 'open', timestamptz '2026-09-05 08:00+02');
insert into public.faults (farm_id, machine_id, description, created_at) values
  ('ae000000-0000-4000-9000-000000000001', 'ae200000-0000-4000-9000-000000000002', 'Flat tyre', timestamptz '2026-10-09 10:00+02');

-- Two partners. Ours: linked to the totals farm (active) and the other farm (pending).
-- Theirs: linked to the totals farm, plus a deleted link that must not count.
insert into public.workshops (id, name) values
  ('ae400000-0000-4000-9000-000000000001', 'Totals workshop'),
  ('ae400000-0000-4000-9000-000000000002', 'Other workshop');
insert into auth.users (id, email) values
  ('ae100000-0000-4000-9000-000000000006', 'totals.partner@example.test');
insert into public.users (id, workshop_id, role, name, email, active) values
  ('ae100000-0000-4000-9000-000000000006', 'ae400000-0000-4000-9000-000000000001', 'workshop', 'Partner', 'totals.partner@example.test', true);
insert into public.workshop_links (workshop_id, farm_id, status, deleted_at) values
  ('ae400000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'active',  null),
  ('ae400000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000002', 'pending', null),
  ('ae400000-0000-4000-9000-000000000002', 'ae000000-0000-4000-9000-000000000001', 'active',  null),
  ('ae400000-0000-4000-9000-000000000002', 'ae000000-0000-4000-9000-000000000002', 'active',  now());

-- Our expenses: unpaid with VAT and no tax invoice (115,00, VAT 15,00); paid with its
-- invoice (230,00, VAT 30,00); unpaid VAT that cannot be claimed (57,50); paid, zero-rated,
-- no receipt (80,00); a deleted unpaid one that must not count. Theirs: unpaid 80,50.
insert into public.partner_expenses (workshop_id, supplier_name, amount_cents, vat_cents, vat_claimable, paid_on, receipt_path, deleted_at) values
  ('ae400000-0000-4000-9000-000000000001', 'Filters CC',   10000, 1500, true,  null,              null,      null),
  ('ae400000-0000-4000-9000-000000000001', 'Bearings Ltd', 20000, 3000, true,  date '2026-09-30', 'r/2.pdf', null),
  ('ae400000-0000-4000-9000-000000000001', 'Lunch spot',    5000,  750, false, null,              null,      null),
  ('ae400000-0000-4000-9000-000000000001', 'Exports Co',    8000,    0, true,  date '2026-09-30', null,      null),
  ('ae400000-0000-4000-9000-000000000001', 'Deleted Co',   99999, 9999, true,  null,              null,      now()),
  ('ae400000-0000-4000-9000-000000000002', 'Their supplier', 7000, 1050, true, null,              null,      null);

-- Documents, inserted without their workflow triggers (fixtures, not a workflow test): ours
-- a draft (does not count), a sent invoice and a deleted sent one; theirs one sent quote.
set local session_replication_role = replica;
insert into public.partner_documents (workshop_id, farm_id, bill_to_name, kind, status, number, deleted_at) values
  ('ae400000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'Totals farm', 'invoice', 'draft', 'T-1', null),
  ('ae400000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'Totals farm', 'invoice', 'sent',  'T-2', null),
  ('ae400000-0000-4000-9000-000000000001', 'ae000000-0000-4000-9000-000000000001', 'Totals farm', 'invoice', 'sent',  'T-3', now()),
  ('ae400000-0000-4000-9000-000000000002', 'ae000000-0000-4000-9000-000000000001', 'Totals farm', 'quote',   'sent',  'Q-1', null);
set local session_replication_role = origin;

-- == The owner ===============================================================
select set_config('request.jwt.claims', '{"sub":"ae100000-0000-4000-9000-000000000001","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
do $$
declare r record; n int;
begin
  select * into r from public.machine_cost_totals('ae000000-0000-4000-9000-000000000001')
   where machine_id = 'ae200000-0000-4000-9000-000000000001';
  if not found or r.total_cents is distinct from 360000 or r.entries is distinct from 3 then
    raise exception 'red tractor lifetime total wrong (deleted entries must not count): %', row_to_json(r);
  end if;
  select * into r from public.machine_cost_totals('ae000000-0000-4000-9000-000000000001')
   where machine_id = 'ae200000-0000-4000-9000-000000000002';
  if not found or r.total_cents is distinct from 70000 then raise exception 'bakkie total wrong: %', row_to_json(r); end if;
  select count(*) into n from public.machine_cost_totals('ae000000-0000-4000-9000-000000000001');
  if n <> 2 then raise exception 'owner sees % machine totals, expected 2 (no farm-level row)', n; end if;
  -- Without a farm: still only what the policies allow.
  select count(*) into n from public.machine_cost_totals() where machine_id = 'ae200000-0000-4000-9000-000000000004';
  if n <> 0 then raise exception 'an owner read another farm''s machine costs'; end if;

  select count(*) into n from public.admin_farm_activity(timestamptz '2026-10-01 00:00+02');
  if n <> 1 then raise exception 'an owner sees activity for % farms, expected only their own', n; end if;
  select * into r from public.admin_farm_activity(timestamptz '2026-10-01 00:00+02');
  if not found or r.farm_id is distinct from 'ae000000-0000-4000-9000-000000000001' or r.machines is distinct from 2 or r.active_users is distinct from 2
     or r.jobs_this_month is distinct from 1 or r.last_activity is distinct from timestamptz '2026-10-09 10:00+02' then
    raise exception 'owner farm activity wrong: %', row_to_json(r);
  end if;
end $$;
reset role;

-- == An operator who may not see costs ========================================
select set_config('request.jwt.claims', '{"sub":"ae100000-0000-4000-9000-000000000002","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
do $$ begin
  if exists (select 1 from public.machine_cost_totals('ae000000-0000-4000-9000-000000000001')) then
    raise exception 'an operator read the cost ledger through machine_cost_totals';
  end if;
end $$;
reset role;

-- == Rapid Rise ================================================================
select set_config('request.jwt.claims', '{"sub":"ae100000-0000-4000-9000-000000000004","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
do $$
declare r record;
begin
  select * into r from public.admin_farm_activity(timestamptz '2026-10-01 00:00+02')
   where farm_id = 'ae000000-0000-4000-9000-000000000002';
  if not found or r.farm_id is null or r.machines is distinct from 1 or r.active_users is distinct from 1 or r.jobs_this_month is distinct from 0 or r.last_activity is not null then
    raise exception 'admin view of the other farm wrong: %', row_to_json(r);
  end if;
  select * into r from public.machine_cost_totals() where machine_id = 'ae200000-0000-4000-9000-000000000004';
  if not found or r.total_cents is distinct from 500000 then raise exception 'admin cost total for the other farm wrong: %', row_to_json(r); end if;
  select * into r from public.partner_expense_position('ae400000-0000-4000-9000-000000000002');
  if not found or r.expenses is distinct from 1 or r.spent_cents is distinct from 8050 or r.unpaid is distinct from 1 then
    raise exception 'admin view of the other partner''s expenses wrong: %', row_to_json(r);
  end if;
  select * into r from public.admin_partner_activity() where workshop_id = 'ae400000-0000-4000-9000-000000000001';
  if not found or r.active_clients is distinct from 1 or r.documents is distinct from 1 then
    raise exception 'our partner activity wrong (pending link, draft and deleted document must not count): %', row_to_json(r);
  end if;
  select * into r from public.admin_partner_activity() where workshop_id = 'ae400000-0000-4000-9000-000000000002';
  if not found or r.active_clients is distinct from 1 or r.documents is distinct from 1 then
    raise exception 'their partner activity wrong (deleted link must not count): %', row_to_json(r);
  end if;
end $$;
reset role;

-- == The partner ==============================================================
select set_config('request.jwt.claims', '{"sub":"ae100000-0000-4000-9000-000000000006","role":"authenticated","aal":"aal2"}', true);
set local role authenticated;
do $$
declare r record;
begin
  select * into r from public.partner_expense_position('ae400000-0000-4000-9000-000000000001');
  if not found or r.expenses is distinct from 4 or r.spent_cents is distinct from 48250 or r.claimable_vat_cents is distinct from 4500
     or r.unpaid is distinct from 2 or r.unpaid_cents is distinct from 17250 or r.unsupported is distinct from 1 or r.unsupported_vat_cents is distinct from 1500 then
    raise exception 'partner expense figures wrong: %', row_to_json(r);
  end if;
  -- Another partner's id: one row, all zero, because the policies show nothing.
  select * into r from public.partner_expense_position('ae400000-0000-4000-9000-000000000002');
  if not found or r.expenses is distinct from 0 or r.unpaid_cents is distinct from 0 then
    raise exception 'a partner read another partner''s expenses: %', row_to_json(r);
  end if;
  if exists (select 1 from public.admin_partner_activity()
              where workshop_id = 'ae400000-0000-4000-9000-000000000002' and (documents > 0 or active_clients > 0)) then
    raise exception 'a partner counted another partner''s links or documents';
  end if;
end $$;
reset role;

-- == The service role (no policies): the function's own filters must hold ====
set local role service_role;
do $$
declare r record;
begin
  select * into r from public.machine_cost_totals('ae000000-0000-4000-9000-000000000001')
   where machine_id = 'ae200000-0000-4000-9000-000000000001';
  if not found or r.total_cents is distinct from 360000 or r.entries is distinct from 3 then
    raise exception 'service total counted a deleted entry: %', row_to_json(r);
  end if;
  select * into r from public.admin_farm_activity(timestamptz '2026-10-01 00:00+02')
   where farm_id = 'ae000000-0000-4000-9000-000000000001';
  if not found or r.machines is distinct from 2 or r.active_users is distinct from 2 then
    raise exception 'service activity counted a deleted machine or an inactive user: %', row_to_json(r);
  end if;
  select * into r from public.partner_expense_position('ae400000-0000-4000-9000-000000000001');
  if not found or r.expenses is distinct from 4 or r.unpaid_cents is distinct from 17250 then
    raise exception 'service expense figures counted a deleted expense: %', row_to_json(r);
  end if;
  select * into r from public.admin_partner_activity() where workshop_id = 'ae400000-0000-4000-9000-000000000001';
  if not found or r.active_clients is distinct from 1 or r.documents is distinct from 1 then
    raise exception 'service partner activity counted a pending link or a deleted or draft document: %', row_to_json(r);
  end if;
end $$;
reset role;

-- == Anonymous: no ===========================================================
select set_config('request.jwt.claims', '', true);
set local role anon;
do $$ begin
  begin
    perform * from public.machine_cost_totals();
    raise exception 'anonymous machine_cost_totals';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.admin_farm_activity(now());
    raise exception 'anonymous admin_farm_activity';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.partner_expense_position('ae400000-0000-4000-9000-000000000001');
    raise exception 'anonymous partner_expense_position';
  exception when insufficient_privilege then null; end;
  begin
    perform * from public.admin_partner_activity();
    raise exception 'anonymous admin_partner_activity';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
