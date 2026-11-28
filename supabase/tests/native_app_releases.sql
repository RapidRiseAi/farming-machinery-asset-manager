-- The FLEETWISE app's update policy (20261128100000): one row per platform, starting where no
-- phone is asked anything; only the service key reads or sets it; only a named Rapid Rise admin
-- sets it; versions are three whole numbers with the minimum never above the latest; the link is
-- https with no credentials in it.
\set ON_ERROR_STOP on
set client_min_messages to warning;
begin;

insert into public.farms (id, name, plan, status) values
  ('f7000000-0000-4000-9000-000000000001', 'App versions', 'complete', 'active');
insert into auth.users (id, email) values
  ('f7100000-0000-4000-9000-000000000001', 'app.owner@example.invalid'),
  ('f7100000-0000-4000-9000-000000000009', 'app.rr@example.invalid');
insert into public.users (id, farm_id, role, name, email, active) values
  ('f7100000-0000-4000-9000-000000000001', 'f7000000-0000-4000-9000-000000000001', 'owner', 'App Owner', 'app.owner@example.invalid', true),
  ('f7100000-0000-4000-9000-000000000009', null, 'rr_admin', 'App RR', 'app.rr@example.invalid', true);

do $t$
declare v jsonb; refused boolean;
begin
  -- Nobody but the service key reaches the row or the functions.
  if has_table_privilege('anon', 'app.native_app_releases', 'SELECT')
     or has_table_privilege('authenticated', 'app.native_app_releases', 'SELECT') then
    raise exception 'the release row must not be readable with a person''s key';
  end if;
  if has_function_privilege('anon', 'public.native_app_release(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.native_app_release(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.native_app_release_set(uuid,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.native_app_release_set(uuid,text,text,text,text)', 'EXECUTE') then
    raise exception 'the release functions are for the service key only';
  end if;

  -- The starting row asks nobody to update: every app built before 28 Nov 2026 is 1.0.0.
  v := public.native_app_release('android');
  if v->>'latest' <> '1.0.0' or v->>'minimum' <> '1.0.0' or v->>'url' not like 'https://play.google.com/%' then
    raise exception 'unexpected starting row %', v;
  end if;
  if public.native_app_release('ios') is not null then raise exception 'there is no iPhone app'; end if;

  -- A business owner is not Rapid Rise.
  refused := false;
  begin
    perform public.native_app_release_set('f7100000-0000-4000-9000-000000000001', 'android', '1.1.0', '1.0.0',
      'https://play.google.com/store/apps/details?id=za.co.fleetwise.app');
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'an owner set the app versions'; end if;

  -- Rapid Rise sets them.
  perform public.native_app_release_set('f7100000-0000-4000-9000-000000000009', 'android', ' 1.1.0 ', '1.0.0',
    'https://example.com/fleetwise/app.apk');
  v := public.native_app_release('android');
  if v->>'latest' <> '1.1.0' or v->>'minimum' <> '1.0.0' or v->>'url' <> 'https://example.com/fleetwise/app.apk' then
    raise exception 'the change did not land: %', v;
  end if;
  if (select updated_by from app.native_app_releases where platform = 'android') <> 'f7100000-0000-4000-9000-000000000009' then
    raise exception 'who changed it is not recorded';
  end if;
end $t$;

-- Each of these is refused with the one code the admin page explains, and changes nothing.
do $t$
declare
  bad record;
  refused boolean;
begin
  for bad in
    select * from (values
      ('1.1', '1.0.0', 'https://example.com/a.apk', 'two numbers'),
      ('1.1.0', '1.2.0', 'https://example.com/a.apk', 'minimum above latest'),
      ('1.10.0', '1.9.0', 'https://example.com/a.apk', 'fine: compared as numbers, kept as the last good change'),
      ('1.100.0', '1.0.0', 'https://example.com/a.apk', 'minor of 100'),
      ('01.1.0', '1.0.0', 'https://example.com/a.apk', 'leading zero'),
      ('1.1.0', '1.0.0', 'http://example.com/a.apk', 'not https'),
      ('1.1.0', '1.0.0', 'https://user:pw@example.com/a.apk', 'credentials in the link'),
      ('1.1.0', '1.0.0', 'https://exa mple.com/a.apk', 'a space'),
      ('1.1.0', '1.0.0', 'javascript:alert(1)', 'not a link')
    ) as t(latest, minimum, url, why)
  loop
    refused := false;
    begin
      perform public.native_app_release_set('f7100000-0000-4000-9000-000000000009', 'android', bad.latest, bad.minimum, bad.url);
    exception when sqlstate '22023' then
      if sqlerrm <> 'app-version-invalid' then raise exception '% refused as %', bad.why, sqlerrm; end if;
      refused := true;
    end;
    if bad.why like 'fine:%' then
      if refused then raise exception '1.10.0 over 1.9.0 is a valid pair'; end if;
    elsif not refused then
      raise exception 'accepted: %', bad.why;
    end if;
  end loop;

  if (select latest_version || '/' || minimum_version from app.native_app_releases where platform = 'android') <> '1.10.0/1.9.0' then
    raise exception 'a refused change altered the row';
  end if;

  refused := false;
  begin
    perform public.native_app_release_set('f7100000-0000-4000-9000-000000000009', 'ios', '1.1.0', '1.0.0', 'https://example.com/');
  exception when sqlstate '22023' then refused := true;
  end;
  if not refused then raise exception 'a platform with no row was accepted'; end if;
end $t$;

rollback;
