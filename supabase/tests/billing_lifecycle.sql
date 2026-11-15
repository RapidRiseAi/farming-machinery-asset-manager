\set ON_ERROR_STOP on
-- An unpaid renewal and a cancellation, from the first late day to the end of the owner's 90
-- days (20261115120000). BRIEF section 23: scenario 11 (day 0 and 7 of grace, day 8, the day-90
-- retrieval boundary, payment arriving in the middle of each, South African day boundaries) and
-- scenario 40 (the state stops writes and sends in the database, the scheduled engines and the
-- paid AI, voice and WhatsApp paths, not only the screen).
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
create or replace function pg_temp.pay(p_invoice uuid, p_ref text) returns void language plpgsql as $$
declare v_attempt uuid; v_owed bigint;
begin
  select total_incl_cents - amount_paid_cents into v_owed from public.billing_invoices where id = p_invoice;
  v_attempt := app.claim_billing_charge(p_invoice, p_ref, 'manual_retry', v_owed);
  perform app.settle_billing_attempt(v_attempt, 'succeeded', (floor(random() * 1e9))::bigint, p_ref, 'Approved', null, v_owed, 'card', true);
end $$;
-- An open period invoice due on a given day, for the gate to read.
create or replace function pg_temp.owe(p_farm uuid, p_sub uuid, p_ref text, p_due date) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.billing_invoices (farm_id, subscription_id, invoice_ref, status, kind, period_start, period_end,
    issued_on, due_on, plan, billing_period, asset_count, unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values (p_farm, p_sub, p_ref, 'draft', 'period', p_due, p_due + 29, p_due, p_due, 'complete', 'monthly', 5, 9900, 1,
          'launch-2026-11-eq', 0)
  returning id into v;
  update public.billing_invoices set status = 'open' where id = v;
  return v;
end $$;

-- == Fixtures ===============================================================================
--   L1 in its grace (due three days ago)    L2 eight days late    L3 cancelling, period over
--   L4 cancelled at once, five days ago      L5 its 90 days over    L6 paid up
insert into public.farms (id, name, plan, status, billing_period) values
  ('a1100000-0000-4000-9000-000000000001', 'Grace yard',     'complete', 'active', 'monthly'),
  ('a1100000-0000-4000-9000-000000000002', 'Late yard',      'complete', 'active', 'monthly'),
  ('a1100000-0000-4000-9000-000000000003', 'Leaving yard',   'complete', 'active', 'monthly'),
  ('a1100000-0000-4000-9000-000000000004', 'Left yard',      'complete', 'active', 'monthly'),
  ('a1100000-0000-4000-9000-000000000005', 'Window over',    'complete', 'suspended', 'monthly'),
  ('a1100000-0000-4000-9000-000000000006', 'Paid yard',      'complete', 'active', 'monthly');
update public.farms set suspended_for = 'billing' where id = 'a1100000-0000-4000-9000-000000000005';

insert into auth.users (id, email)
select ('a1110000-0000-4000-9000-00000000000' || n)::uuid, 'owner' || n || '@life.test' from generate_series(1, 6) n;
insert into auth.users (id, email)
select ('a1120000-0000-4000-9000-00000000000' || n)::uuid, 'manager' || n || '@life.test' from generate_series(1, 6) n;
insert into public.users (id, farm_id, workshop_id, role, name, email, active)
select ('a1110000-0000-4000-9000-00000000000' || n)::uuid, ('a1100000-0000-4000-9000-00000000000' || n)::uuid, null,
       'owner', 'Owner ' || n, 'owner' || n || '@life.test', true from generate_series(1, 6) n;
insert into public.users (id, farm_id, workshop_id, role, name, email, active)
select ('a1120000-0000-4000-9000-00000000000' || n)::uuid, ('a1100000-0000-4000-9000-00000000000' || n)::uuid, null,
       'manager', 'Manager ' || n, 'manager' || n || '@life.test', true from generate_series(1, 6) n;

do $fx$
declare v_today date := app.billing_today();
begin
  insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota,
    current_period_start, current_period_end, next_billing_on, anchor_day, cancel_at_period_end, ended_on, cancelled_at,
    suspended_at, retrieval_ends_on) values
    ('a1160000-0000-4000-9000-000000000001', 'a1100000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active', 5,
     v_today - 3, v_today + 26, v_today + 27, extract(day from v_today - 3)::int, false, null, null, null, null),
    ('a1160000-0000-4000-9000-000000000002', 'a1100000-0000-4000-9000-000000000002', 'complete', 'monthly', 'active', 5,
     v_today - 8, v_today + 21, v_today + 22, extract(day from v_today - 8)::int, false, null, null, null, null),
    ('a1160000-0000-4000-9000-000000000003', 'a1100000-0000-4000-9000-000000000003', 'complete', 'monthly', 'non_renewing', 5,
     current_date - 31, current_date - 2, current_date - 1, extract(day from current_date - 31)::int, true, null, now() - interval '10 days', null, null),
    ('a1160000-0000-4000-9000-000000000004', 'a1100000-0000-4000-9000-000000000004', 'complete', 'monthly', 'cancelled', 5,
     v_today - 20, v_today + 9, null, extract(day from v_today - 20)::int, false, v_today - 5, now() - interval '5 days', null, null),
    ('a1160000-0000-4000-9000-000000000005', 'a1100000-0000-4000-9000-000000000005', 'complete', 'monthly', 'suspended', 5,
     v_today - 130, v_today - 101, v_today - 100, extract(day from v_today - 130)::int, false, null, null,
     now() - interval '91 days', v_today - 1),
    ('a1160000-0000-4000-9000-000000000006', 'a1100000-0000-4000-9000-000000000006', 'complete', 'monthly', 'active', 5,
     v_today - 3, v_today + 26, v_today + 27, extract(day from v_today - 3)::int, false, null, null, null, null);
end $fx$;

-- One truck each, with a warranty that expires soon (an engine that sends reminders).
insert into public.machines (id, farm_id, name, type, warranty_expiry_date)
select ('a1150000-0000-4000-9000-00000000000' || n)::uuid, ('a1100000-0000-4000-9000-00000000000' || n)::uuid,
       'Truck ' || n, 'truck', current_date + 5
  from generate_series(1, 6) n;

select pg_temp.owe('a1100000-0000-4000-9000-000000000001', 'a1160000-0000-4000-9000-000000000001', 'FW-LIFE-1', app.billing_today() - 3);
select pg_temp.owe('a1100000-0000-4000-9000-000000000002', 'a1160000-0000-4000-9000-000000000002', 'FW-LIFE-2', app.billing_today() - 8);
select pg_temp.owe('a1100000-0000-4000-9000-000000000005', 'a1160000-0000-4000-9000-000000000005', 'FW-LIFE-5', app.billing_today() - 98);

-- == Day boundaries are South African ============================================================
do $t$
begin
  if app.billing_date_of('2026-11-15 21:59:59+00') <> date '2026-11-15'
     or app.billing_date_of('2026-11-15 22:00:00+00') <> date '2026-11-16' then
    raise exception 'LIFE FAIL [11 tz]: 22:00 UTC is midnight in South Africa, the date did not turn there';
  end if;
  if app.billing_day_ends_at(date '2026-11-15') <> timestamptz '2026-11-15 22:00:00+00' then
    raise exception 'LIFE FAIL [11 tz]: a South African day does not end at 22:00 UTC';
  end if;
  if app.billing_today() <> (now() at time zone 'Africa/Johannesburg')::date then
    raise exception 'LIFE FAIL [11 tz]: today is not decided in South Africa';
  end if;
end $t$;

-- == Scenario 11: day 0 and day 7 of the grace, day 8 ============================================
do $t$
declare
  d date := app.billing_today() - 3;   -- L1's due date
  v jsonb;
begin
  -- Due today is not late; a day after it is. Seven days of grace, then retrieval.
  if app.farm_payment_late('a1100000-0000-4000-9000-000000000001', d) then
    raise exception 'LIFE FAIL [11]: a payment due today was already late';
  end if;
  if not app.farm_payment_late('a1100000-0000-4000-9000-000000000001', d + 1) then
    raise exception 'LIFE FAIL [11]: the grace did not begin the day after the due date';
  end if;
  if app.farm_billing_gate_on('a1100000-0000-4000-9000-000000000001', d + 7) <> 'ok'
     or app.farm_billing_gate_on('a1100000-0000-4000-9000-000000000001', d + 8) <> 'suspended' then
    raise exception 'LIFE FAIL [11]: day 7 is not the last day of grace (% then %)',
      app.farm_billing_gate_on('a1100000-0000-4000-9000-000000000001', d + 7),
      app.farm_billing_gate_on('a1100000-0000-4000-9000-000000000001', d + 8);
  end if;
  v := app.farm_lifecycle('a1100000-0000-4000-9000-000000000001', app.billing_today());
  if v ->> 'state' is distinct from 'grace' or (v ->> 'grace_ends_on')::date <> d + 7
     or (v ->> 'outstanding_cents')::bigint <> 49500 then
    raise exception 'LIFE FAIL [11]: the grace is not stated with its last day and what is owed: %', v;
  end if;
  -- No new paid extras in the grace; a paid-up business has them.
  if app.farm_paid_extras_allowed('a1100000-0000-4000-9000-000000000001', app.billing_today())
     or not app.farm_paid_extras_allowed('a1100000-0000-4000-9000-000000000006', app.billing_today()) then
    raise exception 'LIFE FAIL [11]: paid extras are not paused in the grace only';
  end if;
end $t$;

-- Ordinary record keeping goes on in the grace, through a person's own session.
select pg_temp.as_user('a1120000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v_n integer;
begin
  update public.machines set name = 'Truck 1 (grace)' where id = 'a1150000-0000-4000-9000-000000000001';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'LIFE FAIL [11]: a manager could not keep records in the grace'; end if;
end $t$;
reset role;

-- Paid AI, voice and WhatsApp pause in the grace; the business's own key is its own money.
do $t$
declare v jsonb;
begin
  v := public.ai_reserve('a1100000-0000-4000-9000-000000000001', 'a1110000-0000-4000-9000-000000000001',
                         'ai_answer', 'openai/gpt-4.1-mini', '{"input_tokens": 100}'::jsonb, 'platform');
  if v ->> 'reason' is distinct from 'billing_paused' then
    raise exception 'LIFE FAIL [40]: paid AI ran in the grace: %', v;
  end if;
  v := public.ai_reserve('a1100000-0000-4000-9000-000000000001', 'a1110000-0000-4000-9000-000000000001',
                         'ai_answer', 'openai/gpt-4.1-mini', '{"input_tokens": 100}'::jsonb, 'farm_openai');
  if v ->> 'reason' = 'billing_paused' then
    raise exception 'LIFE FAIL [40]: the business''s own key was paused in the grace';
  end if;
  v := public.ai_open_voice_session('a1100000-0000-4000-9000-000000000001', 'a1110000-0000-4000-9000-000000000001',
                                    60000, 500, '1', 'meter');
  if v ->> 'reason' is distinct from 'billing_paused' then
    raise exception 'LIFE FAIL [40]: voice opened in the grace: %', v;
  end if;
  v := public.ai_reserve('a1100000-0000-4000-9000-000000000006', 'a1110000-0000-4000-9000-000000000006',
                         'ai_answer', 'openai/gpt-4.1-mini', '{"input_tokens": 100}'::jsonb, 'platform');
  if v ->> 'reason' = 'billing_paused' then
    raise exception 'LIFE FAIL [40]: a paid-up business''s AI was paused';
  end if;
  if app.whatsapp_member('a1110000-0000-4000-9000-000000000001', 'a1100000-0000-4000-9000-000000000001')
     or not app.whatsapp_member('a1110000-0000-4000-9000-000000000006', 'a1100000-0000-4000-9000-000000000006') then
    raise exception 'LIFE FAIL [40]: WhatsApp is not paused in the grace only';
  end if;
end $t$;

-- The owner is told on the first day, once, and the staff are not.
do $t$
declare v_owner integer; v_manager integer;
begin
  perform app.billing_enqueue_lifecycle_notices(app.billing_today());
  perform app.billing_enqueue_lifecycle_notices(app.billing_today());
  select count(*) into v_owner from public.notifications
   where user_id = 'a1110000-0000-4000-9000-000000000001' and template = 'billing_grace_started';
  select count(*) into v_manager from public.notifications
   where user_id = 'a1120000-0000-4000-9000-000000000001' and template = 'billing_grace_started';
  if v_owner <> 1 or v_manager <> 0 then
    raise exception 'LIFE FAIL [11]: the grace notice reached the owner % times and the manager %', v_owner, v_manager;
  end if;
end $t$;

-- == Day eight: retrieval begins, renewals stop ==================================================
do $t$
declare s public.billing_subscriptions%rowtype;
begin
  perform app.billing_apply_suspensions();
  select * into s from public.billing_subscriptions where id = 'a1160000-0000-4000-9000-000000000002';
  if s.status <> 'suspended' or s.next_retry_on is not null or s.retrieval_ends_on <> app.billing_today() + 89
     or (select status from public.farms where id = s.farm_id) <> 'suspended' then
    raise exception 'LIFE FAIL [11]: day eight did not begin 90 days of retrieval with renewals stopped: %', to_jsonb(s);
  end if;
  -- L1 is still in its grace and stays open.
  if (select status from public.billing_subscriptions where id = 'a1160000-0000-4000-9000-000000000001') = 'suspended' then
    raise exception 'LIFE FAIL [11]: a business in its grace was suspended';
  end if;
  -- A failed payment the owner tries schedules no automatic retry.
  perform app.billing_register_failure(s.id, 'Declined');
  if (select next_retry_on from public.billing_subscriptions where id = s.id) is not null then
    raise exception 'LIFE FAIL [11]: a declined payment in retrieval scheduled an automatic retry';
  end if;
  -- The nightly card run leaves it alone.
  if exists (select 1 from app.due_billing_charges(500) d where d.subscription_id = s.id) then
    raise exception 'LIFE FAIL [11]: the nightly run would charge a business in retrieval';
  end if;
  -- The window ends on day 90 of it.
  if app.farm_billing_gate_on(s.farm_id, app.billing_today() + 89) <> 'suspended'
     or app.farm_billing_gate_on(s.farm_id, app.billing_today() + 90) <> 'closed' then
    raise exception 'LIFE FAIL [11]: the 90-day boundary is not where it should be';
  end if;
end $t$;

-- == A cancellation ends at its paid-through date, then the same 90 days =========================
do $t$
declare s3 public.billing_subscriptions%rowtype; s4 public.billing_subscriptions%rowtype;
begin
  perform app.billing_close_cancellations();
  select * into s3 from public.billing_subscriptions where id = 'a1160000-0000-4000-9000-000000000003';
  select * into s4 from public.billing_subscriptions where id = 'a1160000-0000-4000-9000-000000000004';
  if s3.status <> 'cancelled' or s3.retrieval_ends_on <> s3.ended_on + 90
     or (select status from public.farms where id = s3.farm_id) <> 'suspended' then
    raise exception 'LIFE FAIL [11]: a period-end cancellation did not close into its 90 days: %', to_jsonb(s3);
  end if;
  if s4.retrieval_ends_on <> app.billing_today() - 5 + 90
     or (select status from public.farms where id = s4.farm_id) <> 'suspended'
     or app.farm_billing_gate(s4.farm_id) <> 'closed' then
    raise exception 'LIFE FAIL [11]: an ended cancellation was not paused with its window: %', to_jsonb(s4);
  end if;
  if (select count(*) from public.notifications where user_id = 'a1110000-0000-4000-9000-000000000004'
        and template = 'billing_access_ended') <> 1
     or (select count(*) from public.notifications where user_id = 'a1120000-0000-4000-9000-000000000004'
        and template = 'billing_access_ended') <> 0 then
    raise exception 'LIFE FAIL [11]: the owner, and only the owner, is told the paid period ended';
  end if;
  if app.farm_lifecycle(s4.farm_id, app.billing_today()) ->> 'state' is distinct from 'retrieval'
     or app.farm_lifecycle('a1100000-0000-4000-9000-000000000005', app.billing_today()) ->> 'state' is distinct from 'closed' then
    raise exception 'LIFE FAIL [11]: the lifecycle does not say retrieval and closed apart';
  end if;
end $t$;

-- == Scenario 40: scheduled engines stop for a stopped business ==================================
do $t$
begin
  perform app.enqueue_expiry_notifications();
  if exists (select 1 from public.notifications where farm_id in ('a1100000-0000-4000-9000-000000000002',
               'a1100000-0000-4000-9000-000000000004', 'a1100000-0000-4000-9000-000000000005')
               and template like 'warranty%') then
    raise exception 'LIFE FAIL [40]: a warranty reminder went out for a business in retrieval or closed';
  end if;
  if not exists (select 1 from public.notifications where farm_id = 'a1100000-0000-4000-9000-000000000006'
                   and template like 'warranty%') then
    raise exception 'LIFE FAIL [40]: the reminder engine did not run for the paid-up business (the test proves nothing)';
  end if;
  if public.ai_reserve('a1100000-0000-4000-9000-000000000002', 'a1110000-0000-4000-9000-000000000002',
                       'ai_answer', 'openai/gpt-4.1-mini', '{"input_tokens": 1}'::jsonb, 'farm_openai') ->> 'reason'
     is distinct from 'billing_paused' then
    raise exception 'LIFE FAIL [40]: AI ran for a business in retrieval';
  end if;
end $t$;

-- == Owner-only reading, nobody writes ===========================================================
-- L2 (unpaid, in retrieval) and L4 (cancelled, in retrieval): the owner reads, the manager does
-- not, neither writes. L5 (its window over): nobody reads.
select pg_temp.as_user('a1110000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$
declare v_n integer;
begin
  select count(*) into v_n from public.machines where farm_id = 'a1100000-0000-4000-9000-000000000002';
  if v_n <> 1 then raise exception 'LIFE FAIL [11]: the owner cannot read in retrieval'; end if;
  update public.machines set name = 'changed' where id = 'a1150000-0000-4000-9000-000000000002';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'LIFE FAIL [40]: the owner changed a record in retrieval'; end if;
  if pg_temp.try($s$insert into public.machines (farm_id, name, type) values ('a1100000-0000-4000-9000-000000000002', 'New', 'truck')$s$) = 'ok' then
    raise exception 'LIFE FAIL [40]: a record was added in retrieval';
  end if;
  if not app.require_open_farm('a1100000-0000-4000-9000-000000000002', false) then
    raise exception 'LIFE FAIL [11]: the owner was refused a read by a definer function';
  end if;
end $t$;
reset role;

select pg_temp.as_user('a1120000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$
declare v_n integer;
begin
  select count(*) into v_n from public.machines where farm_id = 'a1100000-0000-4000-9000-000000000002';
  if v_n <> 0 then raise exception 'LIFE FAIL [11]: a manager read a business in retrieval'; end if;
  if pg_temp.try($s$select app.require_open_farm('a1100000-0000-4000-9000-000000000002', false)$s$) <> 'farm-not-active' then
    raise exception 'LIFE FAIL [11]: a definer function let a manager read in retrieval';
  end if;
end $t$;
reset role;

select pg_temp.as_user('a1120000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$
declare v_n integer;
begin
  select count(*) into v_n from public.machines where farm_id = 'a1100000-0000-4000-9000-000000000004';
  if v_n <> 0 then raise exception 'LIFE FAIL [38]: a manager read a cancelled business after its period'; end if;
end $t$;
reset role;

select pg_temp.as_user('a1110000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$
declare v_n integer;
begin
  select count(*) into v_n from public.machines where farm_id = 'a1100000-0000-4000-9000-000000000004';
  if v_n <> 1 then raise exception 'LIFE FAIL [38]: the owner of a cancelled business cannot read in its 90 days'; end if;
end $t$;
reset role;

select pg_temp.as_user('a1110000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$
declare v_n integer;
begin
  select count(*) into v_n from public.machines where farm_id = 'a1100000-0000-4000-9000-000000000005';
  if v_n <> 0 then raise exception 'LIFE FAIL [11]: the owner still reads after the 90 days'; end if;
  -- But can still see what is owed and pay it: billing stays open.
  select count(*) into v_n from public.billing_invoices where farm_id = 'a1100000-0000-4000-9000-000000000005';
  if v_n <> 1 then raise exception 'LIFE FAIL [11]: the owner cannot see what is owed after the window'; end if;
  if public.farm_lifecycle('a1100000-0000-4000-9000-000000000005') ->> 'state' is distinct from 'closed' then
    raise exception 'LIFE FAIL [11]: the owner is not told the account is closed';
  end if;
end $t$;
reset role;

-- A manager is told where the business stands, never what it owes.
select pg_temp.as_user('a1120000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.farm_lifecycle('a1100000-0000-4000-9000-000000000002');
  if v ->> 'state' is distinct from 'retrieval' or v ? 'outstanding_cents' then
    raise exception 'LIFE FAIL [11]: a manager was shown the amount owed, or the wrong state: %', v;
  end if;
  if pg_temp.try($s$select public.farm_lifecycle('a1100000-0000-4000-9000-000000000006')$s$) <> 'forbidden' then
    raise exception 'LIFE FAIL [11]: a manager asked about a business they do not belong to';
  end if;
end $t$;
reset role;

-- == Reminders before reading closes =============================================================
do $t$
declare v_n integer;
begin
  update public.billing_subscriptions set retrieval_ends_on = app.billing_today() + 5
   where id = 'a1160000-0000-4000-9000-000000000002';
  perform app.billing_enqueue_lifecycle_notices(app.billing_today());
  perform app.billing_enqueue_lifecycle_notices(app.billing_today());
  select count(*) into v_n from public.notifications
   where user_id = 'a1110000-0000-4000-9000-000000000002' and template = 'billing_retrieval_ending';
  if v_n <> 1 then raise exception 'LIFE FAIL [11]: the seven-day reminder went out % times', v_n; end if;
  update public.billing_subscriptions set retrieval_ends_on = app.billing_today() + 1
   where id = 'a1160000-0000-4000-9000-000000000002';
  perform app.billing_enqueue_lifecycle_notices(app.billing_today());
  select count(*) into v_n from public.notifications
   where user_id = 'a1110000-0000-4000-9000-000000000002' and template = 'billing_retrieval_ending';
  if v_n <> 2 then raise exception 'LIFE FAIL [11]: the last-day reminder did not follow the seven-day one (%)', v_n; end if;
  update public.billing_subscriptions set retrieval_ends_on = app.billing_today() + 89
   where id = 'a1160000-0000-4000-9000-000000000002';
end $t$;

-- == Payment arriving in the middle: grace, retrieval, after the window ===========================
do $t$
declare s public.billing_subscriptions%rowtype; v_invoices integer;
begin
  -- In the grace: paid, and the extras come back.
  perform pg_temp.pay((select id from public.billing_invoices where invoice_ref = 'FW-LIFE-1'), 'FWB-LIFE-1');
  if not app.farm_paid_extras_allowed('a1100000-0000-4000-9000-000000000001', app.billing_today()) then
    raise exception 'LIFE FAIL [11]: paying in the grace did not lift the pause on extras';
  end if;

  -- In retrieval: back at once, a fresh period from the payment date, no new invoice.
  select count(*) into v_invoices from public.billing_invoices where farm_id = 'a1100000-0000-4000-9000-000000000002';
  perform pg_temp.pay((select id from public.billing_invoices where invoice_ref = 'FW-LIFE-2'), 'FWB-LIFE-2');
  select * into s from public.billing_subscriptions where id = 'a1160000-0000-4000-9000-000000000002';
  if s.status <> 'active' or s.retrieval_ends_on is not null
     or (select status from public.farms where id = s.farm_id) <> 'active'
     or app.farm_billing_gate(s.farm_id) <> 'ok' then
    raise exception 'LIFE FAIL [11]: paying in retrieval did not bring the business back: %', to_jsonb(s);
  end if;
  if s.current_period_start <> current_date then
    raise exception 'LIFE FAIL [11]: the days without access were billed as service (period starts %)', s.current_period_start;
  end if;
  if (select count(*) from public.billing_invoices where farm_id = s.farm_id) <> v_invoices then
    raise exception 'LIFE FAIL [11]: coming back raised another invoice';
  end if;

  -- After the window: paying what is owed still brings it back, and charges nothing twice.
  perform pg_temp.pay((select id from public.billing_invoices where invoice_ref = 'FW-LIFE-5'), 'FWB-LIFE-5');
  if (select status from public.billing_subscriptions where id = 'a1160000-0000-4000-9000-000000000005') <> 'active'
     or app.farm_billing_gate('a1100000-0000-4000-9000-000000000005') <> 'ok'
     or (select count(*) from public.billing_payments p join public.billing_invoices i on i.id = p.invoice_id
          where i.farm_id = 'a1100000-0000-4000-9000-000000000005') <> 1 then
    raise exception 'LIFE FAIL [11]: a payment after the window did not reactivate once';
  end if;
end $t$;

-- Reopening a cancelled business: pending until paid, then the pause lifts by itself.
do $t$
declare v_inv uuid;
begin
  perform app.billing_reopen_subscription('a1100000-0000-4000-9000-000000000004', null);
  if app.farm_billing_gate('a1100000-0000-4000-9000-000000000004') <> 'pending' then
    raise exception 'LIFE FAIL [5]: a reopened business is not waiting for its payment: %',
      app.farm_billing_gate('a1100000-0000-4000-9000-000000000004');
  end if;
  select id into v_inv from public.billing_invoices
   where subscription_id = 'a1160000-0000-4000-9000-000000000004' and status = 'open' limit 1;
  if v_inv is null then raise exception 'LIFE FAIL [5]: reopening raised nothing to pay'; end if;
  perform pg_temp.pay(v_inv, 'FWB-LIFE-4');
  if app.farm_billing_gate('a1100000-0000-4000-9000-000000000004') <> 'ok'
     or (select status from public.farms where id = 'a1100000-0000-4000-9000-000000000004') <> 'active' then
    raise exception 'LIFE FAIL [5]: paying a reopened business did not lift its pause';
  end if;
end $t$;

rollback;
