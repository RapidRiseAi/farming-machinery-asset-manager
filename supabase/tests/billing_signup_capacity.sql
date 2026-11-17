\set ON_ERROR_STOP on
-- Signing up with support equipment, the 200-space online line and the quote above it
-- (20261115130000). BRIEF section 23: scenario 2 (five full spaces at least, 200 online, 201
-- routed to a capacity check and quote, equipment counted separately and not part of that
-- line) and the sign-up half of scenario 41 (the quantities reach the first invoice exactly).
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end $$;
create or replace function pg_temp.signup(p_n integer, p_plan text, p_period text, p_full integer, p_equipment integer)
returns uuid language plpgsql as $$
declare v_user uuid := ('a3110000-0000-4000-9000-' || lpad(p_n::text, 12, '0'))::uuid;
begin
  insert into auth.users (id, email) values (v_user, 'signup' || p_n || '@quote.test');
  return public.billing_create_pending_signup(v_user, 'signup' || p_n || '@quote.test', 'Owner ' || p_n,
    'Signup ' || p_n, p_plan::farm_plan, p_period::billing_period, p_full, null, p_equipment);
end $$;

-- == Scenario 2: the first invoice carries the full spaces and the equipment beyond the allowance
do $t$
declare v_sub uuid; s public.billing_subscriptions%rowtype; i public.billing_invoices%rowtype;
begin
  -- Professional, five full and fifteen equipment: R545 a month, ten of them extra.
  v_sub := pg_temp.signup(1, 'professional', 'monthly', 5, 15);
  select * into s from public.billing_subscriptions where id = v_sub;
  select * into i from public.billing_invoices where subscription_id = v_sub;
  if s.status <> 'pending' or s.asset_quota <> 5 or s.equipment_extra_quota <> 10
     or i.total_incl_cents <> 54500 or i.equipment_count <> 10 then
    raise exception 'SIGNUP FAIL [2]: five full and fifteen equipment on Professional is not R545 (quota %, extra %, total %)',
      s.asset_quota, s.equipment_extra_quota, i.total_incl_cents;
  end if;
  -- Complete, a year, five full and twenty equipment: R4 950 + 5 x R150 = R5 700.
  v_sub := pg_temp.signup(2, 'complete', 'annual', 5, 20);
  if (select total_incl_cents from public.billing_invoices where subscription_id = v_sub) <> 570000 then
    raise exception 'SIGNUP FAIL [2]: the annual sign-up is not priced from the stated annual prices';
  end if;
  -- Fewer than five full spaces are billed, and held, as five; equipment within the allowance is free.
  v_sub := pg_temp.signup(3, 'essential', 'monthly', 3, 2);
  select * into s from public.billing_subscriptions where id = v_sub;
  if s.asset_quota <> 5 or s.equipment_extra_quota <> 0
     or (select total_incl_cents from public.billing_invoices where subscription_id = v_sub) <> 24500 then
    raise exception 'SIGNUP FAIL [2]: three spaces and two included equipment are not five spaces at R245';
  end if;
  -- 200 full spaces online, with any amount of equipment: the line is on full spaces only.
  v_sub := pg_temp.signup(4, 'essential', 'monthly', 200, 300);
  if (select asset_quota from public.billing_subscriptions where id = v_sub) <> 200 then
    raise exception 'SIGNUP FAIL [2]: 200 full spaces were not taken online';
  end if;
end $t$;

do $t$
declare v text;
begin
  -- 201: not a sign-up, a capacity check and a quote (decision 39).
  v := pg_temp.try($s$select pg_temp.signup(5, 'essential', 'monthly', 201, 0)$s$);
  if v <> 'signup-capacity-quote' then raise exception 'SIGNUP FAIL [2]: 201 full spaces were signed up online: %', v; end if;
  if exists (select 1 from public.users where email = 'signup5@quote.test') then
    raise exception 'SIGNUP FAIL [2]: a refused sign-up left a person behind';
  end if;
  v := pg_temp.try($s$select pg_temp.signup(6, 'essential', 'monthly', 5, -1)$s$);
  if v <> 'signup-equipment' then raise exception 'SIGNUP FAIL [2]: a negative equipment count was taken: %', v; end if;
end $t$;

-- The live build's call (seven named arguments, no equipment) still resolves, and means none.
do $t$
declare v_sub uuid;
begin
  insert into auth.users (id, email) values ('a3110000-0000-4000-9000-000000000007', 'signup7@quote.test');
  v_sub := public.billing_create_pending_signup(p_user => 'a3110000-0000-4000-9000-000000000007',
    p_email => 'signup7@quote.test', p_name => 'Owner 7', p_farm_name => 'Signup 7',
    p_plan => 'essential', p_period => 'monthly', p_quota => 5);
  if (select equipment_extra_quota from public.billing_subscriptions where id = v_sub) <> 0 then
    raise exception 'SIGNUP FAIL [compat]: the seven-argument call did not mean no equipment';
  end if;
end $t$;

-- == Above the line: a quote request, and Rapid Rise hears of it =================================
insert into auth.users (id, email) values ('a3120000-0000-4000-9000-000000000001', 'rr@quote.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('a3120000-0000-4000-9000-000000000001', null, null, 'rr_admin', 'Rapid Rise', 'rr@quote.test', true);
do $t$
declare v_id uuid; v text;
begin
  v_id := public.billing_request_capacity_quote('Big Fleet Owner', 'Owner@BigFleet.test', 'Big Fleet', 'professional',
                                                'annual', 450, 120, 'Three depots', 'af');
  if not exists (select 1 from public.capacity_quote_requests r
                  where r.id = v_id and r.full_spaces = 450 and r.equipment = 120 and r.email = 'owner@bigfleet.test'
                    and r.status = 'new' and r.lang = 'af') then
    raise exception 'SIGNUP FAIL [2]: the quote request was not kept as asked';
  end if;
  if not exists (select 1 from public.notifications n where n.user_id = 'a3120000-0000-4000-9000-000000000001'
                   and n.template = 'capacity_quote_requested' and n.payload ->> 'request_id' = v_id::text) then
    raise exception 'SIGNUP FAIL [2]: Rapid Rise was not told of the quote request';
  end if;
  v := pg_temp.try($s$select public.billing_request_capacity_quote('A', 'a@small.test', 'Small', 'essential', 'monthly', 150, 0, null, 'en')$s$);
  if v <> 'signup-quote-not-needed' then
    raise exception 'SIGNUP FAIL [2]: a quote request was kept for a fleet that can sign up online: %', v;
  end if;
end $t$;

-- == Who reaches it ==============================================================================
do $t$
begin
  if has_function_privilege('authenticated', 'public.billing_request_capacity_quote(text,text,text,farm_plan,billing_period,integer,integer,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.billing_request_capacity_quote(text,text,text,farm_plan,billing_period,integer,integer,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.billing_create_pending_signup(uuid,text,text,text,farm_plan,billing_period,integer,text,integer)', 'EXECUTE')
     or has_table_privilege('authenticated', 'public.capacity_quote_requests', 'INSERT')
     or has_table_privilege('anon', 'public.capacity_quote_requests', 'SELECT') then
    raise exception 'SIGNUP FAIL [grants]: a browser can sign up, ask for a quote or write requests directly';
  end if;
end $t$;

select pg_catalog.set_config('request.jwt.claims',
  json_build_object('sub', 'a3110000-0000-4000-9000-000000000001', 'role', 'authenticated')::text, true);
set local role authenticated;
do $t$
begin
  if (select count(*) from public.capacity_quote_requests) <> 0 then
    raise exception 'SIGNUP FAIL [rls]: a customer read a prospective customer''s quote request';
  end if;
end $t$;
reset role;

rollback;
