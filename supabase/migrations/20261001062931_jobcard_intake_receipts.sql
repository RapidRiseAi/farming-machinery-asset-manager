-- Capture metadata stays on the protected parent record. RPCs remain SECURITY
-- INVOKER: existing farm/provider RLS and workflow triggers authorize every write.
alter table public.job_cards add column intake_capture uuid, add column intake_actor uuid references public.users(id), add column intake_payload jsonb;
alter table public.work_requests add column intake_capture uuid, add column intake_actor uuid references public.users(id), add column intake_payload jsonb;
create unique index job_cards_intake_capture_uq on public.job_cards(intake_capture) where intake_capture is not null;
create unique index work_requests_intake_capture_uq on public.work_requests(intake_capture) where intake_capture is not null;
grant select(intake_capture,intake_actor,intake_payload) on public.job_cards,public.work_requests to authenticated;

create function app.intake_payload(p_kind text,p_fields jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when p_kind='job' then jsonb_build_object(
   'farm_id',nullif(p_fields->>'farm_id','')::uuid,'machine_id',nullif(p_fields->>'machine_id','')::uuid,
   'type',coalesce(p_fields->>'type','repair'),'work_mode',coalesce(p_fields->>'work_mode','internal'),
   'workshop_id',nullif(p_fields->>'workshop_id','')::uuid,
   'external_provider_name',nullif(btrim(p_fields->>'external_provider_name'),''),
   'reported_problem',nullif(btrim(p_fields->>'reported_problem'),''),
   'created_from_fault_id',nullif(p_fields->>'created_from_fault_id','')::uuid)
 else jsonb_build_object(
   'farm_id',nullif(p_fields->>'farm_id','')::uuid,'machine_id',nullif(p_fields->>'machine_id','')::uuid,
   'workshop_id',nullif(p_fields->>'workshop_id','')::uuid,
   'kind',coalesce(p_fields->>'kind','repair'),'job_card_type',coalesce(p_fields->>'job_card_type','repair'),
   'priority',coalesce(p_fields->>'priority','normal'),'title',nullif(btrim(p_fields->>'title'),''),
   'description',nullif(btrim(p_fields->>'description'),''),
   'created_from_fault_id',nullif(p_fields->>'created_from_fault_id','')::uuid) end;
$$;
revoke execute on function app.intake_payload(text,jsonb) from public,anon;
grant execute on function app.intake_payload(text,jsonb) to authenticated,service_role;

create function public.app_guard_intake_receipt() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if tg_op='UPDATE' then
   if (new.intake_capture,new.intake_actor,new.intake_payload) is distinct from (old.intake_capture,old.intake_actor,old.intake_payload) then
     raise exception 'The creation receipt cannot be changed.' using errcode='23514';
   end if;
 elsif new.intake_capture is not null then
   if auth.uid() is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
   new.intake_actor:=auth.uid();
   new.intake_payload:=app.intake_payload(case when tg_table_name='job_cards' then 'job' else 'request' end,to_jsonb(new));
 elsif new.intake_actor is not null or new.intake_payload is not null then
   raise exception 'A capture ID is required.' using errcode='23514';
 end if;
 return new;
end $$;
revoke execute on function public.app_guard_intake_receipt() from public,anon,authenticated;
create trigger job_cards_intake_receipt before insert or update on public.job_cards for each row execute function public.app_guard_intake_receipt();
create trigger work_requests_intake_receipt before insert or update on public.work_requests for each row execute function public.app_guard_intake_receipt();

create function public.create_job_card_intake(p_capture uuid,p_job jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_role user_role; v_farm uuid; v_payload jsonb; v_id uuid; v_existing record;
begin
 if v_actor is null or p_capture is null or p_job is null or jsonb_typeof(p_job)<>'object' then
   raise exception 'Invalid job intake.' using errcode='22023'; end if;
 v_payload:=app.intake_payload('job',p_job);
 v_farm:=(v_payload->>'farm_id')::uuid;
 v_role:=app.effective_farm_role(v_actor,v_farm);
 if not coalesce(v_role in ('owner','manager','mechanic','rr_admin'),false) and app.current_app_role() is distinct from 'workshop' then
   raise exception 'Not permitted to create work.' using errcode='42501'; end if;
 if nullif(v_payload->>'reported_problem','') is null then raise exception 'Describe the required work.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('work-intake:'||p_capture::text,0));
 if exists(select 1 from public.work_requests where intake_capture=p_capture) then
   raise exception 'This capture was already saved with different intake details.' using errcode='23514'; end if;
 select id,intake_actor,intake_payload into v_existing from public.job_cards where intake_capture=p_capture and deleted_at is null;
 if found then
   if v_existing.intake_actor<>v_actor or v_existing.intake_payload is distinct from v_payload then
     raise exception 'This capture was already saved with different intake details.' using errcode='23514'; end if;
   return v_existing.id;
 end if;
 insert into public.job_cards(farm_id,machine_id,type,status,work_mode,workshop_id,external_provider_name,
   reported_problem,created_from_fault_id,mechanic_user_id,vat_rate_bps,date_in,intake_capture)
 values(v_farm,(v_payload->>'machine_id')::uuid,(v_payload->>'type')::job_card_type,'open',v_payload->>'work_mode',
   (v_payload->>'workshop_id')::uuid,v_payload->>'external_provider_name',v_payload->>'reported_problem',
   (v_payload->>'created_from_fault_id')::uuid,
   case when v_role='mechanic' or app.current_app_role()='workshop' then v_actor end,
   coalesce((p_job->>'vat_rate_bps')::int,1500),coalesce((p_job->>'date_in')::date,(now() at time zone 'Africa/Johannesburg')::date),p_capture)
 returning id into v_id;
 return v_id;
end $$;
revoke execute on function public.create_job_card_intake(uuid,jsonb) from public,anon;
grant execute on function public.create_job_card_intake(uuid,jsonb) to authenticated;

create function public.create_work_request_intake(p_capture uuid,p_request jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_farm uuid; v_payload jsonb; v_id uuid; v_existing record;
begin
 if v_actor is null or p_capture is null or p_request is null or jsonb_typeof(p_request)<>'object' then
   raise exception 'Invalid work intake.' using errcode='22023'; end if;
 v_payload:=app.intake_payload('request',p_request);
 v_farm:=(v_payload->>'farm_id')::uuid;
 if not coalesce(app.effective_farm_role(v_actor,v_farm) in ('owner','manager','rr_admin'),false) then
   raise exception 'Only the receiving farm can request work.' using errcode='42501'; end if;
 if v_payload->>'workshop_id' is null then raise exception 'Choose the contractor.' using errcode='22023'; end if;
 if coalesce(v_payload->>'description',v_payload->>'title') is null then raise exception 'Describe the required work.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('work-intake:'||p_capture::text,0));
 if exists(select 1 from public.job_cards where intake_capture=p_capture) then
   raise exception 'This capture was already saved with different intake details.' using errcode='23514'; end if;
 select id,intake_actor,intake_payload into v_existing from public.work_requests where intake_capture=p_capture and deleted_at is null;
 if found then
   if v_existing.intake_actor<>v_actor or v_existing.intake_payload is distinct from v_payload then
     raise exception 'This capture was already saved with different intake details.' using errcode='23514'; end if;
   return v_existing.id;
 end if;
 insert into public.work_requests(farm_id,machine_id,workshop_id,kind,job_card_type,priority,status,title,description,
   created_from_fault_id,vat_rate_bps,created_by,intake_capture)
 values(v_farm,(v_payload->>'machine_id')::uuid,(v_payload->>'workshop_id')::uuid,
   (v_payload->>'kind')::work_request_kind,(v_payload->>'job_card_type')::job_card_type,
   (v_payload->>'priority')::work_request_priority,'requested',v_payload->>'title',v_payload->>'description',
   (v_payload->>'created_from_fault_id')::uuid,coalesce((p_request->>'vat_rate_bps')::int,1500),v_actor,p_capture)
 returning id into v_id;
 insert into public.work_request_events(farm_id,work_request_id,from_status,to_status,note,by_user)
   values(v_farm,v_id,null,'requested',v_payload->>'description',v_actor);
 return v_id;
end $$;
revoke execute on function public.create_work_request_intake(uuid,jsonb) from public,anon;
grant execute on function public.create_work_request_intake(uuid,jsonb) to authenticated;

-- Keep the authorized projections column-compatible with their parent row types.
do $$ declare target text; projection text; begin
 foreach target in array array['job_cards','work_requests'] loop
   select string_agg(case when a.attname in ('parts_total_cents','labour_total_cents','other_total_cents','total_cents','quote_amount_cents','invoice_amount_cents')
     then format('case when %s then t.%I else null end as %I',
       case when target='work_requests' then '(app.can_view_farm_costs(t.farm_id) or t.workshop_id=app.user_workshop_id())' else 'app.can_view_farm_costs(t.farm_id)' end,a.attname,a.attname)
     else format('t.%I',a.attname) end,', ' order by a.attnum) into projection
   from pg_attribute a where a.attrelid=('public.'||target)::regclass and a.attnum>0 and not a.attisdropped;
   execute format('create or replace view public.%I with (security_barrier=true) as select %s from public.%I t',target||'_visible',projection,target);
 end loop;
end $$;
