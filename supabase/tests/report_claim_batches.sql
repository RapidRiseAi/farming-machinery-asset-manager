\set ON_ERROR_STOP on
-- Scheduled reports claimed a few at a time (20261013110000): the nightly worker claims a
-- batch, delivers it, and claims the next, so no claim runs ahead of what can be sent and
-- nothing is left claimed but unsent when the run's time is up.
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status) values
  ('af000000-0000-4000-9000-000000000001', 'Batch farm', 'professional', 'active');
insert into auth.users (id, email) values
  ('af100000-0000-4000-9000-000000000001', 'batch.owner@example.test');
insert into public.users (id, farm_id, role, name, email) values
  ('af100000-0000-4000-9000-000000000001', 'af000000-0000-4000-9000-000000000001', 'owner', 'Owner', 'batch.owner@example.test');

-- Three schedules due on different days, plus one not due yet.
insert into public.report_schedules (id, farm_id, name, report_key, output_format, cadence, next_run_date, lang, created_by) values
  ('af200000-0000-4000-9000-000000000001', 'af000000-0000-4000-9000-000000000001', 'Due third',  'cost', 'pdf', 'monthly', current_date,      'en', 'af100000-0000-4000-9000-000000000001'),
  ('af200000-0000-4000-9000-000000000002', 'af000000-0000-4000-9000-000000000001', 'Due first',  'cost', 'pdf', 'monthly', current_date - 20, 'en', 'af100000-0000-4000-9000-000000000001'),
  ('af200000-0000-4000-9000-000000000003', 'af000000-0000-4000-9000-000000000001', 'Due second', 'cost', 'pdf', 'monthly', current_date - 10, 'en', 'af100000-0000-4000-9000-000000000001'),
  ('af200000-0000-4000-9000-000000000004', 'af000000-0000-4000-9000-000000000001', 'Not due',    'cost', 'pdf', 'monthly', current_date + 5,  'en', 'af100000-0000-4000-9000-000000000001');
insert into public.report_schedule_recipients (schedule_id, farm_id, email, created_by)
select s.id, s.farm_id, 'reports@example.test', 'af100000-0000-4000-9000-000000000001'
  from public.report_schedules s where s.farm_id = 'af000000-0000-4000-9000-000000000001';

set local role service_role;
do $$
declare first_batch uuid[]; second_batch uuid[]; third_batch uuid[]; n int;
begin
  select array_agg(schedule_id order by period_start, schedule_id) into first_batch
    from public.cron_run_due_report_schedules(2);
  if cardinality(first_batch) <> 2 then
    raise exception 'first batch claimed % reports, expected 2', coalesce(cardinality(first_batch), 0);
  end if;
  if not (first_batch @> array['af200000-0000-4000-9000-000000000002'::uuid, 'af200000-0000-4000-9000-000000000003'::uuid]) then
    raise exception 'the first batch must be the two oldest due: %', first_batch;
  end if;

  -- The next batch takes what is left, and never the ones already claimed.
  select array_agg(schedule_id) into second_batch from public.cron_run_due_report_schedules(2);
  if second_batch is distinct from array['af200000-0000-4000-9000-000000000001'::uuid] then
    raise exception 'second batch claimed %, expected only the schedule due today', second_batch;
  end if;

  select array_agg(schedule_id) into third_batch from public.cron_run_due_report_schedules(2);
  if third_batch is not null then
    raise exception 'a third batch claimed %, but nothing was left due', third_batch;
  end if;

  select count(*) into n from public.report_schedule_runs
   where farm_id = 'af000000-0000-4000-9000-000000000001' and status = 'pending';
  if n <> 3 then raise exception '% pending runs, expected one per due schedule (3)', n; end if;
end $$;
reset role;

-- No limit still claims everything due, as before. Two more fall due; the three claimed
-- above are still in flight (pending, under six hours) and are not claimed again.
insert into public.report_schedules (id, farm_id, name, report_key, output_format, cadence, next_run_date, lang, created_by) values
  ('af200000-0000-4000-9000-000000000005', 'af000000-0000-4000-9000-000000000001', 'Later A', 'cost', 'pdf', 'monthly', current_date - 1, 'en', 'af100000-0000-4000-9000-000000000001'),
  ('af200000-0000-4000-9000-000000000006', 'af000000-0000-4000-9000-000000000001', 'Later B', 'cost', 'pdf', 'monthly', current_date - 2, 'en', 'af100000-0000-4000-9000-000000000001');
insert into public.report_schedule_recipients (schedule_id, farm_id, email, created_by) values
  ('af200000-0000-4000-9000-000000000005', 'af000000-0000-4000-9000-000000000001', 'reports@example.test', 'af100000-0000-4000-9000-000000000001'),
  ('af200000-0000-4000-9000-000000000006', 'af000000-0000-4000-9000-000000000001', 'reports@example.test', 'af100000-0000-4000-9000-000000000001');
set local role service_role;
do $$
declare n int;
begin
  select count(*) into n from public.cron_run_due_report_schedules();
  if n <> 2 then raise exception 'an unlimited claim took % reports, expected the 2 newly due', n; end if;
end $$;
reset role;

-- Only the service role may claim.
set local role authenticated;
do $$ begin
  begin
    perform * from public.cron_run_due_report_schedules(1);
    raise exception 'a signed-in user claimed scheduled reports';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

rollback;
