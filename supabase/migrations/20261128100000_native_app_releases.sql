-- 20261128100000_native_app_releases.sql
-- Which FLEETWISE Android app phones are asked, or made, to update to (28 Nov 2026).
--
-- The app is a shell around the live site: every screen comes from the server, so a web change
-- reaches every phone on its next open and needs no update. The shell itself (its plugins and
-- Android settings) is versioned in native/version.json. Rapid Rise keeps one row per platform:
--
--   latest_version   an app older than this is asked to update each time it is opened, and may
--                    say "Not now";
--   minimum_version  an app older than this must update before anything else is usable. Raised
--                    only when the site needs something older shells do not have;
--   update_url       where "Update now" goes: the Play Store listing, or a download page.
--
-- The site asks /api/public/app-version on each open (service key, public.native_app_release);
-- /admin/app-version changes the row (public.native_app_release_set, Rapid Rise staff only, the
-- database checking the person again). Every app built before today says 1.0.0, so the row starts
-- at 1.0.0 for both and nobody is asked anything until a newer app has been published.
--
-- Additive: one new table, two new service-only functions. Nothing that exists is changed.

create table if not exists app.native_app_releases (
  platform        text primary key check (platform = 'android'),
  latest_version  text not null,
  minimum_version text not null,
  update_url      text not null,
  updated_by      uuid references public.users(id) on delete set null,
  updated_at      timestamptz not null default now(),
  -- Three whole numbers (minor and patch under 100, the build-number rule), the minimum never
  -- above the latest. CASE so the numeric comparison only ever sees text that is a version.
  constraint native_app_releases_versions check (
    case
      when latest_version ~ '^[1-9][0-9]{0,4}\.[0-9]{1,2}\.[0-9]{1,2}$'
       and minimum_version ~ '^[1-9][0-9]{0,4}\.[0-9]{1,2}\.[0-9]{1,2}$'
      then string_to_array(minimum_version, '.')::int[] <= string_to_array(latest_version, '.')::int[]
      else false
    end),
  -- An https link with a host and no credentials in it, as the app checks again before opening it.
  constraint native_app_releases_url check (
    length(update_url) <= 2000 and update_url ~ '^https://[^\s/@:]+(:[0-9]+)?(/[^\s]*)?$')
);

insert into app.native_app_releases (platform, latest_version, minimum_version, update_url)
values ('android', '1.0.0', '1.0.0', 'https://play.google.com/store/apps/details?id=za.co.fleetwise.app')
on conflict (platform) do nothing;

alter table app.native_app_releases enable row level security;
alter table app.native_app_releases force row level security;
revoke all on app.native_app_releases from public, anon, authenticated, service_role;
comment on table app.native_app_releases is
  'The newest and the oldest allowed FLEETWISE app per platform, and where updates come from (20261128100000).';

-- What a phone is told. Nothing in it is private: the same answer goes to everyone.
create or replace function public.native_app_release(p_platform text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
           'latest', r.latest_version, 'minimum', r.minimum_version, 'url', r.update_url,
           'updated_at', r.updated_at)
    from app.native_app_releases r
   where r.platform = p_platform;
$$;

-- Rapid Rise sets the versions. The server action checks the role first; this checks again.
create or replace function public.native_app_release_set(
  p_by uuid, p_platform text, p_latest text, p_minimum text, p_url text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.service_rr_actor(p_by) then raise exception 'forbidden' using errcode = '42501'; end if;
  begin
    update app.native_app_releases
       set latest_version = btrim(p_latest), minimum_version = btrim(p_minimum),
           update_url = btrim(p_url), updated_by = p_by, updated_at = now()
     where platform = p_platform;
  exception when check_violation or not_null_violation then
    raise exception 'app-version-invalid' using errcode = '22023';
  end;
  if not found then raise exception 'app-version-invalid' using errcode = '22023'; end if;
end $$;

do $$
declare f regprocedure;
begin
  foreach f in array array[
    'public.native_app_release(text)'::regprocedure,
    'public.native_app_release_set(uuid,text,text,text,text)'::regprocedure]
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
