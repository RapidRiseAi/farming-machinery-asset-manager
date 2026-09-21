-- 20260920120000_offline_fuel_and_checklists.sql
-- The two daily captures that still needed a signal.
--
-- The offline queue (F2) has carried four things since it was built: a reading, a fault, a
-- job-card line and a job completion. Two of the jobs a person actually does at the yard
-- were not among them:
--
--   * a DIESEL DRAW at the bowser, which is the SARS rebate trail, and
--   * a PRE-START CHECK, which is done at first light beside the machine.
--
-- Both happen exactly where the signal is worst. Without them the driver either waits for
-- a bar of signal or writes it on his hand, which is where fleet data goes to die.
--
-- WHAT THIS CHANGES
-- =============================================================================
-- `apply_offline_capture` gains `log_fuel` and `submit_checklist`, replayed through the
-- same envelope: the client's idempotency key, the same retry-key mismatch rules, the same
-- `sync_log` row, and the same authorisation re-checked from live rows rather than from
-- whatever the device believed when it was last online. Neither is offered on the public QR
-- scope; both are app captures by a signed-in person.
--
-- A fuel draw offline must NAME A MACHINE. The machine is how the replay finds the farm, and
-- a farm-level draw ("we filled the bowser") is office work done with a signal anyway.
--
-- Checklist PHOTOS are not queued. The fault path carries media because a photo of a broken
-- part is the report; a pre-start check is the answers. Written down rather than discovered:
-- an offline checklist keeps its answers and loses nothing else.

-- == VAT, in one place =======================================================
-- Three paths now turn a VAT-inclusive cost into stored ex-VAT cents: the QR capture, the
-- authenticated command, and this replay. They agreed by being copied, which is how they
-- start disagreeing. The rate lookup and the arithmetic live here from now on.
create or replace function app.farm_vat_rate_bps(p_farm uuid)
returns integer
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select case
           when f.settings ->> 'vat_rate_bps' ~ '^[0-9]{1,5}$'
            and (f.settings ->> 'vat_rate_bps')::numeric between 0 and 10000
           then (f.settings ->> 'vat_rate_bps')::integer
           else 1500
         end
    from public.farms f
   where f.id = p_farm;
$$;

revoke execute on function app.farm_vat_rate_bps(uuid) from public, anon;
grant execute on function app.farm_vat_rate_bps(uuid) to authenticated, service_role;

-- The authenticated command now reads the rate through the helper and converts with the
-- billing core's own `app.ex_vat_cents`, rather than repeating either. `record_public_qr_fuel` is left exactly as it is: it is
-- proven by its own suite, and rewriting working capture code to remove a duplicate is a
-- worse trade than the duplicate. Section (b) of fuel_issue_atomicity pins the result.
create or replace function public.record_fuel_issue(
  p_farm uuid,
  p_tank uuid,
  p_machine uuid default null,
  p_date date default current_date,
  p_litres numeric default null,
  p_meter numeric default null,
  p_cost_incl_cents bigint default null,
  p_activity text default null,
  p_driver_user uuid default null
) returns uuid
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_id uuid;
  v_role user_role;
  v_driver uuid := auth.uid();
  v_plan farm_plan;
  v_vat_rate_bps integer;
  v_activity text := nullif(btrim(coalesce(p_activity, '')), '');
  v_meter_type meter_type;
  v_cost_ex_cents bigint;
  v_price_per_l_cents bigint;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null
     or v_role not in ('rr_admin','owner','manager','mechanic','operator') then
    raise exception 'This person may not record a fuel draw.' using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;

  if p_litres is null or p_litres <= 0 or p_litres > 99999999999.9 then
    raise exception 'A valid number of litres is required.' using errcode = '22023';
  end if;
  if p_date is null or p_date > current_date then
    raise exception 'A fuel draw cannot be dated in the future.' using errcode = '22023';
  end if;
  if p_meter is not null and (p_meter < 0 or p_meter > 99999999999.9) then
    raise exception 'A valid non-negative meter reading is required.' using errcode = '22023';
  end if;
  if p_cost_incl_cents is not null
     and (p_cost_incl_cents < 0 or p_cost_incl_cents > 900000000000000000) then
    raise exception 'A valid cost is required.' using errcode = '22023';
  end if;
  if v_activity is not null and v_activity not in (
       'ploughing', 'planting', 'spraying', 'harvesting', 'transport',
       'irrigation', 'generator', 'loading', 'other'
     ) then
    raise exception 'That is not a fuel activity.' using errcode = '22023';
  end if;

  select f.plan into v_plan
    from public.farms f
   where f.id = p_farm
     and f.deleted_at is null;
  if not found then
    raise exception 'Farm not found.' using errcode = '42501';
  end if;
  if app.plan_rank(v_plan) < app.feature_min_rank('fuel') then
    raise exception 'This farm''s plan does not include fuel.' using errcode = '42501';
  end if;

  perform 1
     from public.fuel_tanks t
    where t.id = p_tank
      and t.farm_id = p_farm
      and t.deleted_at is null;
  if not found then
    raise exception 'Fuel tank not found.' using errcode = '42501';
  end if;

  if p_machine is not null then
    select m.meter_type
      into v_meter_type
      from public.machines m
     where m.id = p_machine
       and m.farm_id = p_farm
       and m.deleted_at is null
       and app.row_visible_to_role(p_farm, p_machine);
    if not found then
      raise exception 'Machine not found or not visible to this person.'
        using errcode = '42501';
    end if;
    if p_meter is not null and v_meter_type = 'none' then
      raise exception 'That machine does not keep a meter reading.' using errcode = '22023';
    end if;
  elsif p_meter is not null then
    raise exception 'A meter reading needs a machine.' using errcode = '22023';
  end if;

  if p_driver_user is not null and app.user_belongs_to_farm(p_driver_user, p_farm) then
    v_driver := p_driver_user;
  end if;

  -- Null only if the row is unreadable, which the access checks above have ruled out.
  v_vat_rate_bps := coalesce(app.farm_vat_rate_bps(p_farm), 1500);
  v_cost_ex_cents := app.ex_vat_cents(p_cost_incl_cents, v_vat_rate_bps);
  if v_cost_ex_cents is not null then
    v_price_per_l_cents := round(v_cost_ex_cents::numeric / p_litres)::bigint;
  end if;

  insert into public.fuel_issues(
    farm_id, tank_id, machine_id, date, litres, meter_reading,
    cost_cents, price_per_l_cents, vat_rate_bps, activity, by_user
  ) values (
    p_farm, p_tank, p_machine, p_date, p_litres, p_meter,
    v_cost_ex_cents, v_price_per_l_cents,
    case when p_cost_incl_cents is null then null else v_vat_rate_bps end,
    v_activity, auth.uid()
  ) returning id into v_id;

  if p_machine is not null and p_meter is not null then
    insert into public.usage_logs(
      farm_id, machine_id, driver_user_id, occurred_on, meter_reading, source, note
    ) values (
      p_farm, p_machine, v_driver, p_date, p_meter, 'app',
      case when v_activity is null then 'Fuel draw'
           else format('Fuel draw (%s)', v_activity) end
    );
  end if;

  return v_id;
end $$;

-- == Raising checklist defects on behalf of an offline capture ===============
-- The one-argument version goes: with a default on the new parameter the two would be
-- ambiguous, and PostgREST resolves by named arguments, so the app would start getting
-- "function is not unique" rather than a defect.
drop function if exists public.record_checklist_defects(uuid);

-- The replay runs as `service_role` with no `auth.uid()`, so the actor has to be passed.
-- An authenticated caller may not pass somebody else's: the only caller allowed to name an
-- actor is one that has no session of its own, which is the trusted sync route.
create or replace function public.record_checklist_defects(
  p_instance uuid,
  p_actor uuid default null
)
returns integer
language plpgsql
security invoker
set search_path = public, app, pg_temp
as $$
declare
  v_actor uuid := coalesce(auth.uid(), p_actor);
  v_farm uuid;
  v_machine uuid;
  v_name text;
  v_raised timestamptz;
  v_count integer := 0;
  r record;
begin
  if auth.uid() is not null and p_actor is not null and p_actor <> auth.uid() then
    raise exception 'A signed-in caller may not report defects as somebody else.'
      using errcode = '42501';
  end if;
  if v_actor is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;

  select ci.farm_id, ci.machine_id, ci.template_name, ci.defects_raised_at
    into v_farm, v_machine, v_name, v_raised
    from public.checklist_instances ci
   where ci.id = p_instance
     and ci.deleted_at is null
     and ci.status = 'completed'
   for update;
  if not found then
    return 0;
  end if;
  if v_raised is not null then
    return 0;
  end if;

  for r in
    select v.label,
           v.notes,
           coalesce(f.fail_urgency, 'limping'::fault_urgency) as urgency
      from public.checklist_instance_values v
      join public.checklist_template_fields f on f.id = v.template_field_id
     where v.instance_id = p_instance
       and v.deleted_at is null
       and f.fail_when is not null
       and (
         (f.fail_when = 'checked'
            and lower(coalesce(v.value_text, '')) in ('true','t','yes','1','on'))
         or (f.fail_when = 'unchecked'
            and lower(coalesce(v.value_text, '')) not in ('true','t','yes','1','on'))
         or (f.fail_when = 'below'
            and f.fail_threshold is not null
            and v.value_text ~ '^-?[0-9]+(\.[0-9]+)?$'
            and v.value_text::numeric < f.fail_threshold)
         or (f.fail_when = 'above'
            and f.fail_threshold is not null
            and v.value_text ~ '^-?[0-9]+(\.[0-9]+)?$'
            and v.value_text::numeric > f.fail_threshold)
       )
     order by v.sort_order, v.label
  loop
    insert into public.faults(
      farm_id, machine_id, reported_by, description, category, urgency, status,
      checklist_instance_id
    ) values (
      v_farm, v_machine, v_actor,
      left(format('%s, %s%s', coalesce(v_name, 'Checklist'), r.label,
             case when coalesce(btrim(r.notes), '') = '' then ''
                  else format(': %s', r.notes) end), 1000),
      'checklist', r.urgency, 'open', p_instance
    );
    v_count := v_count + 1;
  end loop;

  update public.checklist_instances
     set defects_raised_at = now()
   where id = p_instance
     and farm_id = v_farm;

  return v_count;
end $$;

revoke execute on function public.record_checklist_defects(uuid, uuid) from public, anon;
grant execute on function public.record_checklist_defects(uuid, uuid)
  to authenticated, service_role;

-- == The replay itself =======================================================
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
  v_tank uuid;
  v_litres numeric;
  v_activity text;
  v_vat integer;
  v_values jsonb;
  v_value jsonb;
begin
  if p_client is null or p_client_ts is null or not isfinite(p_client_ts)
    or p_client_ts < timestamptz '1970-01-01 00:00:00+00'
    or p_client_ts > now() + interval '5 minutes'
    or p_type is null or p_type not in
      ('log_reading','report_fault','add_job_line','complete_job','log_fuel','submit_checklist')
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
    -- A workshop is here for job-card work only: it has no business drawing a farm's
    -- diesel or signing its pre-start checks.
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
      or v_reading <> round(v_reading,1) or v_date > current_date then
      raise exception 'bad_reading' using errcode = '22023';
    end if;
    if p_scope = 'public' and (select count(*) from public.meter_readings r
      where r.machine_id = v_machine.id and r.source = 'qr'
        and r.created_at >= now() - interval '10 minutes') >= 30 then
      return jsonb_build_object('error','rate_limited');
    end if;
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

  -- == A diesel draw, captured at the bowser ================================
  elsif p_type = 'log_fuel' then
    v_entity := 'fuel_issues';
    if app.plan_rank((select f.plan from public.farms f where f.id = v_machine.farm_id))
         < app.feature_min_rank('fuel') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_tank := nullif(p_fields->>'tank_id','')::uuid;
    v_litres := nullif(btrim(p_fields->>'litres'),'')::numeric;
    v_reading := nullif(btrim(p_fields->>'meter_reading'),'')::numeric;
    v_date := coalesce(nullif(p_fields->>'date','')::date, (p_client_ts at time zone 'Africa/Johannesburg')::date);
    v_activity := nullif(btrim(coalesce(p_fields->>'activity','')),'');
    v_cost := nullif(btrim(p_fields->>'cost_incl_cents'),'')::bigint;
    if v_litres is null or v_litres <= 0 or v_litres > 99999999999.9
      or v_date > current_date
      or (v_reading is not null and (v_reading < 0 or v_reading > 99999999999.9))
      or (v_cost is not null and (v_cost < 0 or v_cost > 900000000000000000))
      or (v_activity is not null and v_activity not in (
          'ploughing','planting','spraying','harvesting','transport',
          'irrigation','generator','loading','other')) then
      raise exception 'bad_fuel' using errcode = '22023';
    end if;
    -- The tank must belong to the machine's farm. Offline or not, a draw cannot come out
    -- of somebody else's bowser.
    if v_tank is null or not exists (
      select 1 from public.fuel_tanks t
       where t.id = v_tank and t.farm_id = v_machine.farm_id and t.deleted_at is null
    ) then raise exception 'not_found' using errcode = 'P0002'; end if;
    if v_reading is not null and v_machine.meter_type = 'none' then
      raise exception 'bad_fuel' using errcode = '22023';
    end if;

    v_vat := coalesce(app.farm_vat_rate_bps(v_machine.farm_id), 1500);
    insert into public.fuel_issues(
      farm_id,tank_id,machine_id,date,litres,meter_reading,
      cost_cents,price_per_l_cents,vat_rate_bps,activity,by_user)
    values(
      v_machine.farm_id,v_tank,v_machine.id,v_date,v_litres,v_reading,
      app.ex_vat_cents(v_cost,v_vat),
      case when v_cost is null then null
           else round(app.ex_vat_cents(v_cost,v_vat)::numeric / v_litres)::bigint end,
      case when v_cost is null then null else v_vat end,
      v_activity,p_actor)
    returning id into v_id;
    if v_reading is not null then
      insert into public.usage_logs(farm_id,machine_id,driver_user_id,occurred_on,meter_reading,source,note)
      values(v_machine.farm_id,v_machine.id,p_actor,v_date,v_reading,'app',
        case when v_activity is null then 'Fuel draw' else format('Fuel draw (%s)',v_activity) end);
    end if;

  -- == A pre-start check, filled in at first light ==========================
  elsif p_type = 'submit_checklist' then
    v_entity := 'checklist_instances';
    begin
      v_values := (p_fields->>'values')::jsonb;
    exception when others then
      raise exception 'bad_checklist' using errcode = '22023';
    end;
    if v_values is null or jsonb_typeof(v_values) <> 'array'
      or jsonb_array_length(v_values) = 0 or jsonb_array_length(v_values) > 200
      or length(coalesce(p_fields->>'template_name','')) > 200
      or length(coalesce(p_fields->>'notes','')) > 2000 then
      raise exception 'bad_checklist' using errcode = '22023';
    end if;
    v_reading := nullif(btrim(p_fields->>'meter_reading'),'')::numeric;
    if v_reading is not null and (v_reading < 0 or v_reading > 99999999999.9) then
      raise exception 'bad_checklist' using errcode = '22023';
    end if;

    insert into public.checklist_instances(
      farm_id,machine_id,template_id,template_name,status,meter_reading,notes,
      performed_by,completed_at,created_by)
    values(
      v_machine.farm_id,v_machine.id,nullif(p_fields->>'template_id','')::uuid,
      coalesce(nullif(btrim(p_fields->>'template_name'),''),'Checklist'),
      'completed',v_reading,nullif(btrim(p_fields->>'notes'),''),
      p_actor,p_client_ts,p_actor)
    returning id into v_id;

    for v_value in select * from jsonb_array_elements(v_values) loop
      if jsonb_typeof(v_value) <> 'object'
        or coalesce(v_value->>'field_type','') not in
           ('checkbox','text','number','photo','rating','section_break') then
        raise exception 'bad_checklist' using errcode = '22023';
      end if;
      insert into public.checklist_instance_values(
        farm_id,instance_id,template_field_id,sort_order,field_type,label,value_text,notes)
      values(
        v_machine.farm_id,v_id,nullif(v_value->>'template_field_id','')::uuid,
        coalesce((v_value->>'sort_order')::int,0),
        v_value->>'field_type',
        left(coalesce(nullif(btrim(v_value->>'label'),''),'Field'),500),
        left(nullif(btrim(coalesce(v_value->>'value_text','')),''),2000),
        left(nullif(btrim(coalesce(v_value->>'notes','')),''),2000));
    end loop;

    -- A failed answer still opens a fault when it arrives a day late. The actor is passed
    -- because this runs with no session of its own; `record_checklist_defects` refuses an
    -- actor from any caller that HAS one.
    perform public.record_checklist_defects(v_id, p_actor);

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

revoke all on function public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)
  to service_role;
