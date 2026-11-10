\set ON_ERROR_STOP on
-- One bill for several sites, usage, and Done-For-You quotes (20261107150000).
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

insert into public.farms (id, name, plan, status, billing_period) values
  ('eb000000-0000-4000-9000-000000000001', 'Main depot', 'complete', 'active', 'monthly'),
  ('eb000000-0000-4000-9000-000000000002', 'North depot', 'complete', 'active', 'monthly'),
  ('eb000000-0000-4000-9000-000000000003', 'Elsewhere', 'complete', 'active', 'monthly');
insert into public.billing_subscriptions (farm_id, plan, billing_period, status, asset_quota) values
  ('eb000000-0000-4000-9000-000000000001', 'complete', 'monthly', 'active', 3);

update public.farms set billed_through = 'eb000000-0000-4000-9000-000000000001'
 where id = 'eb000000-0000-4000-9000-000000000002';

insert into public.machines (farm_id, name, type) values
  ('eb000000-0000-4000-9000-000000000001', 'Main 1', 'truck'),
  ('eb000000-0000-4000-9000-000000000002', 'North 1', 'truck'),
  ('eb000000-0000-4000-9000-000000000002', 'North 2', 'truck');

do $t$
begin
  -- The main site bills for both; each site still counts its own.
  if app.billable_asset_count('eb000000-0000-4000-9000-000000000001') <> 3 then
    raise exception 'the main site does not bill for its other sites';
  end if;
  if (select asset_count from public.farms where id = 'eb000000-0000-4000-9000-000000000002') <> 2 then
    raise exception 'a site lost its own vehicle count';
  end if;

  -- The pooled slots are full, from either site.
  begin
    insert into public.machines (farm_id, name, type) values ('eb000000-0000-4000-9000-000000000002', 'North 3', 'truck');
    raise exception 'a site went past the slots it shares';
  exception when check_violation then null;
  end;

  -- One level only.
  begin
    update public.farms set billed_through = 'eb000000-0000-4000-9000-000000000002'
     where id = 'eb000000-0000-4000-9000-000000000003';
    raise exception 'a site was billed through a site that is itself billed through another';
  exception when invalid_parameter_value then null;
  end;
  begin
    update public.farms set billed_through = 'eb000000-0000-4000-9000-000000000003'
     where id = 'eb000000-0000-4000-9000-000000000001';
    raise exception 'a main site was billed through another';
  exception when invalid_parameter_value then null;
  end;

  -- A site follows the main site's state.
  if app.farm_billing_gate('eb000000-0000-4000-9000-000000000002') <> 'ok' then raise exception 'the site is not open'; end if;
  update public.billing_subscriptions set status = 'pending' where farm_id = 'eb000000-0000-4000-9000-000000000001';
  if app.farm_billing_gate('eb000000-0000-4000-9000-000000000002') <> 'pending' then
    raise exception 'a site stayed open while its main site waits for payment';
  end if;
  update public.billing_subscriptions set status = 'active' where farm_id = 'eb000000-0000-4000-9000-000000000001';
end $t$;

-- A Done-For-You quote becomes this customer's own price, and only theirs.
do $t$
declare
  v_quote uuid;
  v_price uuid;
begin
  v_quote := public.billing_record_dfy_quote('eb000000-0000-4000-9000-000000000001', 'Q-77', 17000, 15,
                                             'monthly', current_date, 'Agreed by phone', null);
  select price_version_id into v_price from public.done_for_you_quotes where id = v_quote;
  if not exists (select 1 from public.billing_price_versions
                  where id = v_price and status = 'draft' and per_vehicle_monthly_incl_cents = 17000
                    and min_billed_slots = 15 and plan = 'done_for_you') then
    raise exception 'the quote did not become a private price';
  end if;
  if (select price_version_id from public.billing_subscriptions where farm_id = 'eb000000-0000-4000-9000-000000000001') <> v_price
     or (select plan::text from public.billing_subscriptions where farm_id = 'eb000000-0000-4000-9000-000000000001') <> 'done_for_you' then
    raise exception 'the subscription is not pinned to the quote';
  end if;
  if (select (app.billing_price_for_subscription(s.id)).id from public.billing_subscriptions s
       where s.farm_id = 'eb000000-0000-4000-9000-000000000001') <> v_price then
    raise exception 'the invoice run would not use the quoted price';
  end if;
  if app.billing_active_price('done_for_you', 'monthly') is not null
     and (app.billing_active_price('done_for_you', 'monthly')).id = v_price then
    raise exception 'a private quote became everyone''s price';
  end if;
  begin
    perform public.billing_record_dfy_quote('eb000000-0000-4000-9000-000000000003', 'Q-78', 17000, 15, 'monthly', current_date, null, null);
    raise exception 'a business with no subscription was priced';
  exception when invalid_parameter_value then null;
  end;
end $t$;

-- Usage is the server's to read, and rates are Rapid Rise's to set.
do $t$
begin
  if has_function_privilege('authenticated', 'public.usage_for_month(date)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.billing_record_dfy_quote(uuid,text,integer,integer,billing_period,date,text,uuid)', 'EXECUTE') then
    raise exception 'usage and quotes are for the server alone';
  end if;
  if (select count(*) from public.usage_for_month(current_date)) < 0 then raise exception 'usage did not run'; end if;
end $t$;

rollback;
