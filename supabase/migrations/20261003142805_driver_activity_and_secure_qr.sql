-- Driver activity is an append-only history. Only guarded commands mutate sessions.
create table public.driving_sessions (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id),
  machine_id uuid not null references public.machines(id),
  driver_id uuid not null references public.users(id),
  started_at timestamptz not null,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique(id, farm_id),
  foreign key(machine_id, farm_id) references public.machines(id, farm_id),
  check (ended_at is null or ended_at >= started_at)
);
create unique index driving_one_machine on public.driving_sessions(machine_id) where ended_at is null;
create unique index driving_one_driver on public.driving_sessions(driver_id) where ended_at is null;
create index driving_farm_time on public.driving_sessions(farm_id, started_at desc);

create table public.driver_connections (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id),
  name text not null check(length(name) between 1 and 120),
  kind text not null check(kind in ('tracker','key_tag','camera','engine_sensor','other')),
  active boolean not null default false,
  quote_reference text check(length(quote_reference)<=200),
  check (not active or nullif(trim(quote_reference),'') is not null),
  created_at timestamptz not null default now(),
  unique(id, farm_id)
);
-- Secrets are deliberately in a separate table, with no browser grants.
create table public.driver_connection_secrets (
  connection_id uuid primary key references public.driver_connections(id),
  token_hash text not null unique
);
alter table public.driver_connection_secrets enable row level security;
revoke all on public.driver_connection_secrets from public, anon, authenticated;
grant all on public.driver_connection_secrets to service_role;

create table public.driver_device_links (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id),
  connection_id uuid not null,
  external_id text not null check(length(external_id) between 1 and 200),
  machine_id uuid references public.machines(id),
  driver_id uuid references public.users(id),
  unique(connection_id, external_id),
  foreign key(connection_id, farm_id) references public.driver_connections(id, farm_id),
  foreign key(machine_id, farm_id) references public.machines(id, farm_id),
  check ((machine_id is null) <> (driver_id is null))
);
create table public.driving_events (
  id uuid primary key default gen_random_uuid(),
  sequence bigint generated always as identity unique,
  farm_id uuid not null,
  session_id uuid not null,
  kind text not null check(kind in ('start','arrive','depart','end','engine_on','engine_off','location')),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  recorded_by uuid references public.users(id),
  location text check(length(location) <= 200),
  notes text check(length(notes) <= 2000),
  lat double precision check(lat between -90 and 90),
  lng double precision check(lng between -180 and 180),
  source text not null check(source in ('driver','manager','integration')),
  connection_id uuid references public.driver_connections(id),
  external_event_id text,
  request_hash text,
  foreign key(session_id, farm_id) references public.driving_sessions(id, farm_id),
  foreign key(connection_id, farm_id) references public.driver_connections(id, farm_id),
  unique(connection_id, external_event_id),
  check ((lat is null) = (lng is null))
);
create index driving_events_session_time on public.driving_events(session_id, occurred_at, sequence);
revoke all on sequence public.driving_events_sequence_seq from public,anon,authenticated;
grant usage,select on sequence public.driving_events_sequence_seq to service_role;

alter table public.driving_sessions enable row level security;
alter table public.driving_events enable row level security;
alter table public.driver_connections enable row level security;
alter table public.driver_device_links enable row level security;
revoke all on public.driving_sessions, public.driving_events, public.driver_connections, public.driver_device_links from public, anon, authenticated;
grant select on public.driving_sessions, public.driving_events, public.driver_connections, public.driver_device_links to authenticated;
grant all on public.driving_sessions, public.driving_events, public.driver_connections, public.driver_device_links to service_role;
create policy driving_sessions_read on public.driving_sessions for select to authenticated using (
  app.effective_farm_role(auth.uid(), farm_id) in ('owner','manager','rr_admin')
  or (driver_id = auth.uid() and app.effective_farm_role(auth.uid(), farm_id) is not null)
);
create policy driving_events_read on public.driving_events for select to authenticated using (
  exists(select 1 from public.driving_sessions s where s.id = session_id)
);
create policy driver_connections_read on public.driver_connections for select to authenticated using (
  app.effective_farm_role(auth.uid(), farm_id) in ('owner','manager','rr_admin')
);
create policy driver_links_read on public.driver_device_links for select to authenticated using (
  app.effective_farm_role(auth.uid(), farm_id) in ('owner','manager','rr_admin')
);
create trigger driving_sessions_audit after insert or update or delete on public.driving_sessions for each row execute function public.app_audit();
create trigger driving_events_audit after insert or update or delete on public.driving_events for each row execute function public.app_audit();
create trigger driver_connections_audit after insert or update or delete on public.driver_connections for each row execute function public.app_audit();
create trigger driver_links_audit after insert or update or delete on public.driver_device_links for each row execute function public.app_audit();

-- Internal membership lookup also validates drivers who are not the caller. No API grant.
create function app.driver_member(p_user uuid, p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from users u where u.id = p_user and u.active and u.deleted_at is null
    and u.role in ('owner','manager','mechanic','operator') and (
      exists(select 1 from user_farm_memberships m where m.user_id=u.id and m.farm_id=p_farm and m.active and m.deleted_at is null)
      or (u.farm_id=p_farm and not exists(select 1 from user_farm_memberships m where m.user_id=u.id and m.farm_id=p_farm))
    ));
$$;
revoke all on function app.driver_member(uuid,uuid) from public, anon, authenticated;

-- Serialize per farm. Unique active driver/vehicle indexes also prevent cross-farm races.
create function app.write_driving_event(p_farm uuid, p_machine uuid, p_driver uuid,
  p_kind text, p_at timestamptz, p_location text, p_notes text, p_lat double precision,
  p_lng double precision, p_actor uuid, p_connection uuid, p_external text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare s driving_sessions%rowtype; last_at timestamptz; last_stop text; result uuid; fingerprint text; previous_hash text;
begin
  perform 1 from farms where id=p_farm and deleted_at is null and status in ('active','trial') for update;
  if not found then raise exception 'farm_unavailable' using errcode='42501'; end if;
  if p_connection is not null then
    fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_machine,p_driver,p_kind,p_at,p_location,p_lat,p_lng)::text,'UTF8')),'hex');
    select id,request_hash into result,previous_hash from driving_events where connection_id=p_connection and external_event_id=p_external;
    if result is not null then
      if previous_hash is distinct from fingerprint then raise exception 'retry_payload_changed' using errcode='22023'; end if;
      return result;
    end if;
  end if;
  if p_at is null or p_at > now() + interval '5 minutes' or p_at < now() - interval '5 years'
     or p_kind is null or p_kind not in ('start','arrive','depart','end','engine_on','engine_off','location')
     or (p_lat is null) <> (p_lng is null) or abs(p_lat)>90 or abs(p_lng)>180
     or length(p_location)>200 or length(p_notes)>2000 then
    raise exception 'invalid_event' using errcode='22023';
  end if;
  if (p_kind<>'end' and not app.driver_member(p_driver,p_farm)) or not exists(select 1 from machines where id=p_machine and farm_id=p_farm and (p_kind='end' or (deleted_at is null and status not in ('retired','sold')))) then
    raise exception 'invalid_driver_or_machine' using errcode='42501';
  end if;
  select * into s from driving_sessions where machine_id=p_machine and ended_at is null for update;
  if p_kind='start' then
    if s.id is not null or exists(select 1 from driving_sessions where driver_id=p_driver and ended_at is null) then
      raise exception 'already_driving' using errcode='22023';
    end if;
    if exists(select 1 from driving_sessions where (machine_id=p_machine or driver_id=p_driver) and ended_at>p_at) then
      raise exception 'overlapping_session' using errcode='22023';
    end if;
    insert into driving_sessions(farm_id,machine_id,driver_id,started_at) values(p_farm,p_machine,p_driver,p_at) returning * into s;
  else
    if s.id is null or s.driver_id<>p_driver then raise exception 'no_matching_session' using errcode='22023'; end if;
    select max(occurred_at) into last_at from driving_events where session_id=s.id;
    if p_at<last_at then raise exception 'out_of_order' using errcode='22023'; end if;
    select kind into last_stop from driving_events where session_id=s.id and kind in ('arrive','depart') order by occurred_at desc, sequence desc limit 1;
    if p_kind='arrive' and (last_stop='arrive' or nullif(trim(p_location),'') is null) then raise exception 'invalid_arrival' using errcode='22023'; end if;
    if p_kind='depart' and last_stop is distinct from 'arrive' then raise exception 'not_at_location' using errcode='22023'; end if;
    if p_kind='end' then update driving_sessions set ended_at=p_at where id=s.id; end if;
  end if;
  insert into driving_events(farm_id,session_id,kind,occurred_at,location,notes,lat,lng,recorded_by,source,connection_id,external_event_id,request_hash)
    values(p_farm,s.id,p_kind,p_at,nullif(trim(p_location),''),nullif(trim(p_notes),''),p_lat,p_lng,p_actor,
      case when p_connection is not null then 'integration' when p_actor=p_driver then 'driver' else 'manager' end,p_connection,p_external,fingerprint)
    returning id into result;
  return result;
end $$;
revoke all on function app.write_driving_event(uuid,uuid,uuid,text,timestamptz,text,text,double precision,double precision,uuid,uuid,text) from public, anon, authenticated;

create function public.record_driving_event(p_farm uuid,p_machine uuid,p_driver uuid,p_kind text,
  p_at timestamptz default now(),p_location text default null,p_notes text default null,
  p_lat double precision default null,p_lng double precision default null,p_session uuid default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare r user_role;
begin
  r:=app.effective_farm_role(auth.uid(),p_farm);
  if auth.uid() is null or r is null or (p_driver<>auth.uid() and r not in ('owner','manager','rr_admin'))
    or not app.driver_member(auth.uid(),p_farm) then raise exception 'forbidden' using errcode='42501'; end if;
  -- Lock in the same order as the internal writer before checking a stale dialog.
  perform 1 from farms where id=p_farm for update;
  if p_session is not null and not exists(select 1 from driving_sessions where id=p_session and farm_id=p_farm and machine_id=p_machine and driver_id=p_driver and ended_at is null) then
    raise exception 'session_changed' using errcode='22023'; end if;
  return app.write_driving_event(p_farm,p_machine,p_driver,p_kind,p_at,p_location,p_notes,p_lat,p_lng,auth.uid(),null,null);
end $$;
revoke all on function public.record_driving_event(uuid,uuid,uuid,text,timestamptz,text,text,double precision,double precision,uuid) from public, anon;
grant execute on function public.record_driving_event(uuid,uuid,uuid,text,timestamptz,text,text,double precision,double precision,uuid) to authenticated;

-- Minimal fleet picker: farm members can choose a car without gaining financial/history access.
create function public.driving_vehicles(p_farm uuid) returns table(id uuid,name text)
language sql stable security definer set search_path=public,pg_temp as $$
  select m.id,m.name from machines m where m.farm_id=p_farm and m.deleted_at is null
    and m.status not in ('retired','sold') and app.driver_member(auth.uid(),p_farm) order by m.name;
$$;
revoke all on function public.driving_vehicles(uuid) from public,anon;
grant execute on function public.driving_vehicles(uuid) to authenticated;

-- Secure QR resolution is explicit farm membership, never merely possession of a token.
create function public.resolve_member_qr(p_token uuid) returns table(id uuid,farm_id uuid,name text)
language sql stable security definer set search_path=public,pg_temp as $$
  select m.id,m.farm_id,m.name from machines m join farms f on f.id=m.farm_id
  where m.public_token=p_token and m.deleted_at is null and f.deleted_at is null
    and f.status in ('trial','active') and app.driver_member(auth.uid(),m.farm_id);
$$;
revoke all on function public.resolve_member_qr(uuid) from public,anon;
grant execute on function public.resolve_member_qr(uuid) to authenticated;

create function public.ingest_driving_event(p_connection uuid,p_machine_external text,p_driver_external text,
  p_event_id text,p_kind text,p_at timestamptz,p_location text default null,p_lat double precision default null,p_lng double precision default null) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare f uuid; m uuid; d uuid;
begin
  select farm_id into f from driver_connections where id=p_connection and active for update;
  if f is null or nullif(trim(p_event_id),'') is null or length(p_event_id)>200 then raise exception 'invalid_connection' using errcode='22023'; end if;
  select machine_id into m from driver_device_links where connection_id=p_connection and external_id=p_machine_external;
  select driver_id into d from driver_device_links where connection_id=p_connection and external_id=p_driver_external;
  if m is null or d is null then raise exception 'unmapped_device_or_driver' using errcode='22023'; end if;
  return app.write_driving_event(f,m,d,p_kind,p_at,p_location,null,p_lat,p_lng,null,p_connection,p_event_id);
end $$;
revoke all on function public.ingest_driving_event(uuid,text,text,text,text,timestamptz,text,double precision,double precision) from public,anon,authenticated;
grant execute on function public.ingest_driving_event(uuid,text,text,text,text,timestamptz,text,double precision,double precision) to service_role;

-- Only Fleetwise staff can provision/activate this quoted add-on. Farm admins read status.
create function public.configure_driver_connection(p_farm uuid,p_name text,p_kind text,p_hash text,
  p_id uuid default null,p_active boolean default false,p_quote text default null) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare result uuid;
begin
  if not app.is_rr_admin() then raise exception 'forbidden' using errcode='42501'; end if;
  if p_active and nullif(trim(p_quote),'') is null then raise exception 'quote_required' using errcode='22023'; end if;
  if p_id is null then
    if p_hash is null or p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token' using errcode='22023'; end if;
    insert into driver_connections(farm_id,name,kind,active,quote_reference) values(p_farm,p_name,p_kind,p_active,p_quote) returning id into result;
    insert into driver_connection_secrets(connection_id,token_hash) values(result,p_hash);
  else
    update driver_connections set name=p_name,kind=p_kind,active=p_active,quote_reference=p_quote where id=p_id and farm_id=p_farm returning id into result;
    if result is null then raise exception 'not_found' using errcode='22023'; end if;
    if p_hash is not null then
      if p_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid_token' using errcode='22023'; end if;
      update driver_connection_secrets set token_hash=p_hash where connection_id=result;
    end if;
  end if;
  return result;
end $$;
revoke all on function public.configure_driver_connection(uuid,text,text,text,uuid,boolean,text) from public,anon;
grant execute on function public.configure_driver_connection(uuid,text,text,text,uuid,boolean,text) to authenticated;

create function public.link_driver_device(p_connection uuid,p_external text,p_machine uuid default null,p_driver uuid default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare f uuid;
begin
  if not app.is_rr_admin() then raise exception 'forbidden' using errcode='42501'; end if;
  select farm_id into f from driver_connections where id=p_connection for update;
  if f is null or (p_machine is null)=(p_driver is null)
    or (p_driver is not null and not app.driver_member(p_driver,f))
    or (p_machine is not null and not exists(select 1 from machines where id=p_machine and farm_id=f and deleted_at is null)) then
    raise exception 'invalid_link' using errcode='22023'; end if;
  insert into driver_device_links(farm_id,connection_id,external_id,machine_id,driver_id)
    values(f,p_connection,p_external,p_machine,p_driver)
    on conflict(connection_id,external_id) do update set machine_id=excluded.machine_id,driver_id=excluded.driver_id;
end $$;
revoke all on function public.link_driver_device(uuid,text,uuid,uuid) from public,anon;
grant execute on function public.link_driver_device(uuid,text,uuid,uuid) to authenticated;

create function public.driving_people(p_farm uuid) returns table(id uuid,name text)
language sql stable security definer set search_path=public,pg_temp as $$
  select u.id,u.name from users u where app.driver_member(u.id,p_farm)
    and (u.id=auth.uid() or app.effective_farm_role(auth.uid(),p_farm) in ('owner','manager','rr_admin')) order by u.name;
$$;
revoke all on function public.driving_people(uuid) from public,anon;
grant execute on function public.driving_people(uuid) to authenticated;

-- Existing service-only capture engines remain for deployment compatibility; browsers
-- reach this authenticated wrapper, which checks membership inside the write transaction.
create table public.member_qr_receipts (
  user_id uuid not null references public.users(id),
  client_id uuid not null,
  farm_id uuid not null references public.farms(id),
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id,client_id)
);
alter table public.member_qr_receipts enable row level security;
revoke all on public.member_qr_receipts from public,anon,authenticated;
grant all on public.member_qr_receipts to service_role;

create function public.record_member_qr(p_token uuid,p_kind text,p_fields jsonb,p_client uuid default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare m machines%rowtype; n text; result jsonb; fingerprint text; previous public.member_qr_receipts%rowtype;
begin
  select * into m from machines where public_token=p_token and deleted_at is null for update;
  if auth.uid() is null or m.id is null or not app.driver_member(auth.uid(),m.farm_id) then
    raise exception 'forbidden' using errcode='42501'; end if;
  if p_client is not null then
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||p_client::text,0));
    fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_token,p_kind,p_fields)::text,'UTF8')),'hex');
    select * into previous from member_qr_receipts where user_id=auth.uid() and client_id=p_client;
    if found then
      if previous.payload_hash<>fingerprint then raise exception 'retry_payload_changed' using errcode='22023'; end if;
      return previous.result;
    end if;
  end if;
  select name into n from users where id=auth.uid();
  if p_kind='reading' then
    result:=record_public_qr_reading(p_token,(p_fields->>'p_reading')::numeric,n);
    if result->>'ok'='true' then update meter_readings set by_user=auth.uid() where id=(result->>'reading_id')::uuid; end if;
  elsif p_kind='fuel' then
    result:=record_public_qr_fuel(p_token,(p_fields->>'p_litres')::numeric,(p_fields->>'p_meter_reading')::numeric,n,p_fields->>'p_activity',(p_fields->>'p_cost_incl_cents')::bigint);
  elsif p_kind='fault' then
    result:=record_public_qr_fault(p_token,p_fields->>'p_description',(p_fields->>'p_urgency')::fault_urgency,p_fields->>'p_category',n,(p_fields->>'p_lat')::numeric,(p_fields->>'p_lng')::numeric);
    if result->>'ok'='true' then update faults set reported_by=auth.uid() where id=(result->>'fault_id')::uuid; end if;
  else raise exception 'invalid_kind' using errcode='22023'; end if;
  if p_client is not null and result->>'ok'='true' then
    insert into member_qr_receipts(user_id,client_id,farm_id,payload_hash,result) values(auth.uid(),p_client,m.farm_id,fingerprint,result);
  end if;
  return result;
end $$;
revoke all on function public.record_member_qr(uuid,text,jsonb,uuid) from public,anon;
grant execute on function public.record_member_qr(uuid,text,jsonb,uuid) to authenticated;

-- Aggregate per visible session so API row caps cannot silently truncate stop durations.
create function public.driving_session_details(p_sessions uuid[])
returns table(session_id uuid,stop_events jsonb,recent_events jsonb,last_location jsonb)
language sql stable security invoker set search_path=public,pg_temp as $$
  select s.id,
    coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.sequence) from driving_events e
      where e.session_id=s.id and e.kind in ('arrive','depart','end')),'[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(recent) order by recent.occurred_at,recent.sequence) from
      (select e.* from driving_events e where e.session_id=s.id order by e.occurred_at desc,e.sequence desc limit 50) recent),'[]'::jsonb),
    (select to_jsonb(e) from driving_events e where e.session_id=s.id and (e.location is not null or e.lat is not null) order by e.occurred_at desc,e.sequence desc limit 1)
  from driving_sessions s where s.id=any(p_sessions);
$$;
revoke all on function public.driving_session_details(uuid[]) from public,anon;
grant execute on function public.driving_session_details(uuid[]) to authenticated;

create function app.driving_access(p_farm uuid,p_driver uuid default null) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select app.is_rr_admin() or (app.driver_member(auth.uid(),p_farm) and
    (p_driver=auth.uid() or app.effective_farm_role(auth.uid(),p_farm) in ('owner','manager')));
$$;
revoke all on function app.driving_access(uuid,uuid) from public,anon;
grant execute on function app.driving_access(uuid,uuid) to authenticated;
alter policy driving_sessions_read on public.driving_sessions using(app.driving_access(farm_id,driver_id));
alter policy driver_connections_read on public.driver_connections using(app.driving_access(farm_id));
alter policy driver_links_read on public.driver_device_links using(app.driving_access(farm_id));
