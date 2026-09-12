-- A capture and its acknowledgement commit together. Only the trusted API route may
-- supply p_actor; browser roles cannot execute this function. Authorization is checked
-- again from live rows here, not from the user's primary-role/session snapshot.
alter table public.sync_log add column if not exists request_hash text;

create or replace function public.apply_offline_capture(
  p_client uuid, p_client_ts timestamptz, p_type text, p_scope text,
  p_actor uuid, p_fields jsonb
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  v_machine public.machines%rowtype;
  v_card public.job_cards%rowtype;
  v_user public.users%rowtype;
  v_old public.sync_log%rowtype;
  v_role public.user_role;
  v_hash text;
  v_id uuid;
  v_status text := 'applied';
  v_entity text;
  v_reading numeric;
  v_date date;
  v_result jsonb;
  v_qty numeric;
  v_hours numeric;
  v_cost bigint;
  v_rate bigint;
  v_kind public.job_line_kind;
  v_lat numeric;
  v_lng numeric;
begin
  if p_client is null or p_client_ts is null or not isfinite(p_client_ts)
    or p_client_ts < timestamptz '1970-01-01 00:00:00+00'
    or p_client_ts > now() + interval '5 minutes'
    or p_type is null or p_type not in ('log_reading','report_fault','add_job_line','complete_job')
    or p_scope is null or p_scope not in ('app','public')
    or p_fields is null or jsonb_typeof(p_fields) <> 'object'
    or octet_length(p_fields::text) > 20000 then
    raise exception 'bad_mutation' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_fields) f where jsonb_typeof(f.value) <> 'string') then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  if p_scope = 'public' and (p_actor is not null or p_type not in ('log_reading','report_fault')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Lock the retry key before resource locks. Concurrent duplicates wait for the
  -- transaction's final result; a crashed transaction leaves neither data nor claim.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_client::text, 0));
  if p_type in ('add_job_line','complete_job') then
    select * into v_card from public.job_cards
      where id = coalesce(p_fields->>'job_card_id',p_fields->>'id')::uuid
        and deleted_at is null for update;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    select * into v_machine from public.machines
      where id = v_card.machine_id and farm_id = v_card.farm_id and deleted_at is null for update;
  elsif p_scope = 'public' then
    select * into v_machine from public.machines
      where public_token = (p_fields->>'token')::uuid and deleted_at is null for update;
  else
    select * into v_machine from public.machines
      where id = (p_fields->>'machine_id')::uuid and deleted_at is null for update;
  end if;
  if v_machine.id is null or not exists (
    select 1 from public.farms f where f.id = v_machine.farm_id
      and f.status in ('trial','active') and f.deleted_at is null
      and app.farm_billing_gate(f.id) = 'ok'
  ) then raise exception 'not_found' using errcode = 'P0002'; end if;

  if p_scope = 'app' then
    select * into v_user from public.users where id = p_actor and active and deleted_at is null;
    if not found then raise exception 'forbidden' using errcode = '42501'; end if;
    if v_user.role in ('rr_admin','workshop') then
      v_role := v_user.role;
    else
      select role into v_role from public.user_farm_memberships
        where user_id = p_actor and farm_id = v_machine.farm_id and active and deleted_at is null;
      if v_role is null and v_user.farm_id = v_machine.farm_id then v_role := v_user.role; end if;
    end if;
    if v_role is null or v_role not in ('rr_admin','owner','manager','mechanic','operator','workshop') or
      (v_role = 'operator' and (p_type in ('add_job_line','complete_job')
        or v_machine.assigned_operator_id is distinct from p_actor)) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_role = 'workshop' and (
      p_type not in ('add_job_line','complete_job') or not exists (
        select 1 from public.workshop_links l
        where l.farm_id = v_machine.farm_id and l.workshop_id = v_user.workshop_id
          and l.status = 'active' and l.deleted_at is null and (
            l.see_all_vehicles or exists (
              select 1 from public.work_requests w where w.farm_id = l.farm_id
                and w.machine_id = v_machine.id and w.workshop_id = l.workshop_id and w.deleted_at is null
            ) or exists (
              select 1 from public.partner_documents d where d.farm_id = l.farm_id
                and d.machine_id = v_machine.id and d.workshop_id = l.workshop_id and d.deleted_at is null
            )
          )
      )
    ) then raise exception 'forbidden' using errcode = '42501'; end if;
  end if;

  v_hash := encode(sha256(convert_to(p_fields::text, 'UTF8')), 'hex');
  select * into v_old from public.sync_log where client_id = p_client;
  if found then
    if v_old.farm_id <> v_machine.farm_id or v_old.by_user is distinct from p_actor
      or v_old.scope <> p_scope or v_old.mutation <> p_type
      or v_old.request_hash is distinct from v_hash or v_old.client_ts <> p_client_ts
      or v_old.status not in ('applied','conflict') then
      return jsonb_build_object('status','needs_review','error','retry_key_mismatch');
    end if;
    return jsonb_build_object('status',v_old.status,'duplicate',true,
      'entity',v_old.entity,'entity_id',v_old.entity_id,'farm_id',v_old.farm_id);
  end if;

  if p_type = 'log_reading' then
    v_entity := 'meter_readings';
    v_reading := nullif(btrim(p_fields->>'reading'),'')::numeric;
    v_date := coalesce(nullif(p_fields->>'reading_date','')::date, (p_client_ts at time zone 'Africa/Johannesburg')::date);
    if v_reading is null or v_reading < 0 or v_reading > 99999999999.9
      or v_reading <> round(v_reading,1) or not isfinite(v_date)
      or v_date < date '1970-01-01' or v_date > current_date or v_machine.meter_type = 'none'
      or length(coalesce(p_fields->>'name','')) > 200 then
      raise exception 'bad_reading' using errcode = '22023';
    end if;
    if p_scope = 'public' and (select count(*) from public.meter_readings r
      where r.machine_id = v_machine.id and r.source = 'qr'
        and r.created_at >= now() - interval '10 minutes') >= 30 then
      return jsonb_build_object('error','rate_limited');
    end if;
    -- Historical captures remain history. A same/newer-date decrease needs a person
    -- to resolve it; a client clock must never roll back service-due calculations.
    if v_machine.current_reading is not null and v_date >= coalesce(v_machine.current_reading_date,v_date)
      and v_reading < v_machine.current_reading then
      v_status := 'conflict';
    else
      insert into public.meter_readings(farm_id,machine_id,reading,reading_date,source,by_user)
      values(v_machine.farm_id,v_machine.id,v_reading,v_date,
        case when p_scope = 'public' then 'qr'::public.meter_source else 'manual'::public.meter_source end,p_actor)
      returning id into v_id;
      insert into public.usage_logs(farm_id,machine_id,driver_user_id,driver_name,occurred_on,meter_reading,source)
      values(v_machine.farm_id,v_machine.id,p_actor,nullif(p_fields->>'name',''),v_date,v_reading,
        case when p_scope = 'public' then 'qr'::public.meter_source else 'manual'::public.meter_source end);
    end if;
  elsif p_type = 'report_fault' then
    v_entity := 'faults';
    if length(btrim(coalesce(p_fields->>'description',''))) not between 1 and 2000
      or length(coalesce(p_fields->>'category','')) > 80 or length(coalesce(p_fields->>'name','')) > 200
      or coalesce(p_fields->>'urgency','can_work') not in ('can_work','limping','stopped') then
      raise exception 'bad_fault' using errcode = '22023';
    end if;
    v_lat := nullif(p_fields->>'lat','')::numeric;
    v_lng := nullif(p_fields->>'lng','')::numeric;
    if (v_lat is null) <> (v_lng is null) or not (v_lat between -90 and 90) or not (v_lng between -180 and 180) then
      raise exception 'bad_location' using errcode = '22023';
    end if;
    if p_scope = 'public' then
      v_result := public.record_public_qr_fault((p_fields->>'token')::uuid,p_fields->>'description',
        coalesce(p_fields->>'urgency','can_work')::public.fault_urgency,p_fields->>'category',p_fields->>'name',v_lat,v_lng);
      if not coalesce((v_result->>'ok')::boolean,false) then return v_result; end if;
      v_id := (v_result->>'fault_id')::uuid;
    else
      insert into public.faults(farm_id,machine_id,description,urgency,category,reported_by,status,lat,lng)
      values(v_machine.farm_id,v_machine.id,btrim(p_fields->>'description'),
        coalesce(p_fields->>'urgency','can_work')::public.fault_urgency,nullif(p_fields->>'category',''),p_actor,'open',v_lat,v_lng)
      returning id into v_id;
    end if;
  elsif p_type = 'add_job_line' then
    v_entity := 'job_card_lines';
    if v_card.locked then v_status := 'conflict';
    else
      v_kind := (p_fields->>'kind')::public.job_line_kind;
      v_qty := nullif(p_fields->>'qty','')::numeric;
      v_hours := nullif(p_fields->>'hours','')::numeric;
      v_cost := nullif(p_fields->>'unit_cost_cents','')::bigint;
      v_rate := nullif(p_fields->>'rate_cents','')::bigint;
      if v_kind is null or not (coalesce(v_qty,0) between 0 and 9999999999.99)
        or not (coalesce(v_hours,0) between 0 and 9999999999.99)
        or v_qty <> round(v_qty,2) or v_hours <> round(v_hours,2)
        or coalesce(v_cost,0) < 0 or coalesce(v_rate,0) < 0
        or length(coalesce(p_fields->>'description','')) > 2000 or length(coalesce(p_fields->>'part_no','')) > 200 then
        raise exception 'bad_line' using errcode = '22023';
      end if;
      if p_fields->>'incl_vat' = '1' then
        v_cost := round(v_cost::numeric * 10000 / (10000 + v_card.vat_rate_bps));
        v_rate := round(v_rate::numeric * 10000 / (10000 + v_card.vat_rate_bps));
      end if;
      insert into public.job_card_lines(farm_id,job_card_id,kind,description,part_no,qty,unit_cost_cents,hours,rate_cents)
      values(v_card.farm_id,v_card.id,v_kind,nullif(p_fields->>'description',''),nullif(p_fields->>'part_no',''),
        case when v_kind = 'part' then v_qty end,case when v_kind <> 'labour' then v_cost end,
        case when v_kind = 'labour' then v_hours end,case when v_kind = 'labour' then v_rate end)
      returning id into v_id;
    end if;
  else
    v_entity := 'job_cards';
    v_id := v_card.id;
    if not v_card.locked and v_card.status not in ('completed','approved') then
      v_reading := coalesce(nullif(p_fields->>'meter_reading','')::numeric,v_card.meter_reading);
      if v_reading < 0 or v_reading > 99999999999.9 or v_reading <> round(v_reading,1) then
        raise exception 'bad_reading' using errcode = '22023';
      end if;
      if v_machine.current_reading is not null and v_reading < v_machine.current_reading
        and current_date >= coalesce(v_machine.current_reading_date,current_date) then
        v_status := 'conflict';
      else
        update public.job_cards set status = 'completed',date_out = current_date,meter_reading = v_reading
          where id = v_card.id and farm_id = v_machine.farm_id;
      end if;
    end if;
  end if;

  insert into public.sync_log(farm_id,client_id,mutation,scope,entity,entity_id,status,client_ts,by_user,payload,superseded,request_hash)
  values(v_machine.farm_id,p_client,p_type,p_scope,v_entity,v_id,v_status,p_client_ts,p_actor,
    p_fields - 'token',case when v_status = 'conflict' then p_fields - 'token' end,v_hash);
  return jsonb_build_object('status',v_status,'entity',v_entity,'entity_id',v_id,'farm_id',v_machine.farm_id);
end $$;

revoke all on function public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb) to service_role;

-- Sync payloads may contain labour/part prices. Only the submitting user and farm
-- administrators may inspect them; operator read-expansion grants are not cost grants.
drop policy if exists sync_log_sel on public.sync_log;
create policy sync_log_sel on public.sync_log for select to authenticated using (
  deleted_at is null and app.has_farm_access(farm_id) and (
    by_user = (select auth.uid()) or
    app.effective_farm_role((select auth.uid()),farm_id) in ('rr_admin','owner','manager')
  )
);
