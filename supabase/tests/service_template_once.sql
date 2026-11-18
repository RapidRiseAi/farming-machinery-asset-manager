-- A service template is applied to a machine once (B3, 20261119120000).
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);
insert into public.farms(id,name,status,plan) values ('cf000000-0000-4000-9000-000000000001','Templates','active','essential');
insert into auth.users(id,email) values ('cf100000-0000-4000-9000-000000000001','tpl@example.test');
insert into public.users(id,farm_id,role,name,email) values ('cf100000-0000-4000-9000-000000000001','cf000000-0000-4000-9000-000000000001','owner','Owner','tpl@example.test');
insert into public.machines(id,farm_id,name,type) values
 ('cf200000-0000-4000-9000-000000000001','cf000000-0000-4000-9000-000000000001','Tractor','tractor'),
 ('cf200000-0000-4000-9000-000000000002','cf000000-0000-4000-9000-000000000001','Tractor two','tractor');
insert into public.service_templates(id,farm_id,machine_type,name,lines) values
 ('cf300000-0000-4000-9000-000000000001',null,'tractor','250 h service','[{"task":"Engine oil","interval_hours":250}]');
create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'TEMPLATE: %', why; end if; end
$$;
create function pg_temp.refused(q text) returns boolean language plpgsql as $$
begin execute q; return false; exception when unique_violation then return true; end
$$;
select set_config('request.jwt.claims', jsonb_build_object('sub','cf100000-0000-4000-9000-000000000001','role','authenticated')::text, true);
set local role authenticated;

-- The first press applies the template.
insert into public.service_plan_lines(farm_id,machine_id,task,interval_hours,template_id) values
 ('cf000000-0000-4000-9000-000000000001','cf200000-0000-4000-9000-000000000001','Engine oil',250,'cf300000-0000-4000-9000-000000000001');
-- The second press, racing it, is refused by the database, whatever the screen read before.
select pg_temp.assert(pg_temp.refused($q$insert into public.service_plan_lines(farm_id,machine_id,task,interval_hours,template_id) values
 ('cf000000-0000-4000-9000-000000000001','cf200000-0000-4000-9000-000000000001',' engine OIL ',250,'cf300000-0000-4000-9000-000000000001')$q$),
  'a template task is held once per machine, whatever its spacing or case');
-- Another machine takes the same template; a line added by hand is never constrained.
insert into public.service_plan_lines(farm_id,machine_id,task,interval_hours,template_id) values
 ('cf000000-0000-4000-9000-000000000001','cf200000-0000-4000-9000-000000000002','Engine oil',250,'cf300000-0000-4000-9000-000000000001');
insert into public.service_plan_lines(farm_id,machine_id,task,interval_hours) values
 ('cf000000-0000-4000-9000-000000000001','cf200000-0000-4000-9000-000000000001','Engine oil',500);
select pg_temp.assert((select count(*) = 3 from public.service_plan_lines), 'other machines and hand-made lines are not limited');
-- A line put away frees the template to be applied again.
reset role;
update public.service_plan_lines set deleted_at = now()
 where machine_id = 'cf200000-0000-4000-9000-000000000001' and template_id is not null;
select set_config('request.jwt.claims', jsonb_build_object('sub','cf100000-0000-4000-9000-000000000001','role','authenticated')::text, true);
set local role authenticated;
insert into public.service_plan_lines(farm_id,machine_id,task,interval_hours,template_id) values
 ('cf000000-0000-4000-9000-000000000001','cf200000-0000-4000-9000-000000000001','Engine oil',250,'cf300000-0000-4000-9000-000000000001');
select pg_temp.assert((select count(*) = 1 from public.service_plan_lines where machine_id = 'cf200000-0000-4000-9000-000000000001' and template_id is not null and deleted_at is null),
  'after the old line is put away the template applies again');
rollback;
