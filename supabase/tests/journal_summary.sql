-- The accounting summary summed in the database agrees with the journal it sums, and keeps
-- the journal's own permissions (B3, 20261119140000).
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,status,plan) values
 ('c9000000-0000-4000-9000-000000000001','Books','active','professional'),
 ('c9000000-0000-4000-9000-000000000002','Other books','active','professional');
insert into auth.users(id,email) values
 ('c9100000-0000-4000-9000-000000000001','books1@example.test'),
 ('c9100000-0000-4000-9000-000000000002','books2@example.test');
insert into public.users(id,farm_id,role,name,email) values
 ('c9100000-0000-4000-9000-000000000001','c9000000-0000-4000-9000-000000000001','owner','Owner','books1@example.test'),
 ('c9100000-0000-4000-9000-000000000002','c9000000-0000-4000-9000-000000000002','owner','Other','books2@example.test');
insert into public.machines(id,farm_id,name,type) values
 ('c9200000-0000-4000-9000-000000000001','c9000000-0000-4000-9000-000000000001','Truck','truck');
insert into public.cost_entries(farm_id,machine_id,type,amount_cents,occurred_on) values
 ('c9000000-0000-4000-9000-000000000001','c9200000-0000-4000-9000-000000000001','parts',115000,current_date),
 ('c9000000-0000-4000-9000-000000000001','c9200000-0000-4000-9000-000000000001','labour',50000,current_date),
 ('c9000000-0000-4000-9000-000000000001','c9200000-0000-4000-9000-000000000001','fuel',230000,current_date);

create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'JOURNAL: %', why; end if; end
$$;
select set_config('request.jwt.claims', jsonb_build_object('sub','c9100000-0000-4000-9000-000000000001','role','authenticated')::text, true);
set local role authenticated;
create temporary table j on commit drop as
  select * from public.farm_journal('c9000000-0000-4000-9000-000000000001', current_date - 31, current_date + 1);
select pg_temp.assert((select count(*) > 0 from j), 'fixture: the journal has lines to sum');
select pg_temp.assert((select t.lines = (select count(*) from j)
    and t.debit_cents = (select sum(debit_cents) from j)
    and t.credit_cents = (select sum(credit_cents) from j)
    and t.entries = (select count(distinct entry_key) from j)
    and t.unbalanced_count = 0
  from public.farm_journal_totals('c9000000-0000-4000-9000-000000000001', current_date - 31, current_date + 1) t),
  'the totals are the journal''s own, line for line');
select pg_temp.assert((select bool_and(a.debit_cents = x.dr and a.credit_cents = x.cr)
    and count(*) = (select count(distinct account_key) from j)
  from public.farm_journal_accounts('c9000000-0000-4000-9000-000000000001', current_date - 31, current_date + 1) a
  join (select account_key, sum(debit_cents) dr, sum(credit_cents) cr from j group by account_key) x using (account_key)),
  'each account''s sums are the journal''s');
-- Another business's owner sums nothing of these books: the journal's permissions hold.
select set_config('request.jwt.claims', jsonb_build_object('sub','c9100000-0000-4000-9000-000000000002','role','authenticated')::text, true);
select pg_temp.assert((select lines = 0 from public.farm_journal_totals('c9000000-0000-4000-9000-000000000001', current_date - 31, current_date + 1)),
  'another business sums nothing of these books');
select pg_temp.assert((select count(*) = 0 from public.farm_journal_accounts('c9000000-0000-4000-9000-000000000001', current_date - 31, current_date + 1)),
  'nor sees their accounts');
reset role;
select pg_temp.assert(not has_function_privilege('anon','public.farm_journal_totals(uuid,date,date)','execute')
  and not has_function_privilege('anon','public.partner_journal_accounts(uuid,date,date)','execute'), 'not for anonymous callers');
rollback;
