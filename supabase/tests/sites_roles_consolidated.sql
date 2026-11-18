-- Scenario 18 (B3): roles differ across two sites; the consolidated view
-- (src/lib/sites-overview.ts) includes only sites the person may open, each read under the
-- person's own role there. The view is built from what these reads return: the farms list
-- (farms_sel), the role per farm, can_view_farm_costs per farm, and RLS on the figures.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,status,plan) values
 ('c8000000-0000-4000-9000-000000000001','Site A','active','complete'),
 ('c8000000-0000-4000-9000-000000000002','Site B','active','complete'),
 ('c8000000-0000-4000-9000-000000000003','Site C, same owner','active','complete');
-- C is billed through A: one customer, one plan, but the person has no membership of C.
update public.farms set billed_through = 'c8000000-0000-4000-9000-000000000001' where id = 'c8000000-0000-4000-9000-000000000003';
insert into auth.users(id,email) values
 ('c8100000-0000-4000-9000-000000000001','owner@sites.test'),
 ('c8100000-0000-4000-9000-000000000002','person@sites.test');
insert into public.users(id,farm_id,role,name,email) values
 ('c8100000-0000-4000-9000-000000000001','c8000000-0000-4000-9000-000000000001','owner','Owner','owner@sites.test'),
 ('c8100000-0000-4000-9000-000000000002','c8000000-0000-4000-9000-000000000001','manager','Person','person@sites.test');
-- The person: manager on A (primary), operator on B, nothing on C.
insert into public.user_farm_memberships(user_id,farm_id,role,active) values
 ('c8100000-0000-4000-9000-000000000002','c8000000-0000-4000-9000-000000000001','manager',true),
 ('c8100000-0000-4000-9000-000000000002','c8000000-0000-4000-9000-000000000002','operator',true),
 ('c8100000-0000-4000-9000-000000000001','c8000000-0000-4000-9000-000000000002','owner',true),
 ('c8100000-0000-4000-9000-000000000001','c8000000-0000-4000-9000-000000000003','owner',true);
insert into public.machines(id,farm_id,name,type) values
 ('c8200000-0000-4000-9000-000000000001','c8000000-0000-4000-9000-000000000001','A truck','truck'),
 ('c8200000-0000-4000-9000-000000000002','c8000000-0000-4000-9000-000000000002','B truck','truck'),
 ('c8200000-0000-4000-9000-000000000003','c8000000-0000-4000-9000-000000000003','C truck','truck');
insert into public.cost_entries(farm_id,machine_id,type,amount_cents,occurred_on)
select ('c8000000-0000-4000-9000-00000000000'||n)::uuid,('c8200000-0000-4000-9000-00000000000'||n)::uuid,'parts',100000*n,current_date
  from generate_series(1,3) n;
insert into public.faults(farm_id,machine_id,description,status)
select ('c8000000-0000-4000-9000-00000000000'||n)::uuid,('c8200000-0000-4000-9000-00000000000'||n)::uuid,'Fault '||n,'open'
  from generate_series(1,3) n;

create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'SITES: %', why; end if; end
$$;
select set_config('request.jwt.claims', jsonb_build_object('sub','c8100000-0000-4000-9000-000000000002','role','authenticated')::text, true);
set local role authenticated;

-- [18] Only the sites the person belongs to are listed: C, on the same bill, is not.
select pg_temp.assert((select array_agg(name order by name) from public.farms) = array['Site A','Site B'],
  '[18] the consolidated list holds only the person''s own sites, not every site on the customer''s bill');
-- [18] The role is the site's own: manager on A, operator on B.
select pg_temp.assert(app.effective_farm_role(auth.uid(), 'c8000000-0000-4000-9000-000000000001')::text = 'manager'
  and app.effective_farm_role(auth.uid(), 'c8000000-0000-4000-9000-000000000002')::text = 'operator',
  '[18] each site answers with its own role, not the primary one');
-- [18] Money only where that site's role sees costs.
select pg_temp.assert(public.can_view_farm_costs('c8000000-0000-4000-9000-000000000001')
  and not public.can_view_farm_costs('c8000000-0000-4000-9000-000000000002')
  and not public.can_view_farm_costs('c8000000-0000-4000-9000-000000000003'),
  '[18] costs on A (manager), not on B (operator) nor C (no membership)');
select pg_temp.assert((select count(*) from public.cost_entries where farm_id = 'c8000000-0000-4000-9000-000000000003') = 0,
  '[18] nothing of the site the person does not belong to is readable');
select pg_temp.assert((select count(*) from public.faults where farm_id = 'c8000000-0000-4000-9000-000000000003') = 0
  and (select count(*) from public.faults where farm_id = 'c8000000-0000-4000-9000-000000000001') = 1,
  '[18] figures come from the person''s own sites only');
rollback;
