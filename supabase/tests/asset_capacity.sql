\set ON_ERROR_STOP on
-- Support equipment on the bill and capacity that cannot be oversold (20261114090300).
-- BRIEF section 23: scenarios 1 (the four monthly fixtures and their annual equivalents,
-- from the real price rows), 2 (five-space minimum, the 200 self-service line, equipment
-- counted separately), 3 (one customer's two sites pool once; an unrelated business does
-- not), 4 (adds, imports, restores and moves cannot oversell; the guard locks), 5 (retiring
-- equipment stops its charge at renewal and keeps its history; retiring a full asset only
-- frees a space) and 9 (converting a pump at exactly five full spaces).
--
-- Two sessions racing cannot be staged in one psql session: what is proven here is that
-- the guard takes the subscription lock before it counts (so a second session waits and
-- then counts the first one's asset) and that every sequential add, import, restore and
-- move is refused past capacity, all or nothing.
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
exception when raise_exception or check_violation then
  return sqlerrm;
end $$;
create or replace function pg_temp.price(p_plan text, p_period text) returns public.billing_price_versions
language sql as $$
  select p from public.billing_price_versions p
   where p.version_label = 'launch-2026-11-eq' and p.plan = p_plan::farm_plan and p.billing_period = p_period::billing_period;
$$;

-- == Scenario 1: the fixtures, priced by the function the invoice run uses ===================
do $t$
declare
  fx record;
begin
  for fx in select * from (values
    -- full, equipment, essential, professional, complete (monthly cents)
    (5,  2, 24500, 39500, 49500),
    (5,  5, 29000, 39500, 49500),
    (5, 15, 44000, 54500, 49500),
    (5, 20, 51500, 62000, 57000)) as v(f, e, ess, pro, com)
  loop
    if app.billing_renewal_cents(pg_temp.price('essential', 'monthly'), fx.f, fx.e) <> fx.ess
       or app.billing_renewal_cents(pg_temp.price('professional', 'monthly'), fx.f, fx.e) <> fx.pro
       or app.billing_renewal_cents(pg_temp.price('complete', 'monthly'), fx.f, fx.e) <> fx.com then
      raise exception 'CAPACITY FAIL [1]: monthly fixture % full + % equipment is %, %, %; expected %, %, %',
        fx.f, fx.e,
        app.billing_renewal_cents(pg_temp.price('essential', 'monthly'), fx.f, fx.e),
        app.billing_renewal_cents(pg_temp.price('professional', 'monthly'), fx.f, fx.e),
        app.billing_renewal_cents(pg_temp.price('complete', 'monthly'), fx.f, fx.e),
        fx.ess, fx.pro, fx.com;
    end if;
  end loop;
  -- Annual, from the stated annual prices: R490 / R790 / R990 a space, R150 an extra.
  for fx in select * from (values
    (5,  2, 245000, 395000, 495000),
    (5,  5, 290000, 395000, 495000),
    (5, 15, 440000, 545000, 495000),
    (5, 20, 515000, 620000, 570000)) as v(f, e, ess, pro, com)
  loop
    if app.billing_renewal_cents(pg_temp.price('essential', 'annual'), fx.f, fx.e) <> fx.ess
       or app.billing_renewal_cents(pg_temp.price('professional', 'annual'), fx.f, fx.e) <> fx.pro
       or app.billing_renewal_cents(pg_temp.price('complete', 'annual'), fx.f, fx.e) <> fx.com then
      raise exception 'CAPACITY FAIL [1]: annual fixture % full + % equipment priced wrongly', fx.f, fx.e;
    end if;
  end loop;
  -- Below the minimum is billed the minimum; the extra is counted, not labelled.
  if app.billing_renewal_cents(pg_temp.price('complete', 'monthly'), 3, 0) <> 49500 then
    raise exception 'CAPACITY FAIL [2]: three full spaces were not billed the five-space minimum';
  end if;
end $t$;

-- == Fixtures ===============================================================================
insert into public.farms (id, name, plan, status, billing_period) values
  ('ec100000-0000-4000-9000-000000000001', 'Main depot',      'complete',     'active', 'monthly'),
  ('ec100000-0000-4000-9000-000000000002', 'North depot',     'complete',     'active', 'monthly'),
  ('ec100000-0000-4000-9000-000000000003', 'Unrelated',       'complete',     'active', 'monthly'),
  ('ec100000-0000-4000-9000-000000000004', 'Old agreement',   'professional', 'active', 'monthly'),
  ('ec100000-0000-4000-9000-000000000005', 'Essential pumps', 'essential',    'active', 'monthly');
update public.farms set billed_through = 'ec100000-0000-4000-9000-000000000001'
 where id = 'ec100000-0000-4000-9000-000000000002';
insert into auth.users (id, email) values
  ('ec110000-0000-4000-9000-000000000001', 'owner.main@capacity.test'),
  ('ec110000-0000-4000-9000-000000000005', 'owner.ess@capacity.test'),
  ('ec110000-0000-4000-9000-000000000006', 'manager.ess@capacity.test');
insert into public.users (id, farm_id, workshop_id, role, name, email, active) values
  ('ec110000-0000-4000-9000-000000000001', 'ec100000-0000-4000-9000-000000000001', null, 'owner', 'Owner Main', 'owner.main@capacity.test', true),
  ('ec110000-0000-4000-9000-000000000005', 'ec100000-0000-4000-9000-000000000005', null, 'owner', 'Owner Ess', 'owner.ess@capacity.test', true),
  ('ec110000-0000-4000-9000-000000000006', 'ec100000-0000-4000-9000-000000000005', null, 'manager', 'Manager Ess', 'manager.ess@capacity.test', true);

insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota, equipment_extra_quota,
  current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('ec160000-0000-4000-9000-000000000001', 'ec100000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active', 5, 1,
   current_date - 30, current_date - 1, current_date, extract(day from current_date - 30)::int),
  ('ec160000-0000-4000-9000-000000000003', 'ec100000-0000-4000-9000-000000000003', 'complete', 'monthly', 'active', 5, 0,
   current_date - 30, current_date - 1, current_date, extract(day from current_date - 30)::int),
  ('ec160000-0000-4000-9000-000000000005', 'ec100000-0000-4000-9000-000000000005', 'essential', 'monthly', 'active', 5, 1,
   current_date - 30, current_date - 1, current_date, extract(day from current_date - 30)::int);
-- An agreement on the retired November list, which has no equipment terms.
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota,
  price_version_id, price_version_label, current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('ec160000-0000-4000-9000-000000000004', 'ec100000-0000-4000-9000-000000000004', 'professional', 'monthly', 'active', 5,
   (select id from public.billing_price_versions where version_label = 'launch-2026-11' and plan = 'professional' and billing_period = 'monthly'),
   'launch-2026-11', current_date - 30, current_date - 1, current_date, extract(day from current_date - 30)::int);

-- == Scenario 3: one customer, two sites, one allowance =========================================
do $t$
declare v text;
begin
  insert into public.machines (farm_id, name, type, profile)
  select 'ec100000-0000-4000-9000-000000000001', 'Main pump ' || g, 'pump_generator', 'equipment' from generate_series(1, 2) g;
  insert into public.machines (farm_id, name, type, profile)
  select 'ec100000-0000-4000-9000-000000000002', 'North pump ' || g, 'pump_generator', 'equipment' from generate_series(1, 14) g;
  insert into public.machines (farm_id, name, type)
  select 'ec100000-0000-4000-9000-000000000002', 'North truck ' || g, 'truck' from generate_series(1, 3) g;
  insert into public.machines (farm_id, name, type)
  select 'ec100000-0000-4000-9000-000000000001', 'Main truck ' || g, 'truck' from generate_series(1, 2) g;

  if app.billable_equipment_count('ec100000-0000-4000-9000-000000000001') <> 16
     or app.billable_asset_count('ec100000-0000-4000-9000-000000000001') <> 5 then
    raise exception 'CAPACITY FAIL [3]: the main site does not count both sites once (% equipment, % full)',
      app.billable_equipment_count('ec100000-0000-4000-9000-000000000001'),
      app.billable_asset_count('ec100000-0000-4000-9000-000000000001');
  end if;
  -- 15 included + 1 extra paid: the seventeenth, at either site, is refused.
  v := pg_temp.try($s$insert into public.machines (farm_id, name, type, profile)
                      values ('ec100000-0000-4000-9000-000000000002', 'One too many', 'compressor', 'equipment')$s$);
  if v <> 'equipment-limit-reached' then raise exception 'CAPACITY FAIL [3]: the pooled equipment went past capacity: %', v; end if;
  -- And a sixth full asset at either site is past the five full spaces.
  v := pg_temp.try($s$insert into public.machines (farm_id, name, type)
                      values ('ec100000-0000-4000-9000-000000000001', 'Sixth truck', 'truck')$s$);
  if v <> 'vehicle-limit-reached' then raise exception 'CAPACITY FAIL [3]: a sixth full space was taken: %', v; end if;

  -- An unrelated business has its own 15, and borrows nothing from the customer above.
  insert into public.machines (farm_id, name, type, profile)
  select 'ec100000-0000-4000-9000-000000000003', 'Other pump ' || g, 'pump_generator', 'equipment' from generate_series(1, 15) g;
  v := pg_temp.try($s$insert into public.machines (farm_id, name, type, profile)
                      values ('ec100000-0000-4000-9000-000000000003', 'Sixteenth', 'trailer', 'equipment')$s$);
  if v <> 'equipment-limit-reached' then raise exception 'CAPACITY FAIL [3]: an unrelated business used another''s extra space: %', v; end if;

  -- An agreement without equipment terms takes no equipment.
  v := pg_temp.try($s$insert into public.machines (farm_id, name, type, profile)
                      values ('ec100000-0000-4000-9000-000000000004', 'Pump', 'pump_generator', 'equipment')$s$);
  if v <> 'equipment-not-in-agreement' then raise exception 'CAPACITY FAIL [3]: an old agreement took equipment: %', v; end if;
end $t$;

-- One invoice for the customer: five full spaces once, one extra equipment, nothing for the site.
do $t$
declare i record; n integer;
begin
  perform app.generate_billing_invoices('ec160000-0000-4000-9000-000000000001');
  select * into i from public.billing_invoices where subscription_id = 'ec160000-0000-4000-9000-000000000001';
  if i.total_incl_cents <> 49500 + 1500 or i.asset_count <> 5 or i.equipment_count <> 1
     or i.equipment_included <> 15 or i.equipment_active <> 16 then
    raise exception 'CAPACITY FAIL [3]: the pooled invoice is % (% full, % extra of % in use, % included)',
      i.total_incl_cents, i.asset_count, i.equipment_count, i.equipment_active, i.equipment_included;
  end if;
  select count(*) into n from public.billing_invoice_lines where invoice_id = i.id;
  if n <> 2 then raise exception 'CAPACITY FAIL [3]: the invoice has % lines, expected full spaces and equipment', n; end if;
  if exists (select 1 from public.billing_invoices where farm_id = 'ec100000-0000-4000-9000-000000000002') then
    raise exception 'CAPACITY FAIL [3]: the second site was invoiced on its own';
  end if;
end $t$;

-- == Scenario 2: the 200 line is for full spaces, not for equipment ==============================
do $t$ begin
  if app.self_service_max_full_spaces() <> 200 then
    raise exception 'CAPACITY FAIL [2]: the self-service line is not 200 full spaces';
  end if;
  update public.billing_subscriptions set equipment_extra_quota = 300 where id = 'ec160000-0000-4000-9000-000000000003';
  insert into public.machines (farm_id, name, type, profile)
  select 'ec100000-0000-4000-9000-000000000003', 'Tool ' || g, 'workshop_tool', 'equipment' from generate_series(1, 210) g;
  if app.billable_equipment_count('ec100000-0000-4000-9000-000000000003') <> 225 then
    raise exception 'CAPACITY FAIL [2]: paid equipment past 200 was refused';
  end if;
end $t$;

-- == Scenario 4: no overselling, all or nothing ==================================================
do $t$
declare v text; n_before integer;
begin
  -- The guard locks the subscription before it counts.
  if (select prosrc from pg_proc where oid = 'app.billing_enforce_vehicle_quota()'::regprocedure) not like '%for update%' then
    raise exception 'CAPACITY FAIL [4]: the capacity guard counts without locking the subscription';
  end if;

  -- An import of three into one free equipment space writes none of them.
  update public.billing_subscriptions set equipment_extra_quota = 2 where id = 'ec160000-0000-4000-9000-000000000001';
  n_before := app.billable_equipment_count('ec100000-0000-4000-9000-000000000001');
  v := pg_temp.try($s$insert into public.machines (farm_id, name, type, profile)
                      select 'ec100000-0000-4000-9000-000000000001', 'Imported ' || g, 'implement', 'equipment' from generate_series(1, 3) g$s$);
  if v <> 'equipment-limit-reached' or app.billable_equipment_count('ec100000-0000-4000-9000-000000000001') <> n_before then
    raise exception 'CAPACITY FAIL [4]: an import past capacity wrote part of itself (%)', v;
  end if;

  -- Retire one, fill the space, then restoring the retired one has no space left.
  update public.machines set status = 'retired' where name = 'Main pump 1' and farm_id = 'ec100000-0000-4000-9000-000000000001';
  insert into public.machines (farm_id, name, type, profile) values
    ('ec100000-0000-4000-9000-000000000001', 'Replacement pump', 'pump_generator', 'equipment'),
    ('ec100000-0000-4000-9000-000000000001', 'Second replacement', 'pump_generator', 'equipment');
  v := pg_temp.try($s$update public.machines set status = 'active'
                      where name = 'Main pump 1' and farm_id = 'ec100000-0000-4000-9000-000000000001'$s$);
  if v <> 'equipment-limit-reached' then raise exception 'CAPACITY FAIL [4]: a restore went past capacity: %', v; end if;

  -- Moving equipment between the customer's own sites takes no second space.
  update public.machines set farm_id = 'ec100000-0000-4000-9000-000000000002'
   where name = 'Replacement pump' and farm_id = 'ec100000-0000-4000-9000-000000000001';
  -- Moving one in from another customer does.
  v := pg_temp.try($s$update public.machines set farm_id = 'ec100000-0000-4000-9000-000000000002'
                      where name = 'Tool 1' and farm_id = 'ec100000-0000-4000-9000-000000000003'$s$);
  if v <> 'equipment-limit-reached' then raise exception 'CAPACITY FAIL [4]: a move from another customer took no space: %', v; end if;
end $t$;

-- == Scenario 5: retirement ==================================================================
insert into public.machines (id, farm_id, name, type, profile) values
  ('ec120000-0000-4000-9000-000000000051', 'ec100000-0000-4000-9000-000000000005', 'Borehole pump', 'pump_generator', 'equipment'),
  ('ec120000-0000-4000-9000-000000000052', 'ec100000-0000-4000-9000-000000000005', 'Generator', 'pump_generator', 'equipment'),
  ('ec120000-0000-4000-9000-000000000053', 'ec100000-0000-4000-9000-000000000005', 'Plough', 'implement', 'equipment'),
  ('ec120000-0000-4000-9000-000000000054', 'ec100000-0000-4000-9000-000000000005', 'Bakkie', 'bakkie', 'full'),
  ('ec120000-0000-4000-9000-000000000055', 'ec100000-0000-4000-9000-000000000005', 'Old pump', 'pump_generator', 'full');
insert into public.machines (farm_id, name, type)
select 'ec100000-0000-4000-9000-000000000005', 'Truck ' || g, 'truck' from generate_series(1, 3) g;
insert into public.job_cards (id, farm_id, machine_id, type) values
  ('ec180000-0000-4000-9000-000000000001', 'ec100000-0000-4000-9000-000000000005', 'ec120000-0000-4000-9000-000000000053', 'repair'),
  ('ec180000-0000-4000-9000-000000000002', 'ec100000-0000-4000-9000-000000000005', 'ec120000-0000-4000-9000-000000000055', 'service');
insert into public.fuel_tanks (id, farm_id, name) values
  ('ec130000-0000-4000-9000-000000000001', 'ec100000-0000-4000-9000-000000000005', 'Tank');
insert into public.fuel_issues (farm_id, tank_id, machine_id, litres) values
  ('ec100000-0000-4000-9000-000000000005', 'ec130000-0000-4000-9000-000000000001', 'ec120000-0000-4000-9000-000000000055', 25);

do $t$
declare i record; v text; v_inv uuid;
begin
  -- 3 equipment on Essential: 2 included, 1 extra.
  perform app.generate_billing_invoices('ec160000-0000-4000-9000-000000000005');
  select * into i from public.billing_invoices where subscription_id = 'ec160000-0000-4000-9000-000000000005';
  v_inv := i.id;
  if i.total_incl_cents <> 24500 + 1500 or i.equipment_count <> 1 then
    raise exception 'CAPACITY FAIL [5]: the first renewal is % with % extra equipment', i.total_incl_cents, i.equipment_count;
  end if;

  -- The plough is retired mid-period: no refund now, its space is free now.
  update public.machines set status = 'retired' where id = 'ec120000-0000-4000-9000-000000000053';
  -- No new ordinary work on it as a substitute for paid use; its history stays.
  v := pg_temp.try($s$insert into public.faults (farm_id, machine_id, description)
                      values ('ec100000-0000-4000-9000-000000000005', 'ec120000-0000-4000-9000-000000000053', 'Bent tine')$s$);
  if v <> 'equipment-retired' then raise exception 'CAPACITY FAIL [5]: work was posted to retired equipment: %', v; end if;
  if not exists (select 1 from public.job_cards where id = 'ec180000-0000-4000-9000-000000000001' and deleted_at is null) then
    raise exception 'CAPACITY FAIL [5]: retiring the plough lost its repair history';
  end if;

  -- A full asset retired frees a space and does not lower the bill.
  update public.machines set status = 'retired' where name = 'Truck 3' and farm_id = 'ec100000-0000-4000-9000-000000000005';

  -- The next renewal: equipment charge gone, full spaces still the five bought.
  update public.billing_subscriptions set next_billing_on = current_date where id = 'ec160000-0000-4000-9000-000000000005';
  perform app.generate_billing_invoices('ec160000-0000-4000-9000-000000000005');
  select * into i from public.billing_invoices
   where subscription_id = 'ec160000-0000-4000-9000-000000000005' and id <> v_inv;
  if i.id is null or i.total_incl_cents <> 24500 or i.equipment_count <> 0 or i.asset_count <> 5 then
    raise exception 'CAPACITY FAIL [5]: the renewal after retirement is % (% full, % extra)',
      i.total_incl_cents, i.asset_count, i.equipment_count;
  end if;
  if (select equipment_extra_quota from public.billing_subscriptions where id = 'ec160000-0000-4000-9000-000000000005') <> 0 then
    raise exception 'CAPACITY FAIL [5]: the paid extra equipment space outlived the renewal';
  end if;
  -- The first invoice is untouched by any of this.
  if (select total_incl_cents from public.billing_invoices where id = v_inv) <> 26000 then
    raise exception 'CAPACITY FAIL [5]: an issued invoice changed';
  end if;

  -- Restoring the plough now needs a space: 2 included, 2 in use, none paid.
  v := pg_temp.try($s$update public.machines set status = 'active' where id = 'ec120000-0000-4000-9000-000000000053'$s$);
  if v <> 'equipment-limit-reached' then raise exception 'CAPACITY FAIL [5]: a restore dodged the extra charge: %', v; end if;
end $t$;

-- == Scenario 9: converting a pump at exactly five full spaces ====================================
-- Essential pumps holds five full spaces: Bakkie, Old pump, Truck 1, Truck 2 (Truck 3 retired) = 4 in use.
select pg_temp.as_user('ec110000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$
declare v jsonb; v_text text;
begin
  -- The preview first: one equipment space would be needed (2 included, 2 in use, none paid)...
  v := public.asset_conversion_preview('ec120000-0000-4000-9000-000000000055', 'equipment');
  if (v #>> '{needs,equipment_spaces}')::int <> 1 or (v ->> 'fits_now')::boolean or v #>> '{charge_now,status}' <> 'quote_pending' then
    raise exception 'CAPACITY FAIL [9]: the preview did not say a space is needed: %', v;
  end if;
  -- ...so the conversion waits for that space to be bought (task A2 prices it).
  begin
    perform public.convert_asset_profile('ec120000-0000-4000-9000-000000000055', 'equipment', null);
    raise exception 'CAPACITY FAIL [9]: converted without the capacity it needs';
  exception when raise_exception then
    if sqlerrm <> 'capacity-needed' then raise; end if;
  end;
end $t$;
reset role;
-- The extra space is bought (A2's purchase, stood in for here).
update public.billing_subscriptions set equipment_extra_quota = 1 where id = 'ec160000-0000-4000-9000-000000000005';
select pg_temp.as_user('ec110000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$
declare v jsonb; v_after bigint;
begin
  v := public.asset_conversion_preview('ec120000-0000-4000-9000-000000000055', 'equipment');
  -- Five full spaces stay bought, so the full part does not fall below the minimum; the extra
  -- equipment adds R15. Every plan's renewal for this mix is listed.
  if (v #>> '{renewal,before_cents}')::bigint <> 24500 or (v #>> '{renewal,after_cents}')::bigint <> 26000
     or jsonb_array_length(v -> 'plans') <> 3 or v ->> 'conversion_blocked' is not null then
    raise exception 'CAPACITY FAIL [9]: the conversion preview is %', v;
  end if;
  v_after := (v #>> '{renewal,after_cents}')::bigint;
  -- Accepting an out-of-date total is refused.
  begin
    perform public.convert_asset_profile('ec120000-0000-4000-9000-000000000055', 'equipment', v_after - 100);
    raise exception 'CAPACITY FAIL [9]: a stale preview was accepted';
  exception when raise_exception then
    if sqlerrm <> 'preview-changed' then raise; end if;
  end;
  v := public.convert_asset_profile('ec120000-0000-4000-9000-000000000055', 'equipment', v_after);
  if (select profile from public.machines where id = 'ec120000-0000-4000-9000-000000000055') <> 'equipment' then
    raise exception 'CAPACITY FAIL [9]: the pump did not convert';
  end if;
  -- A truck never converts.
  begin
    perform public.convert_asset_profile((select id from public.machines where name = 'Truck 1'
                                           and farm_id = 'ec100000-0000-4000-9000-000000000005'), 'equipment', null);
    raise exception 'CAPACITY FAIL [9]: a truck took the equipment profile';
  exception when raise_exception then
    if sqlerrm <> 'equipment-type-not-eligible' then raise; end if;
  end;
end $t$;
reset role;
do $t$
declare v text;
begin
  -- Identity and history stay: the same asset, its service job card and its old fuel draw.
  if not exists (select 1 from public.job_cards where id = 'ec180000-0000-4000-9000-000000000002' and machine_id = 'ec120000-0000-4000-9000-000000000055')
     or not exists (select 1 from public.fuel_issues where machine_id = 'ec120000-0000-4000-9000-000000000055') then
    raise exception 'CAPACITY FAIL [9]: the conversion lost history';
  end if;
  if (select count(*) from public.asset_profile_changes where machine_id = 'ec120000-0000-4000-9000-000000000055'
       and from_profile = 'full' and to_profile = 'equipment' and renewal_after_cents = 26000) <> 1 then
    raise exception 'CAPACITY FAIL [9]: the conversion was not recorded with its preview';
  end if;
  -- New work follows the equipment profile.
  v := pg_temp.try($s$insert into public.fuel_issues (farm_id, tank_id, machine_id, litres) values
                      ('ec100000-0000-4000-9000-000000000005', 'ec130000-0000-4000-9000-000000000001', 'ec120000-0000-4000-9000-000000000055', 10)$s$);
  if v <> 'equipment-refused-fuel' then raise exception 'CAPACITY FAIL [9]: new fuel was recorded on the converted pump: %', v; end if;
  -- The minimum holds: the next renewal still bills five full spaces, plus the one extra.
  if app.billing_renewal_cents(pg_temp.price('essential', 'monthly'),
       (select asset_quota from public.billing_subscriptions where id = 'ec160000-0000-4000-9000-000000000005'),
       app.billable_equipment_count('ec100000-0000-4000-9000-000000000005')) <> 26000 then
    raise exception 'CAPACITY FAIL [9]: the renewal after conversion is not R245 plus R15';
  end if;
  -- The freed full space can take another vehicle without buying one.
  insert into public.machines (farm_id, name, type) values ('ec100000-0000-4000-9000-000000000005', 'New bakkie', 'bakkie');
end $t$;

-- A manager sees the spaces, never the money.
select pg_temp.as_user('ec110000-0000-4000-9000-000000000006');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.asset_add_preview('ec100000-0000-4000-9000-000000000005', 0, 1);
  if v ? 'renewal' or v ? 'plans' or v #>> '{equipment,active}' is null then
    raise exception 'CAPACITY FAIL: the manager''s preview showed money or lost the spaces: %', v;
  end if;
  begin
    perform public.equipment_migration_preview('ec100000-0000-4000-9000-000000000005');
    raise exception 'CAPACITY FAIL: a manager read the migration preview''s money';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

-- The owner's summary and the read-only migration preview.
select pg_temp.as_user('ec110000-0000-4000-9000-000000000005');
set local role authenticated;
do $t$
declare v jsonb;
begin
  v := public.asset_capacity_summary('ec100000-0000-4000-9000-000000000005');
  if (v #>> '{full,purchased}')::int <> 5 or (v #>> '{full,free_now}')::int <> 0
     or (v #>> '{equipment,included}')::int <> 2 or (v #>> '{equipment,extra_paid}')::int <> 1
     or (v #>> '{equipment,free_now}')::int <> 0 or (v #>> '{equipment,extra_next_renewal}')::int <> 1 then
    raise exception 'CAPACITY FAIL: the capacity summary is %', v;
  end if;
  v := public.equipment_migration_preview('ec100000-0000-4000-9000-000000000005');
  if (v ->> 'candidates')::int <> 0 or (v ->> 'renewal_now_cents')::bigint <> 26000 then
    raise exception 'CAPACITY FAIL: the migration preview is %', v;
  end if;
end $t$;
reset role;

rollback;
