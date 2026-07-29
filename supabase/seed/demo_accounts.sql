-- demo_accounts.sql — LOGINABLE demo accounts for every role + every contractor type.
--
-- WHY THIS FILE EXISTS
--   `demo_farm.sql` seeds the Weltevrede demo farm (12 machines, one TJ mechanic
--   contractor, partners, work requests) but it inserts `auth.users` rows with only
--   (id, email) — no password — so those accounts cannot actually LOG IN on a hosted
--   Supabase project (GoTrue needs an encrypted password + a confirmed email + an
--   identity row). This file:
--     1. Turns every existing demo user into a real, password-loginable account.
--     2. Adds one loginable CONTRACTOR account per `contractor_kind`
--        (auto_electrician, parts_supplier, panel_beater, tyre, towing, other) on top
--        of the existing TJ 'mechanic'.
--     3. Adds a PLATFORM (RR) admin account.
--     4. Adds a SECOND farm (Rooikoppies Plaas) + a shared contractor + a multi-site
--        membership, so you can test cross-farm contractor aggregation (F12c) and the
--        site switcher (F7).
--     5. Wires partners, workshop_links and work_requests for the new cast.
--
-- HOSTED SUPABASE ONLY. Run it in the Supabase SQL editor (or psql with the service
--   role) AFTER (a) all migrations 0001–0371 are applied and (b) `demo_farm.sql` has
--   run. It will NOT work against the local test shim (that auth.users has no password
--   columns and there is no GoTrue to authenticate against).
--
-- EVERY password below is:  FleetWise!demo1
--
-- Idempotent: re-running resets the demo passwords and re-links everything; it never
--   duplicates rows. Safe to run repeatedly.

create extension if not exists pgcrypto;

-- ── Helper: upsert a password-loginable auth user + its email identity ──────────
create or replace function public._demo_auth_user(p_id uuid, p_email text, p_password text, p_name text)
returns void language plpgsql as $fn$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    created_at, updated_at, raw_app_meta_data, raw_user_meta_data
  ) values (
    '00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', lower(p_email),
    crypt(p_password, gen_salt('bf')), now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', p_name)
  )
  on conflict (id) do update set
    -- GoTrue rejects a login row unless aud='authenticated' and the timestamp/token
    -- columns are non-null. demo_farm.sql pre-creates these rows with only (id,email),
    -- so this upsert must (re)assert every column GoTrue scans — otherwise the account
    -- exists but cannot log in ("Database error querying schema" / "invalid credentials").
    aud                        = 'authenticated',
    role                       = 'authenticated',
    instance_id                = coalesce(auth.users.instance_id, '00000000-0000-0000-0000-000000000000'),
    email                      = excluded.email,
    encrypted_password         = excluded.encrypted_password,
    email_confirmed_at         = coalesce(auth.users.email_confirmed_at, now()),
    created_at                 = coalesce(auth.users.created_at, now()),
    raw_app_meta_data          = coalesce(auth.users.raw_app_meta_data, '{"provider":"email","providers":["email"]}'::jsonb),
    raw_user_meta_data         = excluded.raw_user_meta_data,
    confirmation_token         = coalesce(auth.users.confirmation_token, ''),
    recovery_token             = coalesce(auth.users.recovery_token, ''),
    email_change               = coalesce(auth.users.email_change, ''),
    email_change_token_new     = coalesce(auth.users.email_change_token_new, ''),
    email_change_token_current = coalesce(auth.users.email_change_token_current, ''),
    phone_change               = coalesce(auth.users.phone_change, ''),
    phone_change_token         = coalesce(auth.users.phone_change_token, ''),
    reauthentication_token     = coalesce(auth.users.reauthentication_token, ''),
    updated_at                 = now();

  -- GoTrue needs an 'email' identity carrying { sub, email } to allow password login.
  if not exists (select 1 from auth.identities where user_id = p_id and provider = 'email') then
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), p_id, p_id::text,
            jsonb_build_object('sub', p_id::text, 'email', lower(p_email)), 'email', now(), now(), now());
  end if;
end $fn$;

do $seed$
declare
  pw text := 'FleetWise!demo1';

  -- Existing Weltevrede farm + people (from demo_farm.sql).
  v_farm     uuid := 'aa000000-0000-0000-0000-000000000001';
  v_workshop uuid := 'bb000000-0000-0000-0000-000000000001';   -- TJ (mechanic)
  v_owner    uuid := '10000000-0000-0000-0000-000000000001';   -- danie@weltevrede.example
  v_manager  uuid := '10000000-0000-0000-0000-000000000002';   -- piet@weltevrede.example
  v_mech     uuid := '10000000-0000-0000-0000-000000000003';   -- johan@weltevrede.example
  v_op1      uuid := '10000000-0000-0000-0000-000000000004';   -- thabo@weltevrede.example
  v_op2      uuid := '10000000-0000-0000-0000-000000000005';   -- sipho@weltevrede.example
  v_wstaff   uuid := '10000000-0000-0000-0000-000000000006';   -- tj@tjservice.example

  -- Platform admin.
  v_admin    uuid := '10000000-0000-0000-0000-000000000099';

  -- Second farm + its owner.
  v_farm2    uuid := 'aa000000-0000-0000-0000-000000000002';   -- Rooikoppies Plaas
  v_owner2   uuid := '10000000-0000-0000-0000-000000000021';   -- hendrik@rooikoppies.example
begin
  if not exists (select 1 from farms where id = v_farm) then
    raise exception 'Run demo_farm.sql first — Weltevrede demo farm not found.';
  end if;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 1) Make the EXISTING Weltevrede accounts loginable + a platform admin.
  -- ════════════════════════════════════════════════════════════════════════════
  perform public._demo_auth_user(v_owner,   'danie@weltevrede.example', pw, 'Oom Danie');
  perform public._demo_auth_user(v_manager, 'piet@weltevrede.example',  pw, 'Piet Botha');
  perform public._demo_auth_user(v_mech,    'johan@weltevrede.example', pw, 'Johan');
  perform public._demo_auth_user(v_op1,     'thabo@weltevrede.example', pw, 'Thabo');
  perform public._demo_auth_user(v_op2,     'sipho@weltevrede.example', pw, 'Sipho');
  perform public._demo_auth_user(v_wstaff,  'tj@tjservice.example',     pw, 'TJ');

  -- Keep the profile email column in step with the login email (nice for the UI).
  update users set email = 'danie@weltevrede.example' where id = v_owner   and email is distinct from 'danie@weltevrede.example';
  update users set email = 'piet@weltevrede.example'  where id = v_manager and email is distinct from 'piet@weltevrede.example';
  update users set email = 'johan@weltevrede.example' where id = v_mech    and email is distinct from 'johan@weltevrede.example';
  update users set email = 'thabo@weltevrede.example' where id = v_op1     and email is distinct from 'thabo@weltevrede.example';
  update users set email = 'sipho@weltevrede.example' where id = v_op2     and email is distinct from 'sipho@weltevrede.example';
  update users set email = 'tj@tjservice.example'     where id = v_wstaff  and email is distinct from 'tj@tjservice.example';

  -- Platform (RapidRise) admin — cross-tenant console, no farm/workshop.
  perform public._demo_auth_user(v_admin, 'admin@fleetwise.dev', pw, 'RapidRise Admin');
  insert into users (id, farm_id, workshop_id, role, name, email, language, active)
  values (v_admin, null, null, 'rr_admin', 'RapidRise Admin', 'admin@fleetwise.dev', 'en', true)
  on conflict (id) do update set role = 'rr_admin', active = true, email = excluded.email;

  -- Assign an operator to a machine so per-role visibility (F7) has something to show:
  -- Thabo (operator) should see ONLY the Groen John Deere.
  update machines set assigned_operator_id = v_op1
   where id = '20000000-0000-0000-0000-000000000001' and farm_id = v_farm
     and assigned_operator_id is distinct from v_op1;

  -- Classify + upgrade the existing TJ workshop (mechanic, pro plan).
  update workshops set kind = 'mechanic', plan = 'pro' where id = v_workshop;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 2) One loginable CONTRACTOR per remaining contractor_kind.
  --    Each = workshop (classified) + active link to Weltevrede + workshop-role user
  --    + a connected partner-directory row on Weltevrede.
  -- ════════════════════════════════════════════════════════════════════════════
  -- Workshops.
  insert into workshops (id, name, contact, kind, plan, phone, whatsapp, email, area) values
    ('bb000000-0000-0000-0000-000000000002', 'Volt Auto Electric',       'Riaan — 082 555 0202', 'auto_electrician', 'free', '+27825550202', '+27825550202', 'sparky@voltauto.example',   'Bothaville'),
    ('bb000000-0000-0000-0000-000000000003', 'AgriParts Wholesale Depot','Sales desk',            'parts_supplier',   'pro',  '+27825550303', '+27825550303', 'sales@agripartsdepot.example','Welkom'),
    ('bb000000-0000-0000-0000-000000000004', 'Panelworx Bodyshop',       'Deon — 082 555 0404',  'panel_beater',     'free', '+27825550404', '+27825550404', 'info@panelworx.example',    'Klerksdorp'),
    ('bb000000-0000-0000-0000-000000000005', 'Karoo Tyre & Fitment',     'Fitment centre',        'tyre',             'free', '+27825550505', '+27825550505', 'fitment@karootyre.example', 'Bothaville'),
    ('bb000000-0000-0000-0000-000000000006', 'Boland Towing & Recovery', '24/7 dispatch',         'towing',           'pro',  '+27825550606', '+27825550606', 'dispatch@bolandtow.example','N1 corridor'),
    ('bb000000-0000-0000-0000-000000000007', 'Doall Handyman Services',  'Sam — 082 555 0707',   'other',            'free', '+27825550707', '+27825550707', 'general@doall.example',     'Bothaville')
  on conflict (id) do update set kind = excluded.kind, plan = excluded.plan, phone = excluded.phone,
    whatsapp = excluded.whatsapp, email = excluded.email, area = excluded.area, contact = excluded.contact;

  -- Workshop-role login users.
  perform public._demo_auth_user('10000000-0000-0000-0000-000000000012', 'sparky@voltauto.example',      pw, 'Riaan (Volt)');
  perform public._demo_auth_user('10000000-0000-0000-0000-000000000013', 'sales@agripartsdepot.example', pw, 'AgriParts Sales');
  perform public._demo_auth_user('10000000-0000-0000-0000-000000000014', 'info@panelworx.example',       pw, 'Deon (Panelworx)');
  perform public._demo_auth_user('10000000-0000-0000-0000-000000000015', 'fitment@karootyre.example',    pw, 'Karoo Tyre');
  perform public._demo_auth_user('10000000-0000-0000-0000-000000000016', 'dispatch@bolandtow.example',   pw, 'Boland Towing');
  perform public._demo_auth_user('10000000-0000-0000-0000-000000000017', 'general@doall.example',        pw, 'Sam (Doall)');

  insert into users (id, farm_id, workshop_id, role, name, email, language, active) values
    ('10000000-0000-0000-0000-000000000012', null, 'bb000000-0000-0000-0000-000000000002', 'workshop', 'Riaan (Volt)',    'sparky@voltauto.example',      'en', true),
    ('10000000-0000-0000-0000-000000000013', null, 'bb000000-0000-0000-0000-000000000003', 'workshop', 'AgriParts Sales', 'sales@agripartsdepot.example', 'en', true),
    ('10000000-0000-0000-0000-000000000014', null, 'bb000000-0000-0000-0000-000000000004', 'workshop', 'Deon (Panelworx)','info@panelworx.example',       'en', true),
    ('10000000-0000-0000-0000-000000000015', null, 'bb000000-0000-0000-0000-000000000005', 'workshop', 'Karoo Tyre',      'fitment@karootyre.example',    'en', true),
    ('10000000-0000-0000-0000-000000000016', null, 'bb000000-0000-0000-0000-000000000006', 'workshop', 'Boland Towing',   'dispatch@bolandtow.example',   'en', true),
    ('10000000-0000-0000-0000-000000000017', null, 'bb000000-0000-0000-0000-000000000007', 'workshop', 'Sam (Doall)',     'general@doall.example',        'en', true)
  on conflict (id) do update set workshop_id = excluded.workshop_id, role = 'workshop', active = true, email = excluded.email;

  -- Active links Weltevrede ↔ each new contractor.
  insert into workshop_links (workshop_id, farm_id, status)
  select w, v_farm, 'active'
    from unnest(array[
      'bb000000-0000-0000-0000-000000000002','bb000000-0000-0000-0000-000000000003',
      'bb000000-0000-0000-0000-000000000004','bb000000-0000-0000-0000-000000000005',
      'bb000000-0000-0000-0000-000000000006','bb000000-0000-0000-0000-000000000007']::uuid[]) as w
  where not exists (select 1 from workshop_links l where l.workshop_id = w and l.farm_id = v_farm);

  -- Connected partner-directory rows on Weltevrede (one per new contractor).
  insert into partners (id, farm_id, is_suggested, name, kind, phone, whatsapp, email, area, workshop_id, notes, created_by) values
    ('73000000-0000-0000-0000-000000000002', v_farm, false, 'Volt Auto Electric',        'auto_electrician', '+27825550202','+27825550202','sparky@voltauto.example',      'Bothaville',  'bb000000-0000-0000-0000-000000000002', 'Alternators, starters, wiring — connected', v_owner),
    ('73000000-0000-0000-0000-000000000003', v_farm, false, 'AgriParts Wholesale Depot', 'parts_supplier',   '+27825550303','+27825550303','sales@agripartsdepot.example', 'Welkom',      'bb000000-0000-0000-0000-000000000003', 'Bulk filters/oils/belts — connected',       v_owner),
    ('73000000-0000-0000-0000-000000000004', v_farm, false, 'Panelworx Bodyshop',        'panel_beater',     '+27825550404','+27825550404','info@panelworx.example',       'Klerksdorp',  'bb000000-0000-0000-0000-000000000004', 'Panel + spray — connected',                 v_owner),
    ('73000000-0000-0000-0000-000000000005', v_farm, false, 'Karoo Tyre & Fitment',      'tyre',             '+27825550505','+27825550505','fitment@karootyre.example',    'Bothaville',  'bb000000-0000-0000-0000-000000000005', 'Tractor + bakkie tyres — connected',        v_owner),
    ('73000000-0000-0000-0000-000000000006', v_farm, false, 'Boland Towing & Recovery',  'towing',           '+27825550606','+27825550606','dispatch@bolandtow.example',   'N1 corridor', 'bb000000-0000-0000-0000-000000000006', 'Heavy recovery day/night — connected',      v_owner),
    ('73000000-0000-0000-0000-000000000007', v_farm, false, 'Doall Handyman Services',   'other',            '+27825550707','+27825550707','general@doall.example',        'Bothaville',  'bb000000-0000-0000-0000-000000000007', 'General odd jobs — connected',              v_owner)
  on conflict (id) do update set workshop_id = excluded.workshop_id, phone = excluded.phone, email = excluded.email;

  -- ════════════════════════════════════════════════════════════════════════════
  -- 3) Second farm (Rooikoppies Plaas) for cross-farm aggregation + multi-site.
  -- ════════════════════════════════════════════════════════════════════════════
  insert into farms (id, name, plan, billing_period, status, settings)
  values (v_farm2, 'Rooikoppies Plaas', 'professional', 'monthly', 'active',
          '{"vat_rate_bps":1500,"vat_inclusive_entry":true,"currency":"ZAR","default_language":"en"}'::jsonb)
  on conflict (id) do nothing;

  perform public._demo_auth_user(v_owner2, 'hendrik@rooikoppies.example', pw, 'Hendrik van Zyl');
  insert into users (id, farm_id, workshop_id, role, name, email, language, active)
  values (v_owner2, v_farm2, null, 'owner', 'Hendrik van Zyl', 'hendrik@rooikoppies.example', 'en', true)
  on conflict (id) do update set farm_id = v_farm2, role = 'owner', active = true, email = excluded.email;

  -- Three vehicles on Rooikoppies.
  insert into machines (id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type, status, current_reading, current_reading_date, purchase_date, purchase_price_cents, supplier, location, notes) values
    ('21000000-0000-0000-0000-000000000001', v_farm2, 'Rooikoppies Trekker', 'tractor',   'John Deere', '5075E', 2020, 'JD5075E-R1', null,        'hours', 'active', 2870, current_date - 2, '2020-05-10', 98000000, 'Senwes', 'Werkswinkel', 'Hoof trekker'),
    ('21000000-0000-0000-0000-000000000002', v_farm2, 'Rooikoppies Bakkie',  'bakkie',    'Ford',       'Ranger 2.2', 2019, 'FR-R2', 'CA 222-333','km',    'active', 96500, current_date - 1, '2019-08-01', 42000000, 'Ford', 'Werf', null),
    ('21000000-0000-0000-0000-000000000003', v_farm2, 'Rooikoppies Stroper', 'harvester', 'Case IH',    'Axial 4088', 2016, 'CIH-R3', null,       'hours', 'active', 4210, current_date - 8, '2016-03-15', 260000000, 'Case IH', 'Masjienstoor', null)
  on conflict (id) do nothing;

  insert into meter_readings (farm_id, machine_id, reading, reading_date, source, by_user)
  select v_farm2, m.id, m.current_reading, m.current_reading_date, 'manual', v_owner2
    from machines m
   where m.farm_id = v_farm2 and m.current_reading is not null
     and not exists (select 1 from meter_readings r where r.machine_id = m.id);

  -- Multi-site: give Danie (Weltevrede owner) OWNER access to Rooikoppies too, so the
  -- account shows the site switcher and F7 multi-farm scoping can be tested.
  insert into user_farm_memberships (user_id, farm_id, role, active)
  values (v_owner, v_farm2, 'owner', true)
  on conflict (user_id, farm_id) do update set active = true, role = 'owner';

  -- Share the TJ mechanic with Rooikoppies (cross-farm) → the aggregated contractor
  -- dashboard (F12c) then shows TJ one inbox spanning BOTH farms.
  insert into workshop_links (workshop_id, farm_id, status)
  select v_workshop, v_farm2, 'active'
  where not exists (select 1 from workshop_links l where l.workshop_id = v_workshop and l.farm_id = v_farm2);

  -- ════════════════════════════════════════════════════════════════════════════
  -- 4) Work requests for the new cast (varied kinds + statuses).
  -- ════════════════════════════════════════════════════════════════════════════
  insert into work_requests (id, farm_id, machine_id, workshop_id, kind, status, priority, title, description, quote_amount_cents, vat_rate_bps, created_by) values
    ('74000000-0000-0000-0000-000000000001', v_farm, '20000000-0000-0000-0000-000000000007', 'bb000000-0000-0000-0000-000000000002', 'repair',     'requested',   'normal', 'Alternator laai nie', 'Bakkie battery loop plat — alternator?', null,   1500, v_owner),
    ('74000000-0000-0000-0000-000000000002', v_farm, '20000000-0000-0000-0000-000000000005', 'bb000000-0000-0000-0000-000000000003', 'parts',      'quoted',      'high',   'Snytoerusting onderdele', 'Nuwe snymes + V-snare vir die stroper', 340000, 1500, v_manager),
    ('74000000-0000-0000-0000-000000000003', v_farm, '20000000-0000-0000-0000-000000000008', 'bb000000-0000-0000-0000-000000000005', 'other',      'in_progress', 'normal', '4 nuwe bande',        'Vervang al vier bande op die Isuzu',    null,   1500, v_manager),
    ('74000000-0000-0000-0000-000000000004', v_farm, '20000000-0000-0000-0000-000000000009', 'bb000000-0000-0000-0000-000000000004', 'quote',      'requested',   'low',    'Duik in deur',        'Duik in bestuurderdeur — kwoteer asb',  null,   1500, v_owner),
    ('74000000-0000-0000-0000-000000000005', v_farm2,'21000000-0000-0000-0000-000000000001', 'bb000000-0000-0000-0000-000000000001', 'repair',     'requested',   'high',   'Enjin oorverhit',     'Trekker loop warm — kom kyk asseblief',  null,   1500, v_owner2)
  on conflict (id) do nothing;

  insert into work_request_events (farm_id, work_request_id, from_status, to_status, note, by_user) values
    (v_farm,  '74000000-0000-0000-0000-000000000001', null, 'requested', 'Aangevra by Volt', v_owner),
    (v_farm,  '74000000-0000-0000-0000-000000000002', null, 'requested', 'Aangevra by AgriParts', v_manager),
    (v_farm,  '74000000-0000-0000-0000-000000000002', 'requested', 'quoted', 'Kwotasie ontvang', '10000000-0000-0000-0000-000000000013'),
    (v_farm,  '74000000-0000-0000-0000-000000000003', null, 'requested', 'Aangevra by Karoo Tyre', v_manager),
    (v_farm,  '74000000-0000-0000-0000-000000000003', 'requested', 'in_progress', 'Werk begin', '10000000-0000-0000-0000-000000000015'),
    (v_farm,  '74000000-0000-0000-0000-000000000004', null, 'requested', 'Aangevra by Panelworx', v_owner),
    (v_farm2, '74000000-0000-0000-0000-000000000005', null, 'requested', 'Aangevra by TJ', v_owner2)
  on conflict do nothing;

  raise notice 'demo_accounts: % loginable accounts seeded (password FleetWise!demo1) across 2 farms + 7 contractor types',
    (select count(*) from users where id in (
      v_owner,v_manager,v_mech,v_op1,v_op2,v_wstaff,v_admin,v_owner2,
      '10000000-0000-0000-0000-000000000012','10000000-0000-0000-0000-000000000013',
      '10000000-0000-0000-0000-000000000014','10000000-0000-0000-0000-000000000015',
      '10000000-0000-0000-0000-000000000016','10000000-0000-0000-0000-000000000017'));
end $seed$;

-- Tidy up the helper so it does not linger in the schema.
drop function if exists public._demo_auth_user(uuid, text, text, text);
