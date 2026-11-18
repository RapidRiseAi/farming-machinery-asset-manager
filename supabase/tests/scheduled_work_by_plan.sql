-- Scheduled work by plan and open business; the weekly digest once a week (B3, 20261119100000).
-- Scenario 17: a downgraded business's AARTO reminders stop (saved fines stay readable).
-- Scenario 40: a business that is not open gets no reminders and no digest.
\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claims','',true);

insert into public.farms(id,name,status,plan) values
 ('ce000000-0000-4000-9000-000000000001','Complete, open','active','complete'),
 ('ce000000-0000-4000-9000-000000000002','Downgraded','active','professional'),
 ('ce000000-0000-4000-9000-000000000003','Never paid','active','complete');
insert into public.billing_subscriptions(id,farm_id,plan,billing_period,status,asset_quota) values
 ('ce600000-0000-4000-9000-000000000003','ce000000-0000-4000-9000-000000000003','complete','monthly','pending',5);
insert into auth.users(id,email) select ('ce100000-0000-4000-9000-00000000000'||n)::uuid,'sched'||n||'@example.test' from generate_series(1,3) n;
insert into public.users(id,farm_id,role,name,email,active)
select ('ce100000-0000-4000-9000-00000000000'||n)::uuid,('ce000000-0000-4000-9000-00000000000'||n)::uuid,'owner','Owner '||n,'sched'||n||'@example.test',true
  from generate_series(1,3) n;
insert into public.machines(id,farm_id,name,type)
select ('ce200000-0000-4000-9000-00000000000'||n)::uuid,('ce000000-0000-4000-9000-00000000000'||n)::uuid,'Truck '||n,'truck'
  from generate_series(1,3) n;
insert into public.fines(farm_id,machine_id,notice_number,nomination_deadline,status)
select ('ce000000-0000-4000-9000-00000000000'||n)::uuid,('ce200000-0000-4000-9000-00000000000'||n)::uuid,'N'||n,current_date + 3,'received'
  from generate_series(1,3) n;

create function pg_temp.assert(ok boolean, why text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'SCHEDULED: %', why; end if; end
$$;
create function pg_temp.sent(p_farm uuid, p_template text) returns bigint language sql as $$
  select count(*) from public.notifications where farm_id = p_farm and template = p_template
$$;

-- The gate this relies on: the never-paid business is not open.
select pg_temp.assert(app.farm_billing_gate('ce000000-0000-4000-9000-000000000003') = 'pending', 'fixture: a pending subscription is not open');

-- == AARTO reminders: Complete and open only =================================================
select app.enqueue_aarto_nomination_reminders();
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000001','aarto_nomination_due') = 1, 'Complete and open: the reminder goes');
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000002','aarto_nomination_due') = 0, '[17] after a downgrade from Complete no AARTO reminder goes');
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000003','aarto_nomination_due') = 0, '[40] a business that is not open gets no reminder');
-- Only this suite's businesses: CI runs every suite on one database, so other suites' fines may exist.
select pg_temp.assert((select count(*) = 3 from public.fines where farm_id::text like 'ce000000-0000-4000-9000-00000000000%'), '[17] the saved fines stay');

-- == The weekly digest: once a week per open business =======================================
select app.enqueue_weekly_digest();
select app.enqueue_weekly_digest();
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000001','weekly_digest') = 1, 'a second run in the same week sends no second digest');
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000002','weekly_digest') = 1, 'the digest is not a plan feature: the downgraded business gets it');
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000003','weekly_digest') = 0, '[40] a business that is not open gets no digest');
-- Last week's digest does not count for this week: a missed week is not skipped.
update public.notifications set created_at = app.sast_week_start(now()) - interval '1 day'
 where farm_id = 'ce000000-0000-4000-9000-000000000001' and template = 'weekly_digest';
select app.enqueue_weekly_digest();
select pg_temp.assert(pg_temp.sent('ce000000-0000-4000-9000-000000000001','weekly_digest') = 2, 'a digest from last week does not stop this week''s');

-- == The week starts on Monday at midnight in South Africa, not in UTC =======================
select pg_temp.assert(app.sast_week_start('2026-11-18 10:00+02') = '2026-11-16 00:00+02'::timestamptz, 'a Wednesday belongs to the week from Monday');
select pg_temp.assert(app.sast_week_start('2026-11-22 23:30+02') = '2026-11-16 00:00+02'::timestamptz, 'Sunday night is still the old week');
-- 00:30 on Monday in South Africa is still Sunday in UTC.
select pg_temp.assert(app.sast_week_start('2026-11-23 00:30+02') = '2026-11-23 00:00+02'::timestamptz, 'Monday after midnight SAST is the new week, though UTC says Sunday');

select pg_temp.assert(not has_function_privilege('authenticated','app.sast_week_start(timestamptz)','execute')
  and not has_function_privilege('authenticated','app.enqueue_weekly_digest()','execute')
  and not has_function_privilege('anon','app.enqueue_aarto_nomination_reminders()','execute'),
  'the scheduled functions stay the service''s');
rollback;
