-- 20261107120000_map_and_feature_flags.sql
-- Features in testing, and the first of the map (founder decision, 6 November 2026).
--
-- == Feature switches ==========================================================
-- A feature can be tried on chosen businesses before anyone else sees it. Rapid Rise turns it
-- on per business, and releases it to everyone when it has been tested. Only Rapid Rise can do
-- either. Reading a flag tells nobody anything sensitive, so anyone signed in may.
--
-- == Positions =================================================================
-- A point every half minute across a fleet is millions of rows a month, so this is its own
-- lean table: no audit trigger, no per-row workflow, and kept only as long as `retain` below.
-- Where a person was is personal information (docs/POPIA.md), so a driver sees their own
-- trips, and only an owner or manager sees the rest.

create table if not exists public.feature_flags (
  key        text primary key,
  released   boolean not null default false,
  note       text,
  updated_at timestamptz not null default now()
);

create table if not exists public.farm_feature_access (
  farm_id    uuid not null references public.farms(id) on delete cascade,
  key        text not null references public.feature_flags(key) on delete cascade,
  granted_by uuid references public.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (farm_id, key)
);

alter table public.feature_flags enable row level security;
alter table public.feature_flags force row level security;
alter table public.farm_feature_access enable row level security;
alter table public.farm_feature_access force row level security;

create policy feature_flags_sel on public.feature_flags for select to authenticated using (true);
create policy feature_flags_upd on public.feature_flags for update to authenticated
  using (app.is_rr_admin()) with check (app.is_rr_admin());

create policy farm_feature_access_sel on public.farm_feature_access for select to authenticated
  using (app.is_rr_admin() or app.has_farm_access(farm_id));
create policy farm_feature_access_ins on public.farm_feature_access for insert to authenticated
  with check (app.is_rr_admin());
create policy farm_feature_access_del on public.farm_feature_access for delete to authenticated
  using (app.is_rr_admin());

revoke all on public.feature_flags, public.farm_feature_access from public, anon, authenticated;
grant select, update on public.feature_flags to authenticated;
grant select, insert, delete on public.farm_feature_access to authenticated;
grant all on public.feature_flags, public.farm_feature_access to service_role;

create trigger feature_flags_audit after insert or update or delete on public.feature_flags
  for each row execute function public.app_audit();
create trigger farm_feature_access_audit after insert or update or delete on public.farm_feature_access
  for each row execute function public.app_audit();

insert into app.audit_table_rules (table_name, scope, reason) values
  ('feature_flags', 'rapid_rise', 'what Rapid Rise has released to everyone'),
  ('farm_feature_access', 'farm', 'a feature in testing, turned on for this business')
on conflict (table_name) do nothing;

insert into public.feature_flags (key, note) values
  ('map', 'Map, routes and where a vehicle was. In testing until self-hosted tiles and the privacy notice are done.')
on conflict (key) do nothing;

create table if not exists public.asset_positions (
  id          bigint generated always as identity primary key,
  farm_id     uuid not null,
  machine_id  uuid not null,
  session_id  uuid,
  recorded_at timestamptz not null,
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  speed_kmh   real,
  accuracy_m  real,
  source      text not null default 'phone' check (source in ('phone', 'tracker')),
  foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  foreign key (session_id, farm_id) references public.driving_sessions(id, farm_id)
);

create index if not exists asset_positions_machine_time_idx on public.asset_positions (machine_id, recorded_at desc);
create index if not exists asset_positions_session_idx on public.asset_positions (session_id, recorded_at);
create index if not exists asset_positions_farm_time_idx on public.asset_positions (farm_id, recorded_at);

alter table public.asset_positions enable row level security;
alter table public.asset_positions force row level security;

create policy asset_positions_sel on public.asset_positions for select to authenticated using (
  app.is_rr_admin()
  or app.effective_farm_role(auth.uid(), farm_id) in ('owner', 'manager')
  or exists (select 1 from public.driving_sessions s
              where s.id = session_id and s.driver_id = auth.uid())
);

-- SECURITY.md 2b. Written by the server after it has checked whose trip it is.
revoke all on public.asset_positions from public, anon, authenticated;
grant select on public.asset_positions to authenticated;
grant all on public.asset_positions to service_role;
revoke all on sequence public.asset_positions_id_seq from public, anon, authenticated;
grant usage, select on sequence public.asset_positions_id_seq to service_role;

-- Kept six months, then gone. The trip itself stays; only the trail goes.
create or replace function public.cron_purge_positions()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v integer;
begin
  delete from public.asset_positions where recorded_at < now() - interval '180 days';
  get diagnostics v = row_count;
  return v;
end $$;

revoke all on function public.cron_purge_positions() from public, anon, authenticated;
grant execute on function public.cron_purge_positions() to service_role;
