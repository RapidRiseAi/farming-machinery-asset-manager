-- Separate operational work, farm review and the supplier's bill. All guards also
-- apply to direct API writes; the UI is not the authority for lifecycle changes.
alter table public.job_cards
  add column work_mode text not null default 'internal'
    check (work_mode in ('internal', 'external')),
  add column external_provider_name text,
  add column review_note text,
  add column completion_effects_recorded boolean not null default false,
  add column updated_at timestamptz not null default now();

-- Backfill without firing old approval locks or operational side effects.
alter table public.job_cards disable trigger user;
update public.job_cards set work_mode = 'external' where workshop_id is not null;
alter table public.job_cards enable trigger user;

grant select (work_mode, external_provider_name, review_note, completion_effects_recorded, updated_at)
  on public.job_cards to authenticated;

alter table public.work_requests add column created_from_fault_id uuid,
  add column job_card_type job_card_type not null default 'repair',
  add column invoice_from_documents boolean not null default false,
  add constraint work_requests_source_fault_fk foreign key (created_from_fault_id,farm_id,machine_id)
    references public.faults(id,farm_id,machine_id);
update public.work_requests set job_card_type='inspection' where kind='inspection';
grant select(created_from_fault_id,job_card_type) on public.work_requests to authenticated;
create unique index work_requests_one_live_source_fault on public.work_requests(created_from_fault_id)
  where created_from_fault_id is not null and deleted_at is null;

-- Acknowledging a fault must not make it impossible to schedule its repair.
do $$ declare definition text; begin
  definition := pg_get_functiondef('public.app_jobcard_fault_linked()'::regprocedure);
  if position('status in (''open'', ''in_job'')' in definition) = 0 then
    raise exception 'Fault-link validation insertion point changed';
  end if;
  execute replace(definition, 'status in (''open'', ''in_job'')',
    'status in (''open'', ''acknowledged'', ''in_progress'', ''in_job'')');
end $$;
do $$ declare v_select text; begin
  select string_agg(case when a.attname in
      ('parts_total_cents','labour_total_cents','other_total_cents','total_cents')
    then format('case when app.can_view_farm_costs(t.farm_id) then t.%I else null end as %I', a.attname, a.attname)
    else format('t.%I', a.attname) end, ', ' order by a.attnum)
    into v_select from pg_attribute a
    where a.attrelid = 'public.job_cards'::regclass and a.attnum > 0 and not a.attisdropped;
  execute 'create or replace view public.job_cards_visible with (security_barrier = true) as select '
    || v_select || ' from public.job_cards t';
end $$;

-- A stable capability used by write guards and atomic commands. It deliberately
-- takes the actor explicitly so the service-only offline command can use it too.
create or replace function app.job_card_worker(p_actor uuid, p_card uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.job_cards j
    join public.users actor on actor.id = p_actor and actor.active and actor.deleted_at is null
    left join public.user_farm_memberships membership on membership.user_id = actor.id
      and membership.farm_id = j.farm_id and membership.active and membership.deleted_at is null
    where j.id = p_card and j.deleted_at is null
      and (auth.uid() = p_actor or current_setting('role',true) = 'service_role') and (
      actor.role = 'rr_admin'
      or (actor.role <> 'workshop' and j.workshop_id is null
          and coalesce(membership.role, case when actor.farm_id = j.farm_id then actor.role end)
            in ('owner','manager','mechanic') and
          (j.work_mode = 'internal' or coalesce(membership.role,
            case when actor.farm_id = j.farm_id then actor.role end) in ('owner','manager')))
      or exists (select 1 from public.users u join public.workshop_links l
          on l.workshop_id = u.workshop_id and l.farm_id = j.farm_id
        where u.id = p_actor and u.active and u.deleted_at is null and u.role = 'workshop'
          and u.workshop_id = j.workshop_id and l.status = 'active' and l.deleted_at is null)
    ));
$$;
revoke execute on function app.job_card_worker(uuid, uuid) from public, anon;
grant execute on function app.job_card_worker(uuid, uuid) to authenticated, service_role;

create or replace function public.app_guard_jobcard_workflow() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role user_role; v_review boolean; v_meter meter_type; v_reading numeric; v_reading_date date;
begin
  v_role := app.effective_farm_role(auth.uid(), new.farm_id);
  -- Historical completions have no source keys or saved service baselines. Do
  -- not guess which old readings to retract, and do not let callers forge the
  -- marker. Only a completion executed by this version of the workflow sets it.
  if tg_op='INSERT' then
    new.completion_effects_recorded := false;
  elsif new.completion_effects_recorded is distinct from old.completion_effects_recorded then
    raise exception 'Completion history is managed by the job workflow.' using errcode='23514';
  end if;
  if new.mechanic_user_id is not null and (tg_op='INSERT' or new.mechanic_user_id is distinct from old.mechanic_user_id) then
    if not exists(select 1 from public.users u left join public.user_farm_memberships m
      on m.user_id=u.id and m.farm_id=new.farm_id and m.active and m.deleted_at is null
      where u.id=new.mechanic_user_id and u.active and u.deleted_at is null and (
        (new.workshop_id is not null and u.workshop_id=new.workshop_id and u.role='workshop')
        or (new.workshop_id is null and u.role<>'workshop'
          and (u.role='rr_admin' or coalesce(m.role,case when u.farm_id=new.farm_id then u.role end) in ('owner','manager','mechanic'))))) then
      raise exception 'Assign an active member of the team doing this work.' using errcode='23514';
    end if;
  end if;
  if tg_op='UPDATE' and auth.uid() is not null and new.mechanic_user_id is distinct from old.mechanic_user_id
    and not (coalesce(v_role in ('owner','manager','rr_admin'),false) or (app.current_app_role()='workshop' and app.user_workshop_id()=new.workshop_id)) then
    raise exception 'Only the responsible manager may assign this work.' using errcode='42501';
  end if;
  if new.work_mode = 'internal' and (new.workshop_id is not null or nullif(btrim(new.external_provider_name),'') is not null) then
    raise exception 'Internal work cannot have an external supplier.' using errcode = '23514';
  end if;
  if new.work_mode = 'external' and new.workshop_id is null and nullif(btrim(new.external_provider_name),'') is null then
    raise exception 'Name the external company doing this work.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.workshop_id is not null and not exists (select 1 from public.workshop_links l
    where l.farm_id = new.farm_id and l.workshop_id = new.workshop_id and l.status = 'active' and l.deleted_at is null) then
    raise exception 'The contractor is not connected to this farm.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null and (new.status not in ('reported','open') or new.locked
      or new.approved_by is not null or new.approved_at is not null) then
      raise exception 'Create an open job, record the work, then submit it for review.' using errcode = '23514';
    end if;
    if auth.uid() is not null and app.current_app_role() = 'workshop'
      and new.workshop_id is distinct from app.user_workshop_id() then
      raise exception 'Create a job card for your own company.' using errcode = '42501';
    end if;
    if auth.uid() is not null and v_role = 'mechanic' and new.work_mode <> 'internal' then
      raise exception 'Only an owner or manager can assign external work.' using errcode = '42501';
    end if;
    return new;
  end if;

  if (new.farm_id, new.machine_id, new.work_mode, new.workshop_id, new.external_provider_name,new.type,new.created_from_fault_id)
    is distinct from (old.farm_id, old.machine_id, old.work_mode, old.workshop_id, old.external_provider_name,old.type,old.created_from_fault_id) then
    raise exception 'The asset and provider are fixed on a job card. Create a separate job for different work.' using errcode = '23514';
  end if;
  v_review := old.status = 'completed' and new.status in ('approved','in_progress')
    and v_role in ('rr_admin','owner','manager');
  if auth.uid() is not null and not app.job_card_worker(auth.uid(), old.id) and not coalesce(v_review,false) then
    raise exception 'Only the assigned team may update this job card.' using errcode = '42501';
  end if;
  if old.status = 'completed' then
    if new.status not in ('approved','in_progress') then
      raise exception 'Review completed work or return it for correction before editing.' using errcode = '23514';
    end if;
    if not coalesce(v_review,false) then
      raise exception 'Only the farm owner or manager may review completed work.' using errcode = '42501';
    end if;
    if (to_jsonb(new) - array['status','approved_by','approved_at','locked','review_note','updated_at'])
      is distinct from (to_jsonb(old) - array['status','approved_by','approved_at','locked','review_note','updated_at']) then
      raise exception 'Review and editing are separate actions.' using errcode = '23514';
    end if;
    if new.status = 'in_progress' then
      if not old.completion_effects_recorded then
        raise exception 'This historical job has no reversible completion history. Record corrections on a new job card.' using errcode='23514';
      end if;
      if length(btrim(coalesce(new.review_note,''))) < 3 then
        raise exception 'Explain what needs correction.' using errcode = '23514';
      end if;
      if exists (select 1 from public.work_requests w where w.job_card_id = old.id
        and w.deleted_at is null and w.status in ('invoiced','closed'))
        or exists(select 1 from public.cost_entries c where c.source_type='job_card' and c.source_id=old.id and c.type='invoice' and c.deleted_at is null)
        or exists(select 1 from public.attachments a where a.parent_type='job_card' and a.parent_id=old.id and a.kind='invoice' and a.deleted_at is null) then
        raise exception 'The external work is already billed or closed.' using errcode = '23514';
      end if;
    end if;
  elsif new.status = 'approved' then
    raise exception 'Complete the job before approving it.' using errcode = '23514';
  elsif new.status is distinct from old.status and not (
    (old.status = 'reported' and new.status in ('open','in_progress'))
    or (old.status = 'open' and new.status = 'in_progress')
    or (old.status = 'in_progress' and new.status in ('waiting_parts','completed'))
    or (old.status = 'waiting_parts' and new.status = 'in_progress')
  ) then
    raise exception 'Invalid job-card transition.' using errcode = '23514';
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    if nullif(btrim(new.work_performed),'') is null then
      raise exception 'Record the work performed before completing the job.' using errcode = '23514';
    end if;
    select meter_type,current_reading,current_reading_date into v_meter,v_reading,v_reading_date
      from public.machines where id = new.machine_id for update;
    if new.type = 'scheduled_service' and v_meter <> 'none' and new.meter_reading is null then
      raise exception 'Record the service meter reading before completing the job.' using errcode = '23514';
    end if;
    if new.date_in is null or not isfinite(new.date_in) or new.date_out is null or new.date_out < new.date_in or new.date_out > (now() at time zone 'Africa/Johannesburg')::date then
      raise exception 'Enter a valid completion date.' using errcode = '23514';
    end if;
    if new.date_out>=v_reading_date and new.meter_reading<v_reading then
      raise exception 'A current or newer job reading cannot decrease the asset reading.' using errcode='23514';
    end if;
    new.completion_effects_recorded := true;
  end if;
  if new.meter_reading is not null and not (new.meter_reading between 0 and 99999999999.9) then raise exception 'Enter a valid meter reading.' using errcode = '23514'; end if;
  if new.status = 'approved' then
    new.locked := true;
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif new.locked or new.approved_by is not null or new.approved_at is not null then
    raise exception 'Approval fields require a completed job and farm review.' using errcode = '23514';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke execute on function public.app_guard_jobcard_workflow() from public, anon, authenticated;
create trigger job_cards_workflow before insert or update on public.job_cards
  for each row execute function public.app_guard_jobcard_workflow();

-- Lock the parent while changing children: completion and adding a part cannot
-- race. The previous lock trigger checked only NEW.parent, allowing moves out of
-- approved cards. Child parent identity is now immutable.
create or replace function public.app_enforce_jobcard_line_lock() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_card public.job_cards%rowtype; v_id uuid;
begin
  if tg_op = 'UPDATE' and (new.job_card_id,new.farm_id) is distinct from (old.job_card_id,old.farm_id) then
    raise exception 'A job-card line cannot be moved to another job.' using errcode = '23514';
  end if;
  v_id := case when tg_op = 'DELETE' then old.job_card_id else new.job_card_id end;
  select * into v_card from public.job_cards where id = v_id for update;
  if v_card.locked or v_card.status in ('completed','approved') or v_card.deleted_at is not null then
    raise exception 'This job is complete. Return it for correction before changing its work.' using errcode = '23514';
  end if;
  if auth.uid() is not null and not app.job_card_worker(auth.uid(), v_id) then
    raise exception 'Only the assigned team may change the work.' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
revoke execute on function public.app_enforce_jobcard_line_lock() from public, anon, authenticated;
create trigger job_card_service_lines_lock before insert or update or delete on public.job_card_service_lines
  for each row execute function public.app_enforce_jobcard_line_lock();

-- Service coverage is part of the work being submitted. A second session must
-- refresh before completing a card whose coverage changed after it was loaded.
create function public.app_job_service_version() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.job_cards set updated_at=clock_timestamp()
    where id=case when tg_op='DELETE' then old.job_card_id else new.job_card_id end;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke execute on function public.app_job_service_version() from public,anon,authenticated;
create trigger job_card_service_lines_version after insert or update or delete on public.job_card_service_lines
  for each row execute function public.app_job_service_version();

-- Completion records have a source key so a correction is an update to the same
-- event. Existing historical rows retain their IDs and are not guessed/backfilled.
alter table public.meter_readings add column source_job_card_id uuid unique,
  add constraint meter_readings_job_fk foreign key (source_job_card_id,farm_id,machine_id)
    references public.job_cards(id,farm_id,machine_id);
alter table public.usage_logs add column source_job_card_id uuid unique,
  add constraint usage_logs_job_fk foreign key (source_job_card_id,farm_id,machine_id)
    references public.job_cards(id,farm_id,machine_id);

-- Keep the pre-service state so returning work cannot leave a service falsely done.
alter table public.service_plan_lines add column last_job_card_id uuid references public.job_cards(id);
create table app.job_service_baselines (
  job_id uuid references public.job_cards(id), line_id uuid references public.service_plan_lines(id),
  reading numeric, done_on date, prior_job uuid references public.job_cards(id), primary key(job_id,line_id)
);
create table app.job_machine_baselines (machine_id uuid primary key references public.machines(id), reading numeric, reading_date date);
revoke all on app.job_service_baselines,app.job_machine_baselines from public,anon,authenticated;
create function public.app_service_job_source() returns trigger language plpgsql as $$
begin
  if (new.last_done_reading,new.last_done_date) is distinct from (old.last_done_reading,old.last_done_date)
    and new.last_job_card_id is not distinct from old.last_job_card_id then new.last_job_card_id := null; end if;
  return new;
end $$;
revoke execute on function public.app_service_job_source() from public,anon,authenticated;
create trigger service_plan_job_source before update on public.service_plan_lines for each row execute function public.app_service_job_source();

create or replace function public.app_jobcard_completed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_date date; v_line record; v_prior record; v_candidate record; v_reading numeric; v_reading_date date;
begin
  if old.status = 'completed' and new.status = 'in_progress' then
    -- A later service or a manually corrected baseline takes precedence.
    for v_line in select s.* from public.service_plan_lines s where s.last_job_card_id=new.id for update loop
      select * into v_prior from app.job_service_baselines where job_id=new.id and line_id=v_line.id;
      while v_prior.prior_job is not null and not exists(select 1 from public.job_cards j
        where j.id=v_prior.prior_job and j.status in ('completed','approved') and j.deleted_at is null) loop
        select * into v_prior from app.job_service_baselines where job_id=v_prior.prior_job and line_id=v_line.id;
        exit when not found;
      end loop;
      select j.id,j.date_out,j.meter_reading into v_candidate from public.job_cards j
        join public.job_card_service_lines l on l.job_card_id=j.id
        where l.service_plan_line_id=v_line.id and j.id<>new.id and j.status in ('completed','approved') and j.deleted_at is null
        order by j.date_out desc,j.updated_at desc limit 1;
      -- A source-free baseline can contain a manual correction or a meter
      -- replacement rebase. An old job on that same date must not undo it.
      if v_candidate.id is not null and (v_prior.done_on is null or v_candidate.date_out>v_prior.done_on
        or (v_candidate.date_out=v_prior.done_on and v_prior.prior_job is not null)) then
        update public.service_plan_lines set last_done_reading=v_candidate.meter_reading,last_done_date=v_candidate.date_out,last_job_card_id=v_candidate.id where id=v_line.id;
      else
        update public.service_plan_lines set last_done_reading=v_prior.reading,last_done_date=v_prior.done_on,last_job_card_id=v_prior.prior_job where id=v_line.id;
      end if;
    end loop;
    update public.meter_readings set deleted_at=now(),deleted_by=auth.uid() where source_job_card_id=new.id and deleted_at is null;
    update public.usage_logs set deleted_at=now(),deleted_by=auth.uid() where source_job_card_id=new.id and deleted_at is null;
    select reading,reading_date into v_reading,v_reading_date from app.machine_effective_reading(new.machine_id);
    if v_reading is null then
      select reading,reading_date into v_reading,v_reading_date from app.job_machine_baselines where machine_id=new.machine_id;
      if found then update public.machines set current_reading=v_reading,current_reading_date=v_reading_date where id=new.machine_id; end if;
    end if;
    update public.watch_items set deleted_at=now(),deleted_by=auth.uid() where source_job_card_id=new.id and deleted_at is null;
    update public.faults set status = 'in_job', resolved_at = null
      where id = new.created_from_fault_id and job_card_id = new.id and deleted_at is null;
    perform app.recalc_machine_service(new.machine_id);
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    v_date := new.date_out;
    insert into app.job_machine_baselines select id,current_reading,current_reading_date from public.machines m
      where m.id=new.machine_id and not exists(select 1 from public.meter_readings r where r.machine_id=m.id and r.deleted_at is null)
      on conflict(machine_id) do nothing;
    insert into app.job_service_baselines
      select new.id,s.id,s.last_done_reading,s.last_done_date,s.last_job_card_id from public.service_plan_lines s
        join public.job_card_service_lines l on l.service_plan_line_id=s.id where l.job_card_id=new.id
      on conflict(job_id,line_id) do update set reading=excluded.reading,done_on=excluded.done_on,prior_job=null
        -- Preserve the original source chain when jobs are corrected out of
        -- order. Only a source-free baseline is safe to refresh on re-submission:
        -- it captures new manual corrections without creating cyclic job links.
        where excluded.prior_job is null;
    update public.service_plan_lines spl
      set last_done_reading = new.meter_reading, last_done_date = v_date,last_job_card_id=new.id
      from public.job_card_service_lines l
      where l.job_card_id = new.id and l.service_plan_line_id = spl.id
        and l.farm_id = new.farm_id and l.machine_id = new.machine_id
        and spl.deleted_at is null and (spl.last_done_date is null or spl.last_done_date <= v_date);
    if new.meter_reading is not null then
      insert into public.meter_readings (farm_id,machine_id,reading,reading_date,source,by_user,source_job_card_id)
        values (new.farm_id,new.machine_id,new.meter_reading,v_date,'job',new.mechanic_user_id,new.id)
        on conflict (source_job_card_id) do update set reading = excluded.reading,
          reading_date = excluded.reading_date, by_user = excluded.by_user,deleted_at=null,deleted_by=null;
      update public.machines set current_reading = new.meter_reading,current_reading_date = v_date
        where id = new.machine_id and (current_reading_date is null or current_reading_date <= v_date)
          and (current_reading is null or current_reading <= new.meter_reading);
    end if;
    perform app.recalc_machine_service(new.machine_id);
    if nullif(btrim(new.recommendations),'') is not null then
      update public.watch_items set text = new.recommendations,deleted_at=null,deleted_by=null where source_job_card_id = new.id;
      if not found then
        insert into public.watch_items(farm_id,machine_id,source_job_card_id,text,status)
          values(new.farm_id,new.machine_id,new.id,new.recommendations,'open');
      end if;
    end if;
    update public.faults set status = 'resolved',resolved_at = now()
      where id = new.created_from_fault_id and job_card_id = new.id and deleted_at is null;
  end if;
  return new;
end $$;
create or replace function public.app_jobcard_usage_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'completed' and old.status <> 'completed' and new.meter_reading is not null then
    insert into public.usage_logs(farm_id,machine_id,driver_user_id,occurred_on,meter_reading,source,note,source_job_card_id)
      values(new.farm_id,new.machine_id,new.mechanic_user_id,new.date_out,new.meter_reading,'job','Job card completion',new.id)
      on conflict(source_job_card_id) do update set meter_reading = excluded.meter_reading,
        occurred_on = excluded.occurred_on,driver_user_id = excluded.driver_user_id,deleted_at=null,deleted_by=null;
  end if;
  return new;
end $$;
revoke execute on function public.app_jobcard_completed(), public.app_jobcard_usage_log() from public, anon, authenticated;

create or replace function public.app_guard_work_request_workflow() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_farm boolean; v_provider boolean; v_role user_role; v_job public.job_cards%rowtype;
  v_supplied_quote boolean; v_supplied_invoice boolean;
begin
  if auth.uid() is not null and pg_trigger_depth()<=1 and
    ((tg_op='INSERT' and new.invoice_from_documents) or (tg_op='UPDATE' and new.invoice_from_documents is distinct from old.invoice_from_documents)) then
    raise exception 'Invoice provenance is maintained by supplier documents.' using errcode='42501';
  end if;
  if tg_op='UPDATE' and pg_trigger_depth()>1 and new.invoice_from_documents
    and old.status in ('completed','invoiced','closed')
    and (to_jsonb(new)-array['invoice_from_documents','invoice_amount_cents','status','updated_at'])
      is not distinct from (to_jsonb(old)-array['invoice_from_documents','invoice_amount_cents','status','updated_at'])
    and ((old.status='closed' and new.status='closed') or (old.status<>'closed' and new.status in ('completed','invoiced'))) then
    new.updated_at:=clock_timestamp(); return new;
  end if;
  if tg_op = 'UPDATE' and (new.created_from_fault_id,new.job_card_type)
    is distinct from (old.created_from_fault_id,old.job_card_type) then
    raise exception 'The source fault and work type are fixed on a work request.' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' and new.created_from_fault_id is not null then
    perform id from public.faults where id = new.created_from_fault_id and farm_id = new.farm_id
      and machine_id = new.machine_id and deleted_at is null and status <> 'resolved'
      and job_card_id is null for update;
    if not found then raise exception 'The source fault is unavailable or already has a job card.' using errcode = '23514'; end if;
  end if;
  v_role := app.effective_farm_role(auth.uid(), new.farm_id);
  v_farm := coalesce(v_role in ('rr_admin','owner','manager'),false);
  v_provider := app.current_app_role() = 'workshop' and new.workshop_id = app.user_workshop_id();
  v_supplied_quote := v_farm and exists(select 1 from public.partner_documents d
    where d.work_request_id = new.id and d.workshop_id = new.workshop_id and d.source = 'uploaded'
      and d.kind = 'quote' and d.status in ('sent','accepted') and d.deleted_at is null
      and greatest(0,d.subtotal_cents-d.discount_cents) = new.quote_amount_cents);
  v_supplied_invoice := v_farm and exists(select 1 from public.partner_documents d
    where d.work_request_id = new.id and d.workshop_id = new.workshop_id and d.source = 'uploaded'
      and d.kind = 'invoice' and d.status in ('sent','part_paid','paid','written_off') and d.deleted_at is null
      and greatest(0,d.subtotal_cents-d.discount_cents) = new.invoice_amount_cents);
  if new.job_card_id is not null then
    select * into v_job from public.job_cards where id = new.job_card_id;
    if (v_job.farm_id,v_job.machine_id,v_job.workshop_id,v_job.work_mode)
      is distinct from (new.farm_id,new.machine_id,new.workshop_id,'external'::text) then
      raise exception 'The external job must match the request asset and contractor.' using errcode = '23514';
    end if;
  end if;
  -- Service-only imports retain their old call contract. Online callers, including
  -- SECURITY DEFINER RPC callers, still have auth.uid() and pass every check below.
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if not v_farm or new.status <> 'requested' or new.quote_amount_cents is not null or new.invoice_amount_cents is not null then
      raise exception 'Farm owners and managers request work; the provider supplies prices.' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.farm_id,new.machine_id) is distinct from (old.farm_id,old.machine_id) then
    raise exception 'The request asset and provider are fixed.' using errcode = '23514';
  end if;
  if new.workshop_id is distinct from old.workshop_id and not (
    old.workshop_id is null and old.status = 'requested' and old.job_card_id is null
    and v_farm and exists(select 1 from public.workshop_links l where l.farm_id=new.farm_id
      and l.workshop_id=new.workshop_id and l.status='active' and l.deleted_at is null)
  ) then raise exception 'Only a requested, unassigned job can be assigned to a connected provider.' using errcode = '23514'; end if;
  if old.job_card_id is not null and new.job_card_id is distinct from old.job_card_id then
    raise exception 'The request already has a job card.' using errcode = '23514';
  end if;
  if old.status = 'closed' and (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    -- Attaching the first historical job does not reopen a closed invoice/request.
    if old.job_card_id is not null or (to_jsonb(new) - array['job_card_id','updated_at'])
      is distinct from (to_jsonb(old) - array['job_card_id','updated_at']) then
      raise exception 'This work request is closed.' using errcode = '23514';
    end if;
  end if;
  if new.quote_amount_cents is distinct from old.quote_amount_cents then
    if not (coalesce(v_provider,false) or v_supplied_quote) or old.status not in ('requested','viewed','quoted')
      or new.status <> 'quoted' or new.quote_amount_cents < 0 or new.quote_amount_cents is null then
      raise exception 'Only the assigned contractor may quote before acceptance.' using errcode = '42501';
    end if;
  end if;
  if new.invoice_amount_cents is distinct from old.invoice_amount_cents then
    if not (coalesce(v_provider,false) or v_supplied_invoice) or old.status not in ('completed','invoiced')
      or new.status <> 'invoiced' or new.invoice_amount_cents < 0 or new.invoice_amount_cents is null then
      raise exception 'Only the assigned contractor may invoice completed work.' using errcode = '42501';
    end if;
  end if;
  if new.status is distinct from old.status then
    if not (
      (old.status = 'requested' and new.status = 'viewed' and coalesce(v_provider,false))
      or (old.status in ('requested','viewed','quoted') and new.status = 'quoted' and (coalesce(v_provider,false) or v_supplied_quote) and new.quote_amount_cents is not null)
      or (old.status in ('requested','viewed','quoted') and new.status = 'accepted' and v_farm and new.workshop_id is not null)
      or (old.status = 'accepted' and new.status = 'in_progress' and coalesce(v_provider,false))
      or (old.status in ('accepted','in_progress') and new.status = 'completed' and coalesce(v_provider,false)
          and (old.status = 'in_progress' or v_job.status in ('completed','approved')))
      or (old.status in ('completed','invoiced') and new.status = 'invoiced' and (coalesce(v_provider,false) or v_supplied_invoice) and new.invoice_amount_cents is not null)
      or (old.status = 'invoiced' and new.status = 'closed' and v_farm)
      or (old.status = 'completed' and new.status = 'in_progress' and v_farm and v_job.status = 'in_progress')
    ) then raise exception 'This work-request action is not available at the current stage.' using errcode = '42501'; end if;
    if new.status = 'accepted' and exists(select 1 from public.partner_documents d
      where d.work_request_id = new.id and d.kind = 'quote' and d.status = 'sent' and d.deleted_at is null) then
      raise exception 'Accept the supplied quote before authorizing work.' using errcode = '23514';
    end if;
    if new.status in ('completed','invoiced','closed') and v_job.id is not null and v_job.status not in ('completed','approved') then
      raise exception 'Complete the linked job card first.' using errcode = '23514';
    end if;
    if new.status = 'closed' and v_job.id is not null and v_job.status <> 'approved' then
      raise exception 'Approve the linked job card before closing the request.' using errcode = '23514';
    end if;
  end if;
  new.updated_at := clock_timestamp();
  return new;
end $$;
revoke execute on function public.app_guard_work_request_workflow() from public, anon, authenticated;
create trigger work_requests_workflow before insert or update on public.work_requests
  for each row execute function public.app_guard_work_request_workflow();

create or replace function public.update_work_request(
  p_request uuid, p_status text default null, p_quote_cents bigint default null,
  p_invoice_cents bigint default null, p_note text default null
) returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_before public.work_requests%rowtype; v_after public.work_requests%rowtype;
begin
  -- Read amounts through the authorized projection; raw amount columns intentionally
  -- have no authenticated SELECT grant. The row lock itself uses safe columns.
  perform id from public.work_requests where id = p_request and deleted_at is null for update;
  if not found then raise exception 'Work request not found.' using errcode = 'P0002'; end if;
  select * into v_before from public.work_requests_visible where id = p_request;
  if auth.uid() is null or not app.has_farm_access(v_before.farm_id) then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if p_status = 'closed' and v_before.status = 'invoiced' and v_before.job_card_id is not null then
    update public.job_cards set status = 'approved'
      where id = v_before.job_card_id and status = 'completed';
  end if;
  update public.work_requests set
    status = case when p_status is not null then p_status::work_request_status
      when p_quote_cents is not null then 'quoted'::work_request_status
      when p_invoice_cents is not null then 'invoiced'::work_request_status else status end,
    quote_amount_cents = case when p_quote_cents is not null then p_quote_cents else v_before.quote_amount_cents end,
    invoice_amount_cents = case when p_invoice_cents is not null then p_invoice_cents else v_before.invoice_amount_cents end
    where id = p_request;
  if not found then raise exception 'Work request was not updated.' using errcode = '42501'; end if;
  select * into v_after from public.work_requests_visible where id = p_request;
  insert into public.work_request_events(farm_id,work_request_id,from_status,to_status,note,by_user)
    values(v_before.farm_id,p_request,v_before.status,v_after.status,nullif(btrim(p_note),''),auth.uid());
  return p_request;
end $$;
revoke execute on function public.update_work_request(uuid,text,bigint,bigint,text) from public, anon;
grant execute on function public.update_work_request(uuid,text,bigint,bigint,text) to authenticated;

create or replace function public.convert_work_request_to_job_card(p_request uuid)
returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_request public.work_requests%rowtype; v_id uuid; v_role user_role; v_fault uuid; v_type job_card_type;
begin
  perform id from public.work_requests where id = p_request and deleted_at is null for update;
  if not found then raise exception 'Work request not found.' using errcode = 'P0002'; end if;
  select * into v_request from public.work_requests_visible where id = p_request;
  select created_from_fault_id,job_card_type into v_fault,v_type from public.work_requests where id = p_request;
  v_role := app.effective_farm_role(auth.uid(),v_request.farm_id);
  if auth.uid() is null or not (
    coalesce(v_role in ('rr_admin','owner','manager'),false)
    or (app.current_app_role() = 'workshop' and v_request.workshop_id = app.user_workshop_id())
  ) then raise exception 'Not permitted to create this job card.' using errcode = '42501'; end if;
  if v_request.job_card_id is not null then return v_request.job_card_id; end if;
  if v_request.workshop_id is null or v_request.status not in ('accepted','in_progress') then
    raise exception 'Accept and assign the request before creating its job card.' using errcode = '23514';
  end if;
  insert into public.job_cards(farm_id,machine_id,type,status,date_in,reported_problem,
    workshop_id,work_mode,mechanic_user_id,created_from_fault_id)
    values(v_request.farm_id,v_request.machine_id,
      v_type,
      'open',(now() at time zone 'Africa/Johannesburg')::date,
      concat_ws(E'\n',nullif(v_request.title,''),nullif(v_request.description,'')),
      v_request.workshop_id,'external',case when app.current_app_role() = 'workshop' then auth.uid() end,v_fault)
    returning id into v_id;
  update public.work_requests set job_card_id = v_id where id = p_request;
  if not found then raise exception 'The job-card link could not be saved.' using errcode = '42501'; end if;
  return v_id;
end $$;
revoke execute on function public.convert_work_request_to_job_card(uuid) from public, anon;
grant execute on function public.convert_work_request_to_job_card(uuid) to authenticated;

create or replace function public.app_jobcard_request_progress() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_request record; v_next work_request_status;
begin
  if new.status is not distinct from old.status then return new; end if;
  for v_request in select id,farm_id,status from public.work_requests
    where job_card_id = new.id and deleted_at is null and status not in ('invoiced','closed') for update loop
    v_next := null;
    if new.status = 'completed' and v_request.status in ('accepted','in_progress') then v_next := 'completed';
    elsif new.status in ('in_progress','waiting_parts') and v_request.status in ('accepted','completed') then v_next := 'in_progress';
    end if;
    if v_next is not null then
      update public.work_requests set status = v_next where id = v_request.id;
      insert into public.work_request_events(farm_id,work_request_id,from_status,to_status,note,by_user)
        values(v_request.farm_id,v_request.id,v_request.status,v_next,
          case when old.status = 'completed' then new.review_note else 'Updated from the linked job card.' end,auth.uid());
    end if;
  end loop;
  return new;
end $$;
revoke execute on function public.app_jobcard_request_progress() from public, anon, authenticated;
create trigger job_cards_request_progress after update on public.job_cards
  for each row execute function public.app_jobcard_request_progress();

-- External line items describe the work. Once a supplier bill exists, that bill
-- owns the cost; otherwise the lines remain the best available cost estimate.
-- Reconcile derived rows only, leaving approved cards and their work untouched.
create or replace function app.reconcile_job_card_costs(p_card uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_card public.job_cards%rowtype; v_invoiced boolean; v_line record;
begin
  select * into v_card from public.job_cards where id = p_card;
  if not found then return; end if;
  v_invoiced := v_card.work_mode = 'external' and (
    exists(select 1 from public.cost_entries c where c.source_type = 'job_card'
      and c.source_id = p_card and c.type = 'invoice' and c.deleted_at is null)
    or exists(select 1 from public.work_requests w where w.job_card_id = p_card and w.deleted_at is null
      and (w.invoice_amount_cents is not null or exists(select 1 from public.partner_documents d
        where d.work_request_id = w.id and d.kind = 'invoice' and d.deleted_at is null
          and d.status in ('sent','part_paid','paid','written_off'))))
  );
  for v_line in select * from public.job_card_lines where job_card_id = p_card loop
    if v_invoiced or v_card.deleted_at is not null or v_line.deleted_at is not null then
      update public.cost_entries set deleted_at = coalesce(deleted_at,now())
        where source_type = 'job_card_line' and source_id = v_line.id and deleted_at is null;
    else
      update public.cost_entries set deleted_at = null,deleted_by = null,
        amount_cents = v_line.total_cents,
        occurred_on = coalesce(v_card.date_out,v_card.date_in,v_card.created_at::date)
        where source_type = 'job_card_line' and source_id = v_line.id;
    end if;
  end loop;
end $$;
revoke execute on function app.reconcile_job_card_costs(uuid) from public, anon, authenticated;

create or replace function public.app_job_card_cost_reconcile() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_row jsonb;
begin
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  if tg_table_name = 'job_card_lines' then v_id := (v_row->>'job_card_id')::uuid;
  elsif tg_table_name = 'work_requests' then v_id := (v_row->>'job_card_id')::uuid;
  elsif tg_table_name = 'partner_documents' then
    select job_card_id into v_id from public.work_requests where id = (v_row->>'work_request_id')::uuid;
  elsif tg_table_name = 'cost_entries' and v_row->>'source_type' = 'job_card' then
    v_id := (v_row->>'source_id')::uuid;
  end if;
  if v_id is not null then perform app.reconcile_job_card_costs(v_id); end if;
  return null;
end $$;
revoke execute on function public.app_job_card_cost_reconcile() from public, anon, authenticated;
create trigger job_card_lines_zz_cost_reconcile after insert or update or delete on public.job_card_lines
  for each row execute function public.app_job_card_cost_reconcile();
create trigger work_requests_zz_cost_reconcile after insert or update or delete on public.work_requests
  for each row execute function public.app_job_card_cost_reconcile();
create trigger partner_documents_zz_cost_reconcile after insert or update or delete on public.partner_documents
  for each row execute function public.app_job_card_cost_reconcile();
create trigger cost_entries_zz_job_reconcile after insert or update or delete on public.cost_entries
  for each row execute function public.app_job_card_cost_reconcile();

create or replace function public.app_job_card_invoice_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_card public.job_cards%rowtype; v_role user_role;
begin
  if new.source_type = 'job_card' and new.type = 'invoice' and new.deleted_at is null then
    select * into v_card from public.job_cards where id = new.source_id;
    if v_card.id is null or v_card.farm_id <> new.farm_id or v_card.machine_id is distinct from new.machine_id
      or v_card.work_mode <> 'external' then
      raise exception 'An internal job records costs, not an invoice.' using errcode = '23514';
    end if;
    if v_card.status not in ('completed','approved') or new.amount_cents < 0 then
      raise exception 'Complete the external work before recording its supplier invoice.' using errcode = '23514';
    end if;
    if auth.uid() is not null then
      v_role := app.effective_farm_role(auth.uid(),v_card.farm_id);
      if not (coalesce(v_role = 'rr_admin',false)
        or (v_card.workshop_id is null and coalesce(v_role in ('owner','manager'),false))
        or (app.current_app_role() = 'workshop' and v_card.workshop_id = app.user_workshop_id())) then
        raise exception 'Only the supplier or the receiving farm for an outside company can record its invoice.' using errcode = '42501';
      end if;
    end if;
    if exists(select 1 from public.work_requests w where w.job_card_id = v_card.id and w.deleted_at is null) then
      raise exception 'Record this supplier invoice on the linked work request.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.app_job_card_invoice_guard() from public, anon, authenticated;
create trigger cost_entries_job_card_invoice before insert or update on public.cost_entries
  for each row execute function public.app_job_card_invoice_guard();

-- Durable receipts unify online retries and an offline retry of the same draft.
alter table public.job_card_lines add column updated_at timestamptz not null default now();
grant select(updated_at) on public.job_card_lines to authenticated;
create function public.app_job_line_version() returns trigger language plpgsql as $$
begin new.updated_at := clock_timestamp(); return new; end $$;
revoke execute on function public.app_job_line_version() from public,anon,authenticated;
create trigger job_card_lines_version before update on public.job_card_lines
  for each row execute function public.app_job_line_version();
do $$ declare v_select text; begin
  select string_agg(case when a.attname in ('unit_cost_cents','rate_cents','total_cents')
    then format('case when app.can_view_farm_costs(t.farm_id) then t.%I else null end as %I',a.attname,a.attname)
    else format('t.%I',a.attname) end, ', ' order by a.attnum) into v_select
    from pg_attribute a where a.attrelid='public.job_card_lines'::regclass and a.attnum>0 and not a.attisdropped;
  execute 'create or replace view public.job_card_lines_visible with (security_barrier=true) as select '||v_select||' from public.job_card_lines t';
end $$;

create table public.job_card_line_receipts (
  id uuid primary key,
  farm_id uuid not null,
  job_card_id uuid not null,
  actor_id uuid not null references public.users(id),
  payload jsonb not null,
  line_id uuid not null references public.job_card_lines(id),
  foreign key(job_card_id,farm_id) references public.job_cards(id,farm_id)
);
alter table public.job_card_line_receipts enable row level security;
grant select,insert on public.job_card_line_receipts to authenticated;
grant all on public.job_card_line_receipts to service_role;
create policy job_line_receipt_own on public.job_card_line_receipts for select to authenticated
  using(actor_id=auth.uid() and app.job_card_worker(auth.uid(),job_card_id));
create policy job_line_receipt_insert on public.job_card_line_receipts for insert to authenticated
  with check(actor_id=auth.uid() and app.job_card_worker(auth.uid(),job_card_id));

create function public.record_job_card_line(p_job uuid,p_capture uuid,p_line jsonb,p_actor uuid default null)
returns uuid language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_actor uuid := coalesce(p_actor,auth.uid()); v_farm uuid; v_old public.job_card_line_receipts%rowtype;
  v_kind job_line_kind; v_qty numeric; v_hours numeric; v_cost bigint; v_rate bigint; v_payload jsonb;
begin
  if v_actor is null or (auth.uid() is distinct from v_actor and current_setting('role',true)<>'service_role')
    or not app.job_card_worker(v_actor,p_job) then raise exception 'forbidden' using errcode='42501'; end if;
  select farm_id into v_farm from public.job_cards where id=p_job and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  if p_capture is null or p_line is null or jsonb_typeof(p_line)<>'object' then raise exception 'bad_line' using errcode='22023'; end if;
  v_kind := (p_line->>'kind')::job_line_kind;
  v_qty := (p_line->>'qty')::numeric; v_hours := (p_line->>'hours')::numeric;
  v_cost := (p_line->>'unit_cost_cents')::bigint; v_rate := (p_line->>'rate_cents')::bigint;
  if v_kind is null or (nullif(btrim(p_line->>'description'),'') is null and
      (v_kind<>'part' or nullif(btrim(p_line->>'part_no'),'') is null))
    or length(coalesce(p_line->>'description',''))>2000 or length(coalesce(p_line->>'part_no',''))>200
    or (v_kind='part' and (v_qty is null or not(v_qty>0 and v_qty<1e10) or v_qty<>round(v_qty,2)))
    or (v_kind='labour' and (v_hours is null or not(v_hours>0 and v_hours<1e10) or v_hours<>round(v_hours,2)))
    or coalesce(v_cost,0)<0 or coalesce(v_rate,0)<0 then raise exception 'bad_line' using errcode='22023'; end if;
  v_payload := jsonb_build_object('kind',v_kind,'description',nullif(btrim(p_line->>'description'),''),
    'part_no',case when v_kind='part' then nullif(btrim(p_line->>'part_no'),'') end,
    'qty',case when v_kind='part' then v_qty end,'hours',case when v_kind='labour' then v_hours end,
    'unit_cost_cents',case when v_kind<>'labour' then v_cost end,'rate_cents',case when v_kind='labour' then v_rate end);
  select * into v_old from public.job_card_line_receipts where id=p_capture;
  if found then
    if v_old.job_card_id<>p_job or v_old.actor_id<>v_actor or v_old.payload<>v_payload then
      raise exception 'Capture ID already used for different work.' using errcode='23514'; end if;
    if not exists(select 1 from public.job_card_lines where id=v_old.line_id and job_card_id=p_job and deleted_at is null) then
      raise exception 'This saved line was removed. Refresh the job card before adding it again.' using errcode='23514'; end if;
    return v_old.line_id;
  end if;
  insert into public.job_card_lines(id,farm_id,job_card_id,kind,description,part_no,qty,unit_cost_cents,hours,rate_cents)
    values(p_capture,v_farm,p_job,v_kind,v_payload->>'description',v_payload->>'part_no',
      (v_payload->>'qty')::numeric,(v_payload->>'unit_cost_cents')::bigint,
      (v_payload->>'hours')::numeric,(v_payload->>'rate_cents')::bigint);
  insert into public.job_card_line_receipts values(p_capture,v_farm,p_job,v_actor,v_payload,p_capture);
  return p_capture;
end $$;
revoke execute on function public.record_job_card_line(uuid,uuid,jsonb,uuid) from public,anon;
grant execute on function public.record_job_card_line(uuid,uuid,jsonb,uuid) to authenticated,service_role;

-- Retiring a line cannot use a direct UPDATE: its SELECT policy intentionally
-- hides deleted rows. Keep that policy and expose only this checked operation.
create function public.remove_job_card_line(p_job uuid,p_line uuid,p_version timestamptz) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare card public.job_cards%rowtype; item public.job_card_lines%rowtype;
begin
  if auth.uid() is null or not app.job_card_worker(auth.uid(),p_job) then
    raise exception 'forbidden' using errcode='42501'; end if;
  select * into card from public.job_cards where id=p_job and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  select * into item from public.job_card_lines where id=p_line and job_card_id=p_job and farm_id=card.farm_id for update;
  if not found then return false; end if;
  if item.deleted_at is not null then return true; end if;
  if card.locked or card.status in ('completed','approved') then
    raise exception 'The work record is complete.' using errcode='23514'; end if;
  if p_version is null or item.updated_at is distinct from p_version then return false; end if;
  update public.job_card_lines set deleted_at=clock_timestamp(),deleted_by=auth.uid() where id=p_line;
  return true;
end $$;
revoke execute on function public.remove_job_card_line(uuid,uuid,timestamptz) from public,anon;
grant execute on function public.remove_job_card_line(uuid,uuid,timestamptz) to authenticated;

create function public.apply_job_card_kit(p_job uuid,p_kit uuid,p_capture uuid) returns integer
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_farm uuid; v_machine uuid; item record; n integer:=0;
begin
  select farm_id,machine_id into v_farm,v_machine from public.job_cards where id=p_job and deleted_at is null for update;
  if not found or auth.uid() is null or not app.job_card_worker(auth.uid(),p_job)
    or not app.can_view_farm_costs(v_farm) then raise exception 'forbidden' using errcode='42501'; end if;
  if p_capture is null or not exists(select 1 from public.service_kits k join public.machines m on m.id=v_machine
    where k.id=p_kit and k.farm_id=v_farm and k.deleted_at is null
      and (k.machine_id=v_machine or (k.machine_id is null and k.machine_type=m.type))) then
    raise exception 'not_found' using errcode='P0002'; end if;
  for item in select * from public.service_kit_items_visible where service_kit_id=p_kit and farm_id=v_farm and deleted_at is null loop
    perform public.record_job_card_line(p_job,md5(p_capture::text||item.id::text)::uuid,
      jsonb_build_object('kind','part','description',item.description,'part_no',item.part_no,'qty',coalesce(item.qty,1),'unit_cost_cents',item.unit_cost_cents));
    n:=n+1;
  end loop;
  if n=0 then raise exception 'The kit has no items.' using errcode='23514'; end if;
  return n;
end $$;
revoke execute on function public.apply_job_card_kit(uuid,uuid,uuid) from public,anon;
grant execute on function public.apply_job_card_kit(uuid,uuid,uuid) to authenticated;

-- Preserve the service-only offline signature while closing its old broader
-- workshop permission. It runs without a user JWT, so its explicit actor must be
-- validated before any job-card mutation. Late line captures become conflicts.
do $$ declare v_definition text; v_old text; begin
  v_definition := pg_get_functiondef('public.apply_offline_capture(uuid,timestamp with time zone,text,text,uuid,jsonb)'::regprocedure);
  v_old := '  v_hash := encode(sha256(convert_to(p_fields::text, ''UTF8'')), ''hex'');';
  if position(v_old in v_definition) = 0 then raise exception 'Offline capture validation insertion point changed'; end if;
  v_definition := replace(v_definition,v_old,
    '  if p_type in (''add_job_line'',''complete_job'') and not app.job_card_worker(p_actor,v_card.id) then
       raise exception ''forbidden'' using errcode = ''42501'';
     end if;
' || v_old);
  v_definition := replace(v_definition,'if v_card.locked then v_status := ''conflict'';',
    'if v_card.locked or v_card.status in (''completed'',''approved'') then v_status := ''conflict'';');
  v_old := $old$      insert into public.job_card_lines(farm_id,job_card_id,kind,description,part_no,qty,unit_cost_cents,hours,rate_cents)
      values(v_card.farm_id,v_card.id,v_kind,nullif(p_fields->>'description',''),nullif(p_fields->>'part_no',''),
        case when v_kind = 'part' then v_qty end,case when v_kind <> 'labour' then v_cost end,
        case when v_kind = 'labour' then v_hours end,case when v_kind = 'labour' then v_rate end)
      returning id into v_id;$old$;
  if position(v_old in v_definition)=0 then raise exception 'Offline line contract changed'; end if;
  v_definition := replace(v_definition,v_old,$new$      v_id := public.record_job_card_line(v_card.id,
        coalesce(nullif(p_fields->>'draft_token','')::uuid,p_client),
        jsonb_build_object('kind',v_kind,'description',p_fields->>'description','part_no',p_fields->>'part_no',
          'qty',v_qty,'unit_cost_cents',v_cost,'hours',v_hours,'rate_cents',v_rate),p_actor);$new$);
  v_old := $old$    if not v_card.locked and v_card.status not in ('completed','approved') then
      v_reading := coalesce(nullif(p_fields->>'meter_reading','')::numeric,v_card.meter_reading);$old$;
  if position(v_old in v_definition)=0 then raise exception 'Offline completion contract changed'; end if;
  v_definition := replace(v_definition,v_old,$new$    if v_card.locked or v_card.status <> 'in_progress'
      or nullif(btrim(v_card.work_performed),'') is null
      or (nullif(p_fields->>'updated_at','') is not null
        and (p_fields->>'updated_at')::timestamptz is distinct from v_card.updated_at) then
      v_status := 'conflict';
    else
      v_date := coalesce(v_card.date_out,v_today);
      v_reading := case when nullif(p_fields->>'updated_at','') is not null then v_card.meter_reading
        else coalesce(nullif(p_fields->>'meter_reading','')::numeric,v_card.meter_reading) end;$new$);
  v_definition := replace(v_definition,'and current_date >= coalesce(v_machine.current_reading_date,current_date) then',
    'and v_date >= coalesce(v_machine.current_reading_date,v_date) then');
  v_definition := replace(v_definition,'set status = ''completed'',date_out = current_date,meter_reading = v_reading',
    'set status = ''completed'',date_out = v_date,meter_reading = v_reading');
  execute v_definition;
end $$;

-- A provider may build its own quote/invoice, or the farm may file a supplied
-- document. Both routes must refer to the same request and advance its stage.
create or replace function public.app_document_work_request_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_request public.work_requests%rowtype;
begin
  if new.work_request_id is null then return new; end if;
  select * into v_request from public.work_requests where id = new.work_request_id and deleted_at is null for update;
  if not found or (new.farm_id,new.workshop_id,new.machine_id)
    is distinct from (v_request.farm_id,v_request.workshop_id,v_request.machine_id) then
    raise exception 'The document must name the request farm, asset and assigned contractor.' using errcode = '23514';
  end if;
  if auth.uid() is not null and new.source = 'built' and new.status <> 'draft'
    and (tg_op = 'INSERT' or old.status = 'draft')
    and not (app.current_app_role() = 'workshop' and app.user_workshop_id() = new.workshop_id)
    and not app.is_rr_admin() then
    raise exception 'The supplier issues its own documents. Upload a received document instead.' using errcode = '42501';
  end if;
  if new.kind = 'invoice' and new.status in ('sent','part_paid','paid','written_off')
    and (tg_op = 'INSERT' or old.status = 'draft') and v_request.status not in ('completed','invoiced') then
    raise exception 'Complete the work before issuing its final invoice.' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.app_document_work_request_guard() from public, anon, authenticated;
create trigger partner_documents_work_request_guard before insert or update on public.partner_documents
  for each row execute function public.app_document_work_request_guard();

create or replace function public.app_document_work_request_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_request public.work_requests%rowtype; v_next work_request_status; v_amount bigint; v_count integer;
begin
  if new.work_request_id is null then return new; end if;
  select * into v_request from public.work_requests where id = new.work_request_id for update;
  if new.kind='invoice' and (v_request.invoice_from_documents or (new.deleted_at is null and new.status in ('sent','part_paid','paid','written_off'))) then
    select count(*),sum(greatest(0,d.subtotal_cents-d.discount_cents)) into v_count,v_amount
      from public.partner_documents d where d.work_request_id=new.work_request_id and d.kind='invoice'
        and d.deleted_at is null and d.status in ('sent','part_paid','paid','written_off');
    v_next:=case when v_request.status='closed' then 'closed'::work_request_status
      when v_count>0 then 'invoiced'::work_request_status else 'completed'::work_request_status end;
    update public.work_requests set status=v_next,invoice_amount_cents=v_amount,invoice_from_documents=true where id=v_request.id;
    if v_next is distinct from v_request.status then
      insert into public.work_request_events(farm_id,work_request_id,from_status,to_status,note,by_user)
        values(v_request.farm_id,v_request.id,v_request.status,v_next,'Reconciled supplier invoices.',auth.uid());
    end if;
    return new;
  end if;
  if new.deleted_at is not null then return new; end if;
  v_amount := greatest(0,new.subtotal_cents-new.discount_cents);
  if new.kind = 'quote' and new.status = 'sent' and v_request.status in ('requested','viewed','quoted') then
    v_next := 'quoted';
    update public.work_requests set status=v_next,quote_amount_cents=v_amount where id=v_request.id;
  elsif new.kind = 'quote' and new.status = 'accepted' and v_request.status in ('requested','viewed','quoted') then
    v_next := 'accepted';
    update public.work_requests set status=v_next where id=v_request.id;
  elsif new.kind = 'invoice' and new.status in ('sent','part_paid','paid','written_off') and v_request.status in ('completed','invoiced') then
    v_next := 'invoiced';
    update public.work_requests set status=v_next,invoice_amount_cents=v_amount where id=v_request.id;
  end if;
  if v_next is not null and v_request.status is distinct from v_next then
    insert into public.work_request_events(farm_id,work_request_id,from_status,to_status,note,by_user)
      values(v_request.farm_id,v_request.id,v_request.status,v_next,'Updated from supplier document '||new.number,auth.uid());
  end if;
  return new;
end $$;
revoke execute on function public.app_document_work_request_sync() from public, anon, authenticated;
create trigger partner_documents_zy_work_request_sync after insert or update on public.partner_documents
  for each row execute function public.app_document_work_request_sync();

-- Once a request uses invoice documents, voiding one cannot resurrect its old
-- manually recorded amount. The document ledger remains the source of its costs.
do $$ declare definition text; begin
  definition:=pg_get_functiondef('public.app_cost_from_work_request()'::regprocedure);
  if position('v_yield  := exists (' in definition)=0 then raise exception 'Work-request cost contract changed'; end if;
  execute replace(definition,'v_yield  := exists (','v_yield  := new.invoice_from_documents or exists (');
end $$;
update public.work_requests w set invoice_from_documents=true where exists(
  select 1 from public.partner_documents d where d.work_request_id=w.id and d.kind='invoice' and d.status<>'draft');

-- The assistant's existing atomic completed-service command keeps its signature
-- and passes through the same start/complete transitions as the screen.
do $$ declare v_definition text; v_old text; begin
  v_definition := pg_get_functiondef('public.record_completed_service(uuid,uuid,numeric,date,text)'::regprocedure);
  v_old := '  update public.job_cards
     set status = ''completed'', date_out = p_service_date';
  if position(v_old in v_definition) = 0 then raise exception 'Completed service command contract changed'; end if;
  execute replace(v_definition,v_old,
    '  update public.job_cards set status = ''in_progress'' where id = v_id and farm_id = p_farm;
' || v_old);
end $$;
