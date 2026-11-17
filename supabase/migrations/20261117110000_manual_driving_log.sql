-- B3 R-044 only. Extend the existing manual log; no map, route or paid-provider call.
alter table public.driving_sessions
  add column destination text check(char_length(destination)<=200),
  add column planned_stops text[] not null default '{}',
  add column start_km numeric(12,1) check(start_km between 0 and 999999999.9),
  add column end_km numeric(12,1) check(end_km between 0 and 999999999.9),
  add constraint driving_km_forward check(end_km is null or start_km is null or end_km>=start_km);
alter table public.driving_events
  add column odometer_km numeric(12,1) check(odometer_km between 0 and 999999999.9),
  add column destination text check(char_length(destination)<=200),
  add column planned_stops text[],
  add column client_request_id uuid,
  add column client_payload jsonb;
create unique index driving_manual_request on public.driving_events(recorded_by,client_request_id)
  where client_request_id is not null;
alter table public.driving_sessions force row level security;
alter table public.driving_events force row level security;

create function public.record_manual_driving_event(
  p_request uuid,p_farm uuid,p_machine uuid,p_driver uuid,p_kind text,
  p_session uuid default null,p_at timestamptz default null,p_location text default null,
  p_notes text default null,p_km numeric default null,p_destination text default null,p_stops text[] default null,
  p_lat double precision default null,p_lng double precision default null
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.user_role; result uuid; payload jsonb; old public.driving_events;
  sid uuid; last_km numeric; stops text[]; destination_text text;
begin
  r:=app.effective_farm_role(auth.uid(),p_farm);
  if auth.uid() is null or p_driver is null or r is null or not app.driver_member(auth.uid(),p_farm)
    or (p_driver<>auth.uid() and r not in ('owner','manager')) then
    raise exception 'forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(p_farm,true);
  if (p_lat is not null or p_lng is not null) and (not app.farm_plan_allows(p_farm,'maps') or not exists(
    select 1 from public.feature_flags f where f.key='map' and (f.released or exists(
      select 1 from public.farm_feature_access a where a.farm_id=p_farm and a.key=f.key)))) then
    raise exception 'forbidden' using errcode='42501'; end if;
  if not exists(select 1 from public.machines where id=p_machine and farm_id=p_farm)
    or not app.asset_allows(p_machine,'driver_workflow') then
    raise exception 'forbidden' using errcode='42501'; end if;
  if p_request is null or p_kind is null or p_kind not in ('start','arrive','depart','end')
    or (p_kind='start' and p_session is not null) or (p_kind<>'start' and p_session is null)
    or (p_km is not null and (p_km<0 or p_km>999999999.9 or p_km<>round(p_km,1)))
    or char_length(coalesce(p_destination,''))>200 or cardinality(p_stops)>50
    or (p_stops is not null and coalesce(array_ndims(p_stops),1)<>1)
    or exists(select 1 from unnest(p_stops) x where x is null or char_length(btrim(x)) not between 1 and 200) then
    raise exception 'driving-invalid' using errcode='22023'; end if;
  select coalesce(array_agg(btrim(x) order by n),'{}') into stops from unnest(p_stops) with ordinality t(x,n);
  destination_text:=nullif(btrim(p_destination),'');
  payload:=jsonb_build_array(p_farm,p_machine,p_driver,p_kind,p_session,p_at,p_location,p_notes,p_km,p_destination,p_stops,p_lat,p_lng);
  -- Request lock comes before the same farm lock used by legacy/trip writers.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||':manual-drive:'||p_request::text,0));
  perform 1 from public.farms where id=p_farm for update;
  select * into old from public.driving_events where recorded_by=auth.uid() and client_request_id=p_request;
  if found then
    if old.client_payload is distinct from payload then raise exception 'driving-request-changed' using errcode='22023'; end if;
    return old.id;
  end if;
  if p_session is not null then
    if not exists(select 1 from public.driving_sessions where id=p_session and farm_id=p_farm
      and machine_id=p_machine and driver_id=p_driver and ended_at is null) then
      raise exception 'session_changed' using errcode='22023'; end if;
    select max(odometer_km) into last_km from public.driving_events where session_id=p_session;
    if p_km<last_km then raise exception 'driving-km-backwards' using errcode='22023'; end if;
  end if;
  -- This preserves the existing chronology, arrival/departure, actor and active-session rules.
  result:=public.record_driving_event(p_farm,p_machine,p_driver,p_kind,coalesce(p_at,now()),p_location,p_notes,p_lat,p_lng,p_session);
  select session_id into sid from public.driving_events where id=result;
  update public.driving_sessions set
    destination=case when p_destination is null then destination else destination_text end,
    planned_stops=case when p_stops is null then planned_stops else stops end,
    start_km=case when p_kind='start' then p_km else start_km end,
    end_km=case when p_kind='end' then p_km else end_km end
    where id=sid;
  update public.driving_events set odometer_km=p_km,destination=destination_text,
    planned_stops=case when p_stops is not null then stops end,client_request_id=p_request,client_payload=payload where id=result;
  return result;
end $$;
revoke all on function public.record_manual_driving_event(uuid,uuid,uuid,uuid,text,uuid,timestamptz,text,text,numeric,text,text[],double precision,double precision)
  from public,anon,authenticated,service_role;
grant execute on function public.record_manual_driving_event(uuid,uuid,uuid,uuid,text,uuid,timestamptz,text,text,numeric,text,text[],double precision,double precision)
  to authenticated;
comment on function public.record_manual_driving_event(uuid,uuid,uuid,uuid,text,uuid,timestamptz,text,text,numeric,text,text[],double precision,double precision) is
  'Manual driving log on every plan. Optional kilometres are independent of the asset service meter. Ordered stops are written instructions, never a calculated route. Current permissions are checked before retries.';
