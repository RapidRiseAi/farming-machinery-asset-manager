\set ON_ERROR_STOP on
-- Pooled attachment storage (20261118120000). BRIEF section 23:
--   24  the 2 GB minimum, the 2.375 GB example, included equipment counted, retired files kept,
--       a changed allowance at renewal shown before it lands;
--   25  full storage stops new attachments only: records and forms carry on, nothing is removed,
--       the owner is told once; warnings at 80% and 95%;
--   26  automatic blocks OFF by default; a R98 ceiling allows two blocks IN TOTAL (existing ones
--       count); demand after a purchase does not buy a second block; never in the grace.
-- Also: one customer's two sites share one pool and an unrelated business does not; files with
-- no upload intent (from before the pipeline) count, in the counted buckets only; who reads what.
--
-- Two sessions racing cannot be staged in one psql session: what is proven is that the reserve
-- takes the pool's lock before it counts and buys (structural, asserted below from the source)
-- and that sequential demand after a purchase finds the new room rather than buying again.
set client_min_messages to warning;
begin;
select pg_catalog.set_config('request.jwt.claims', '', false);

create or replace function pg_temp.as_user(p uuid) returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims',
    json_build_object('sub', p, 'role', 'authenticated', 'aal', 'aal2')::text, true);
$$;
create or replace function pg_temp.nobody() returns void language sql as $$
  select pg_catalog.set_config('request.jwt.claims', '', true);
$$;
-- A file already stored through the pipeline, written straight in (the test stands in for the
-- verify and commit steps, which upload_pipeline.sql proves).
create or replace function pg_temp.stored(p_farm uuid, p_user uuid, p_target uuid, p_bytes bigint) returns uuid
language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into public.upload_intents (id, farm_id, user_id, target_kind, target_id, label, bucket, object_path,
    media_class, purpose, declared_mime, declared_bytes, reserved_bytes, counts_against_quota,
    actual_mime, actual_bytes, status, request_id, expires_at, verified_at, finalised_at)
  values (v, p_farm, p_user, 'machine', p_target, 'photo', 'machine-photos',
    p_farm::text || '/' || p_target::text || '/photo-' || v::text || '.jpg',
    'photo', 'attachment', 'image/jpeg', p_bytes, p_bytes, true,
    'image/jpeg', p_bytes, 'finalised', gen_random_uuid(), now() + interval '1 hour', now(), now());
  return v;
end $$;
-- upload_begin as whoever is signed in: 'ok' or the error.
create or replace function pg_temp.begin_upload(p_farm uuid, p_machine uuid, p_bytes bigint) returns text
language plpgsql as $$
begin
  perform public.upload_begin(p_farm, null, 'machine', p_machine, 'photo', 'photo', 'image/jpeg', p_bytes,
                              gen_random_uuid(), 'jpg');
  return 'ok';
exception when sqlstate 'P0001' or insufficient_privilege or sqlstate '22023' then
  return sqlerrm;
end $$;

-- == Fixtures ===============================================================================
-- A  Main depot (Complete, 5 full, 15 included equipment) and N its North depot, billed through it
-- U  Unrelated (Complete, 10 full)                         T  Twenty (Complete, 20 full)
-- B  Big Essential (30 full, 2 included + 10 extra equipment)
-- G  Grace (Complete, 5 full, a declined renewal)
insert into public.farms (id, name, plan, status, billing_period) values
  ('5a000000-0000-4000-9000-00000000000a', 'Main depot',  'complete',  'active', 'monthly'),
  ('5a000000-0000-4000-9000-00000000000b', 'North depot', 'complete',  'active', 'monthly'),
  ('5a000000-0000-4000-9000-00000000000c', 'Unrelated',   'complete',  'active', 'monthly'),
  ('5a000000-0000-4000-9000-00000000000d', 'Twenty',      'complete',  'active', 'monthly'),
  ('5a000000-0000-4000-9000-00000000000e', 'Big pumps',   'essential', 'active', 'monthly'),
  ('5a000000-0000-4000-9000-00000000000f', 'Grace farm',  'complete',  'active', 'monthly');
update public.farms set billed_through = '5a000000-0000-4000-9000-00000000000a'
 where id = '5a000000-0000-4000-9000-00000000000b';
insert into auth.users (id, email)
select ('5a100000-0000-4000-9000-00000000000' || n)::uuid, 'storage' || n || '@pool.test' from generate_series(1, 6) n;
insert into public.users (id, farm_id, role, name, email, active) values
  ('5a100000-0000-4000-9000-000000000001', '5a000000-0000-4000-9000-00000000000a', 'owner',   'Owner Main', 'storage1@pool.test', true),
  ('5a100000-0000-4000-9000-000000000002', '5a000000-0000-4000-9000-00000000000a', 'manager', 'Manager Main', 'storage2@pool.test', true),
  ('5a100000-0000-4000-9000-000000000003', '5a000000-0000-4000-9000-00000000000c', 'owner',   'Owner Unrelated', 'storage3@pool.test', true),
  ('5a100000-0000-4000-9000-000000000004', '5a000000-0000-4000-9000-00000000000b', 'operator', 'North driver', 'storage4@pool.test', true),
  ('5a100000-0000-4000-9000-000000000005', '5a000000-0000-4000-9000-00000000000f', 'owner',   'Owner Grace', 'storage5@pool.test', true),
  ('5a100000-0000-4000-9000-000000000006', '5a000000-0000-4000-9000-00000000000e', 'owner',   'Owner Big', 'storage6@pool.test', true);
insert into public.billing_subscriptions (id, farm_id, plan, billing_period, status, asset_quota, equipment_extra_quota,
  current_period_start, current_period_end, next_billing_on, anchor_day) values
  ('5a600000-0000-4000-9000-00000000000a', '5a000000-0000-4000-9000-00000000000a', 'complete',  'monthly', 'active', 5, 0,
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int),
  ('5a600000-0000-4000-9000-00000000000c', '5a000000-0000-4000-9000-00000000000c', 'complete',  'monthly', 'active', 10, 0,
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int),
  ('5a600000-0000-4000-9000-00000000000d', '5a000000-0000-4000-9000-00000000000d', 'complete',  'monthly', 'active', 20, 0,
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int),
  ('5a600000-0000-4000-9000-00000000000e', '5a000000-0000-4000-9000-00000000000e', 'essential', 'monthly', 'active', 30, 10,
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int),
  ('5a600000-0000-4000-9000-00000000000f', '5a000000-0000-4000-9000-00000000000f', 'complete',  'monthly', 'active', 5, 0,
   current_date - 10, current_date + 19, current_date + 20, extract(day from current_date - 10)::int);
-- The periods in South African days (app.billing_today), which the storage month is decided on:
-- between 22:00 and 24:00 UTC current_date is still yesterday there.
update public.billing_subscriptions
   set current_period_start = app.billing_today() - 10, current_period_end = app.billing_today() + 19,
       next_billing_on = app.billing_today() + 20
 where farm_id::text like '5a000000-%';
insert into public.machines (id, farm_id, name, type) values
  ('5a200000-0000-4000-9000-00000000000a', '5a000000-0000-4000-9000-00000000000a', 'Main truck',  'truck'),
  ('5a200000-0000-4000-9000-00000000000b', '5a000000-0000-4000-9000-00000000000b', 'North truck', 'truck'),
  ('5a200000-0000-4000-9000-00000000000c', '5a000000-0000-4000-9000-00000000000c', 'Other truck', 'truck'),
  ('5a200000-0000-4000-9000-00000000000f', '5a000000-0000-4000-9000-00000000000f', 'Grace truck', 'truck');
insert into public.machines (id, farm_id, name, type, profile) values
  ('5a200000-0000-4000-9000-0000000000e1', '5a000000-0000-4000-9000-00000000000e', 'Big pump', 'pump_generator', 'equipment');

-- == 24: the allowance ======================================================================
do $t$
declare a jsonb;
begin
  -- Five full + fifteen equipment (Complete's included 15): 875 MB by the sum, so the 2 GB minimum.
  a := app.storage_allowance('5a000000-0000-4000-9000-00000000000a');
  if (a ->> 'included_bytes')::bigint <> 2000000000 or (a ->> 'equipment_spaces')::int <> 15 or (a ->> 'full_spaces')::int <> 5 then
    raise exception 'STORAGE FAIL [24]: 5 full + 15 equipment gave %', a;
  end if;
  -- Ten + fifteen: 1.375 GB by the sum, still the minimum.
  a := app.storage_allowance('5a000000-0000-4000-9000-00000000000c');
  if (a ->> 'included_bytes')::bigint <> 2000000000 then
    raise exception 'STORAGE FAIL [24]: 10 full + 15 equipment gave %', a ->> 'included_bytes';
  end if;
  -- Twenty + fifteen: 2.375 GB.
  a := app.storage_allowance('5a000000-0000-4000-9000-00000000000d');
  if (a ->> 'included_bytes')::bigint <> 2375000000 or (a ->> 'total_bytes')::bigint <> 2375000000 then
    raise exception 'STORAGE FAIL [24]: 20 full + 15 equipment gave %', a ->> 'included_bytes';
  end if;
  -- Essential's two included spaces count as well as the ten extra paid: 30 x 100 MB + 12 x 25 MB.
  a := app.storage_allowance('5a000000-0000-4000-9000-00000000000e');
  if (a ->> 'equipment_spaces')::int <> 12 or (a ->> 'included_bytes')::bigint <> 3300000000 then
    raise exception 'STORAGE FAIL [24]: included equipment was not counted: %', a;
  end if;
  -- At its renewal the extra equipment is what is then in use (one pump): 2 included only.
  if (a #>> '{next,equipment_spaces}')::int <> 2 or (a #>> '{next,included_bytes}')::bigint <> 3050000000 then
    raise exception 'STORAGE FAIL [24]: the next renewal''s allowance is wrong: %', a -> 'next';
  end if;
  -- One customer's other site has the same pool; an unrelated business has its own.
  if app.storage_pool_farm_ids('5a000000-0000-4000-9000-00000000000b')
       <> array['5a000000-0000-4000-9000-00000000000a', '5a000000-0000-4000-9000-00000000000b']::uuid[]
     or (app.storage_allowance('5a000000-0000-4000-9000-00000000000b') ->> 'root')::uuid <> '5a000000-0000-4000-9000-00000000000a'
     or app.storage_pool_farm_ids('5a000000-0000-4000-9000-00000000000c') <> array['5a000000-0000-4000-9000-00000000000c']::uuid[] then
    raise exception 'STORAGE FAIL [3/24]: the pools are wrong';
  end if;
  -- Pure arithmetic: the floor, and decimal units.
  if app.storage_included_bytes(0, 0) <> 2000000000 or app.storage_included_bytes(21, 0) <> 2100000000
     or app.storage_block_bytes() <> 10000000000 then
    raise exception 'STORAGE FAIL [24]: the arithmetic is wrong';
  end if;
end $t$;

-- A reduction of full spaces scheduled for the renewal shows the smaller allowance beside the
-- current one, and changes nothing today.
update public.billing_subscriptions set pending_quota = 21, pending_quota_on = current_date + 20, pending_quota_set_at = now() where id = '5a600000-0000-4000-9000-00000000000e';
do $t$
declare a jsonb := app.storage_allowance('5a000000-0000-4000-9000-00000000000e');
begin
  if (a ->> 'included_bytes')::bigint <> 3300000000 or (a #>> '{next,included_bytes}')::bigint <> 2150000000 then
    raise exception 'STORAGE FAIL [24]: a scheduled reduction was not shown, or applied early: %', a;
  end if;
end $t$;
update public.billing_subscriptions set pending_quota = null, pending_quota_on = null, pending_quota_set_at = null where id = '5a600000-0000-4000-9000-00000000000e';

-- Retiring equipment deletes no file, and its files keep counting, even over the next allowance.
do $t$
declare
  f uuid := pg_temp.stored('5a000000-0000-4000-9000-00000000000e', '5a100000-0000-4000-9000-000000000006',
                           '5a200000-0000-4000-9000-0000000000e1', 3200000000);
begin
  update public.machines set status = 'retired' where id = '5a200000-0000-4000-9000-0000000000e1';
  if not exists (select 1 from public.upload_intents where id = f and status = 'finalised' and object_removed_at is null) then
    raise exception 'STORAGE FAIL [24]: retiring the pump touched its file';
  end if;
  if app.storage_pool_usage(app.storage_pool_farm_ids('5a000000-0000-4000-9000-00000000000e')) <> 3200000000 then
    raise exception 'STORAGE FAIL [24]: the retired pump''s file stopped counting';
  end if;
end $t$;

-- == 25: full storage stops new attachments only ============================================
-- The North depot fills the shared pool to 1 MB short of 2 GB.
select pg_temp.stored('5a000000-0000-4000-9000-00000000000b', '5a100000-0000-4000-9000-000000000004',
                      '5a200000-0000-4000-9000-00000000000b', 1999000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v text; n integer;
begin
  select count(*) into n from public.upload_intents;
  -- A 2 MB photo at the MAIN depot is refused: the North depot's file is in the same pool.
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000a', '5a200000-0000-4000-9000-00000000000a', 2000000);
  if v <> 'upload:storage_full' then raise exception 'STORAGE FAIL [25]: a photo past the pool was not refused: %', v; end if;
  -- Exactly to the byte still fits.
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000a', '5a200000-0000-4000-9000-00000000000a', 1000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [25]: a photo that fits to the byte was refused: %', v; end if;
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000a', '5a200000-0000-4000-9000-00000000000a', 1);
  if v <> 'upload:storage_full' then raise exception 'STORAGE FAIL [25]: one byte past the pool: %', v; end if;
  -- The upload route tells the owner after the refusal (which rolled its own work back); twice
  -- is still one notice.
  if not public.storage_note_full('5a000000-0000-4000-9000-00000000000a') then
    raise exception 'STORAGE FAIL [25]: the full notice was not sent';
  end if;
  if public.storage_note_full('5a000000-0000-4000-9000-00000000000a') then
    raise exception 'STORAGE FAIL [25]: the full notice was sent twice';
  end if;
  -- Records and forms without attachments carry on.
  insert into public.faults (farm_id, machine_id, description, status)
  values ('5a000000-0000-4000-9000-00000000000a', '5a200000-0000-4000-9000-00000000000a', 'Leak, no photo', 'open');
end $t$;
reset role;
do $t$
begin
  -- Nothing stored was removed to make room, and the refused uploads left nothing behind.
  if exists (select 1 from public.upload_intents where object_removed_at is not null or status in ('failed', 'expired')) then
    raise exception 'STORAGE FAIL [25]: a full pool removed or failed something';
  end if;
  if (select count(*) from public.upload_intents where farm_id = '5a000000-0000-4000-9000-00000000000a') <> 1 then
    raise exception 'STORAGE FAIL [25]: a refused upload left an intent';
  end if;
  if not exists (select 1 from public.faults where description = 'Leak, no photo') then
    raise exception 'STORAGE FAIL [25]: a form without attachments was stopped by full storage';
  end if;
  -- The owner was told once that it is full, not once per refusal; never the manager.
  if (select count(*) from public.notifications where farm_id = '5a000000-0000-4000-9000-00000000000a' and template = 'storage_full') <> 1
     or exists (select 1 from public.notifications where template = 'storage_full' and user_id <> '5a100000-0000-4000-9000-000000000001') then
    raise exception 'STORAGE FAIL [25]: the full notice went to the wrong people or more than once';
  end if;
  -- Automatic blocks are off by default: nothing was bought.
  if (select storage_blocks from public.billing_subscriptions where id = '5a600000-0000-4000-9000-00000000000a') <> 0
     or exists (select 1 from public.storage_charges) then
    raise exception 'STORAGE FAIL [26]: a block was bought without the owner switching it on';
  end if;
end $t$;

-- An unrelated business is not affected by the customer's full pool; warnings at 80% and 95%.
-- Its owner cannot raise a "full" alarm while the pool is nearly empty.
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$ begin
  if public.storage_note_full('5a000000-0000-4000-9000-00000000000c') then
    raise exception 'STORAGE FAIL [25]: a full notice for a pool that is not full';
  end if;
end $t$;
reset role;
select pg_temp.stored('5a000000-0000-4000-9000-00000000000c', '5a100000-0000-4000-9000-000000000003',
                      '5a200000-0000-4000-9000-00000000000c', 1590000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$
declare v text;
begin
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 15000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [3]: an unrelated business was stopped: %', v; end if;
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 1000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [25]: %', v; end if;
end $t$;
reset role;
do $t$
begin
  if (select count(*) from public.notifications where farm_id = '5a000000-0000-4000-9000-00000000000c'
        and template = 'storage_warning' and (payload ->> 'percent')::int = 80) <> 1 then
    raise exception 'STORAGE FAIL [25]: the 80%% warning was not sent exactly once';
  end if;
end $t$;
select pg_temp.stored('5a000000-0000-4000-9000-00000000000c', '5a100000-0000-4000-9000-000000000003',
                      '5a200000-0000-4000-9000-00000000000c', 300000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
select pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 1000000);
select pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 1000000);
reset role;
do $t$
begin
  if (select count(*) from public.notifications where farm_id = '5a000000-0000-4000-9000-00000000000c'
        and template = 'storage_warning' and (payload ->> 'percent')::int = 95) <> 1
     or (select count(*) from public.notifications where farm_id = '5a000000-0000-4000-9000-00000000000c'
        and template = 'storage_warning') <> 2 then
    raise exception 'STORAGE FAIL [25]: the 95%% warning was not sent exactly once';
  end if;
end $t$;

-- == 26: automatic blocks ===================================================================
select pg_temp.as_user('5a100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$ begin
  -- A manager cannot switch on purchases.
  perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000a', true, 9800, 'storage-auto-2026-11');
  raise exception 'STORAGE FAIL [26]: a manager switched on automatic purchases';
exception when insufficient_privilege then null;
end $t$;
reset role;
select pg_temp.as_user('5a100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v text;
begin
  -- A ceiling that could never allow a block, and no accepted terms, are refused.
  begin
    perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000a', true, 4800, 'storage-auto-2026-11');
    raise exception 'STORAGE FAIL [26]: a R48 ceiling was accepted';
  exception when sqlstate '22023' then
    if sqlerrm <> 'storage-ceiling-too-low' then raise; end if;
  end;
  begin
    perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000a', true, 9800, null);
    raise exception 'STORAGE FAIL [26]: automatic purchases without accepted terms';
  exception when sqlstate '22023' then
    if sqlerrm <> 'storage-terms-required' then raise; end if;
  end;
  -- R98: at most two R49 blocks in total.
  perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000a', true, 9800, 'storage-auto-2026-11');

  -- Full pool, so the next photo buys the first block, from the NORTH depot's driver too.
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000a', '5a200000-0000-4000-9000-00000000000a', 5000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [26]: the first automatic block was not bought: %', v; end if;
  -- The next uploads find the room the block made: no second block.
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000a', '5a200000-0000-4000-9000-00000000000a', 5000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [26]: %', v; end if;
end $t$;
reset role;
do $t$
declare c public.storage_charges;
begin
  if (select storage_blocks from public.billing_subscriptions where id = '5a600000-0000-4000-9000-00000000000a') <> 1
     or (select count(*) from public.storage_charges) <> 1 then
    raise exception 'STORAGE FAIL [26]: demand after a purchase bought again (% blocks, % charges)',
      (select storage_blocks from public.billing_subscriptions where id = '5a600000-0000-4000-9000-00000000000a'),
      (select count(*) from public.storage_charges);
  end if;
  select * into c from public.storage_charges limit 1;
  -- Pro rata for the rest of the storage month (today to the period end, 20 of 30 days).
  if c.kind <> 'auto_block' or c.blocks <> 1 or c.unit_incl_cents <> 4900 or c.days_charged <> 20
     or c.days_in_period <> 30 or c.amount_incl_cents <> round(4900 * 20 / 30.0) or c.invoice_id is not null then
    raise exception 'STORAGE FAIL [26]: the automatic block''s charge is wrong: %', to_jsonb(c);
  end if;
  if (app.storage_allowance('5a000000-0000-4000-9000-00000000000a') ->> 'total_bytes')::bigint <> 12000000000 then
    raise exception 'STORAGE FAIL [26]: the block did not add 10 GB';
  end if;
  if (select count(*) from public.notifications where template = 'storage_block_added') <> 1 then
    raise exception 'STORAGE FAIL [26]: the owner was not told about the block';
  end if;
end $t$;

-- Fill the second 10 GB: the second block is bought; then the ceiling stops a third.
select pg_temp.stored('5a000000-0000-4000-9000-00000000000a', '5a100000-0000-4000-9000-000000000001',
                      '5a200000-0000-4000-9000-00000000000a', 9990000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$
declare v text;
begin
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000b', '5a200000-0000-4000-9000-00000000000b', 5000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [26]: the second block was not bought: %', v; end if;
end $t$;
reset role;
select pg_temp.stored('5a000000-0000-4000-9000-00000000000a', '5a100000-0000-4000-9000-000000000001',
                      '5a200000-0000-4000-9000-00000000000a', 9999000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$
declare v text;
begin
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000b', '5a200000-0000-4000-9000-00000000000b', 5000000);
  if v <> 'upload:storage_full' then raise exception 'STORAGE FAIL [26]: a third block passed the R98 ceiling: %', v; end if;
end $t$;
reset role;
do $t$
begin
  if (select storage_blocks from public.billing_subscriptions where id = '5a600000-0000-4000-9000-00000000000a') <> 2
     or (select count(*) from public.storage_charges where kind = 'auto_block') <> 2 then
    raise exception 'STORAGE FAIL [26]: R98 did not mean two blocks in total';
  end if;
end $t$;

-- Existing blocks count toward the ceiling: one block bought by hand, R98 allows one more.
update public.billing_subscriptions set storage_blocks = 1 where id = '5a600000-0000-4000-9000-00000000000c';
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$
declare v text;
begin
  -- R98 counts the R49 already held, so it leaves room for one; R49 would leave none.
  begin
    perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000c', true, 4900, 'storage-auto-2026-11');
    raise exception 'STORAGE FAIL [26]: a ceiling equal to the blocks held was accepted';
  exception when sqlstate '22023' then null;
  end;
  perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000c', true, 9800, 'storage-auto-2026-11');
end $t$;
reset role;
select pg_temp.stored('5a000000-0000-4000-9000-00000000000c', '5a100000-0000-4000-9000-000000000003',
                      '5a200000-0000-4000-9000-00000000000c', 10200000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$
declare v text;
begin
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 1000000);
  if v <> 'ok' then raise exception 'STORAGE FAIL [26]: the one block the ceiling allows was not bought: %', v; end if;
end $t$;
reset role;
select pg_temp.stored('5a000000-0000-4000-9000-00000000000c', '5a100000-0000-4000-9000-000000000003',
                      '5a200000-0000-4000-9000-00000000000c', 10000000000);
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$
declare v text;
begin
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 1000000);
  if v <> 'upload:storage_full' then raise exception 'STORAGE FAIL [26]: a block past the ceiling counting held blocks: %', v; end if;
end $t$;
reset role;
do $t$ begin
  if (select storage_blocks from public.billing_subscriptions where id = '5a600000-0000-4000-9000-00000000000c') <> 2 then
    raise exception 'STORAGE FAIL [26]: existing blocks did not count toward the ceiling';
  end if;
end $t$;

-- Switched off again, with room left under the old ceiling: nothing more is bought.
select pg_temp.as_user('5a100000-0000-4000-9000-000000000003');
set local role authenticated;
do $t$
declare v text;
begin
  perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000c', true, 50000, 'storage-auto-2026-11');
  perform public.storage_set_auto('5a000000-0000-4000-9000-00000000000c', false, null, null);
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000c', '5a200000-0000-4000-9000-00000000000c', 1000000);
  if v <> 'upload:storage_full' then raise exception 'STORAGE FAIL [26]: a block was bought with automatic purchases off: %', v; end if;
end $t$;
reset role;

-- Never in the grace: a declined renewal, automatic purchases on, a full pool: refused, no block.
insert into public.storage_pool_settings (farm_id, auto_blocks, auto_ceiling_cents, auto_accepted_at, auto_terms_version)
values ('5a000000-0000-4000-9000-00000000000f', true, 50000, now(), 'storage-auto-2026-11');
select pg_temp.stored('5a000000-0000-4000-9000-00000000000f', '5a100000-0000-4000-9000-000000000005',
                      '5a200000-0000-4000-9000-00000000000f', 1999999000);
-- An invoice two days past its due date: the subscription is still active, the grace has begun.
do $t$
declare v uuid;
begin
  insert into public.billing_invoices (farm_id, subscription_id, invoice_ref, status, kind, period_start, period_end,
    issued_on, due_on, plan, billing_period, asset_count, unit_price_incl_cents, months_charged, price_version_label, vat_rate_bps)
  values ('5a000000-0000-4000-9000-00000000000f', '5a600000-0000-4000-9000-00000000000f', 'STOR-GRACE-1', 'draft', 'period',
          current_date - 2, current_date + 27, current_date - 2, current_date - 2, 'complete', 'monthly', 5, 9900, 1,
          'launch-2026-11-eq', 0)
  returning id into v;
  update public.billing_invoices set status = 'open' where id = v;
  if not app.farm_payment_late('5a000000-0000-4000-9000-00000000000f', app.billing_today()) then
    raise exception 'STORAGE FAIL [26]: the fixture is not in its grace';
  end if;
end $t$;
do $t$
declare v text;
begin
  perform pg_temp.nobody();
  -- The farm stays writable in the grace (ordinary records go on), but nothing that costs money.
  perform pg_temp.as_user('5a100000-0000-4000-9000-000000000005');
  set local role authenticated;
  v := pg_temp.begin_upload('5a000000-0000-4000-9000-00000000000f', '5a200000-0000-4000-9000-00000000000f', 5000000);
  reset role;
  if v <> 'upload:storage_full' then raise exception 'STORAGE FAIL [26]: an automatic block in the grace: %', v; end if;
  if (select storage_blocks from public.billing_subscriptions where id = '5a600000-0000-4000-9000-00000000000f') <> 0 then
    raise exception 'STORAGE FAIL [26]: a block was bought in the grace';
  end if;
end $t$;

-- Structural: the reserve takes the pool lock before it counts or buys.
do $t$
declare src text := (select prosrc from pg_proc where oid = 'app.storage_pool_reserve(uuid,bigint,uuid)'::regprocedure);
begin
  if position('pg_advisory_xact_lock' in src) = 0
     or position('pg_advisory_xact_lock' in src) > position('storage_pool_usage' in src)
     or position('pg_advisory_xact_lock' in src) > position('storage_auto_block' in src) then
    raise exception 'STORAGE FAIL [26]: the pool lock is not taken first';
  end if;
  if position('for update' in (select prosrc from pg_proc where oid = 'app.storage_auto_block(uuid,bigint,date)'::regprocedure)) = 0 then
    raise exception 'STORAGE FAIL [26]: an automatic block does not lock the subscription';
  end if;
end $t$;

-- == Files from before the pipeline =========================================================
do $t$ begin
  if to_regclass('storage.objects') is null then
    create schema if not exists storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);
  end if;
end $t$;
insert into storage.objects (bucket_id, name, metadata) values
  -- An old photo of the Twenty farm, uploaded before the pipeline: counts.
  ('machine-photos', '5a000000-0000-4000-9000-00000000000d/old/photo-1.jpg', '{"size": 500000000}'),
  ('fault-photos',   '5a000000-0000-4000-9000-00000000000d/old/photo-2.jpg', '{"size": 250000000}'),
  -- Temporary command audio and a contractor's document in its folder: never counted.
  ('command-audio',  '5a000000-0000-4000-9000-00000000000d/cmd/audio.webm', '{"size": 900000000}'),
  ('partner-docs',   '5a000000-0000-4000-9000-00000000000d/doc/quote.pdf',  '{"size": 900000000}');
-- A pipeline file of the same farm, also in Storage: counted once, through its intent.
do $t$
declare f uuid := pg_temp.stored('5a000000-0000-4000-9000-00000000000d', '5a100000-0000-4000-9000-000000000001',
                                 '5a200000-0000-4000-9000-00000000000a', 100000000);
begin
  insert into storage.objects (bucket_id, name, metadata)
  select bucket, object_path, '{"size": 100000000}' from public.upload_intents where id = f;
end $t$;
do $t$
declare r jsonb; s public.storage_usage_snapshots;
begin
  if app.storage_pool_usage(array['5a000000-0000-4000-9000-00000000000d']::uuid[]) <> 100000000 then
    raise exception 'STORAGE FAIL [24]: untracked files counted before they were measured';
  end if;
  if public.cron_storage_measure(500) < 5 then
    raise exception 'STORAGE FAIL [24]: the nightly measure skipped pools';
  end if;
  select * into s from public.storage_usage_snapshots
   where farm_id = '5a000000-0000-4000-9000-00000000000d' and measured_on = app.billing_today();
  if s.untracked_bytes <> 750000000 or s.untracked_objects <> 2 or s.tracked_bytes <> 100000000
     or s.allowance_bytes <> 2375000000 or (s.by_bucket ->> 'machine-photos')::bigint <> 500000000
     or s.by_bucket ? 'command-audio' or s.by_bucket ? 'partner-docs' then
    raise exception 'STORAGE FAIL [24]: the measure is wrong: %', to_jsonb(s);
  end if;
  if app.storage_pool_usage(array['5a000000-0000-4000-9000-00000000000d']::uuid[]) <> 850000000 then
    raise exception 'STORAGE FAIL [24]: files from before the pipeline do not count against the pool';
  end if;
  -- The other site of a customer gets its own row, filed under the billing site's pool.
  if not exists (select 1 from public.storage_usage_snapshots
                  where farm_id = '5a000000-0000-4000-9000-00000000000b' and root_farm_id = '5a000000-0000-4000-9000-00000000000a'
                    and allowance_bytes is null) then
    raise exception 'STORAGE FAIL [24]: a pooled site was not measured under its billing site';
  end if;
  -- Measuring twice on one day keeps one row.
  perform app.storage_measure('5a000000-0000-4000-9000-00000000000d');
  if (select count(*) from public.storage_usage_snapshots where farm_id = '5a000000-0000-4000-9000-00000000000d') <> 1 then
    raise exception 'STORAGE FAIL [24]: a second measure made a second row';
  end if;
end $t$;

-- == Who reads what =========================================================================
select pg_temp.as_user('5a100000-0000-4000-9000-000000000002');
set local role authenticated;
do $t$
declare v jsonb;
begin
  -- A manager sees how full it is, never the money.
  v := public.storage_pool_status('5a000000-0000-4000-9000-00000000000a');
  if (v ->> 'total_bytes')::bigint <> 22000000000 or v -> 'money' <> 'null'::jsonb or (v ->> 'payer')::boolean then
    raise exception 'STORAGE FAIL [read]: the manager''s view is wrong: %', v;
  end if;
  if exists (select 1 from public.storage_charges) or exists (select 1 from public.storage_pool_settings) then
    raise exception 'STORAGE FAIL [read]: a manager read storage charges or settings';
  end if;
end $t$;
reset role;
select pg_temp.as_user('5a100000-0000-4000-9000-000000000004');
set local role authenticated;
do $t$
declare v jsonb := public.storage_pool_status('5a000000-0000-4000-9000-00000000000b');
begin
  -- A driver at the North depot reads the shared pool.
  if (v ->> 'total_bytes')::bigint <> 22000000000 or v ->> 'level' not in ('80', '95', 'full') then
    raise exception 'STORAGE FAIL [read]: the North driver''s view is wrong: %', v;
  end if;
end $t$;
reset role;
select pg_temp.as_user('5a100000-0000-4000-9000-000000000001');
set local role authenticated;
do $t$
declare v jsonb := public.storage_pool_status('5a000000-0000-4000-9000-00000000000a');
begin
  if (v #>> '{money,block_monthly_cents}')::bigint <> 4900 or (v #>> '{money,monthly_cents}')::bigint <> 9800
     or not (v #>> '{money,auto_blocks}')::boolean or (v #>> '{money,auto_ceiling_cents}')::bigint <> 9800 then
    raise exception 'STORAGE FAIL [read]: the owner''s view is wrong: %', v;
  end if;
  if (select count(*) from public.storage_charges) <> 2 then
    raise exception 'STORAGE FAIL [read]: the owner cannot read the storage charges';
  end if;
  -- Somebody else's business: refused.
  begin
    perform public.storage_pool_status('5a000000-0000-4000-9000-00000000000c');
    raise exception 'STORAGE FAIL [read]: an owner read another business''s storage';
  exception when insufficient_privilege then null;
  end;
end $t$;
reset role;

-- A storage charge is a money record.
do $t$ begin
  begin
    update public.storage_charges set amount_incl_cents = 1;
    raise exception 'STORAGE FAIL [money]: a storage charge was changed';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.storage_charges;
    raise exception 'STORAGE FAIL [money]: a storage charge was deleted';
  exception when insufficient_privilege then null;
  end;
end $t$;

rollback;
