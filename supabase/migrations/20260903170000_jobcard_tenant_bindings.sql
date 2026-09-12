-- Keep every fault, job card and covered service task on the same farm and machine.
-- IDs are globally unique, but ID-only references let a forged form connect records from
-- different tenants. Composite foreign keys make that relationship impossible even for
-- a service-role caller, and the trigger predicates provide defence in depth.

alter table public.faults
  add constraint faults_id_farm_machine_uq unique (id, farm_id, machine_id);
alter table public.job_cards
  add constraint job_cards_id_farm_machine_uq unique (id, farm_id, machine_id);
alter table public.service_plan_lines
  add constraint service_plan_lines_id_farm_machine_uq unique (id, farm_id, machine_id);

alter table public.job_cards
  drop constraint job_cards_created_from_fault_id_fkey,
  add constraint job_cards_source_fault_same_machine_fk
    foreign key (created_from_fault_id, farm_id, machine_id)
    references public.faults(id, farm_id, machine_id);

alter table public.faults
  drop constraint faults_job_card_fk,
  add constraint faults_job_card_same_machine_fk
    foreign key (job_card_id, farm_id, machine_id)
    references public.job_cards(id, farm_id, machine_id);

alter table public.job_card_service_lines add column machine_id uuid;
update public.job_card_service_lines l
   set machine_id = jc.machine_id
  from public.job_cards jc
 where jc.id = l.job_card_id
   and jc.farm_id = l.farm_id;
alter table public.job_card_service_lines alter column machine_id set not null;

alter table public.job_card_service_lines
  drop constraint jcsl_jc_fk,
  drop constraint jcsl_spl_fk,
  add constraint jcsl_jc_same_machine_fk
    foreign key (job_card_id, farm_id, machine_id)
    references public.job_cards(id, farm_id, machine_id) on delete cascade,
  add constraint jcsl_spl_same_machine_fk
    foreign key (service_plan_line_id, farm_id, machine_id)
    references public.service_plan_lines(id, farm_id, machine_id) on delete cascade;

create index job_card_service_lines_machine_idx
  on public.job_card_service_lines(farm_id, machine_id);

drop policy if exists jcsl_ins on public.job_card_service_lines;
drop policy if exists jcsl_del on public.job_card_service_lines;
create policy jcsl_ins on public.job_card_service_lines for insert to authenticated
  with check (exists (
    select 1
      from public.job_cards jc
      join public.service_plan_lines spl
        on spl.id = job_card_service_lines.service_plan_line_id
       and spl.farm_id = job_card_service_lines.farm_id
       and spl.machine_id = job_card_service_lines.machine_id
       and spl.deleted_at is null
     where jc.id = job_card_service_lines.job_card_id
       and jc.farm_id = job_card_service_lines.farm_id
       and jc.machine_id = job_card_service_lines.machine_id
       and jc.deleted_at is null
       and (
         app.effective_farm_role((select auth.uid()), job_card_service_lines.farm_id)
           in ('rr_admin','owner','manager','mechanic')
         or (
           app.current_app_role() = 'workshop'
           and app.has_farm_access(job_card_service_lines.farm_id)
           and app.partner_machine_visible(
             job_card_service_lines.farm_id,
             job_card_service_lines.machine_id
           )
         )
       )
  ));
create policy jcsl_del on public.job_card_service_lines for delete to authenticated
  using (exists (
    select 1
      from public.job_cards jc
      join public.service_plan_lines spl
        on spl.id = job_card_service_lines.service_plan_line_id
       and spl.farm_id = job_card_service_lines.farm_id
       and spl.machine_id = job_card_service_lines.machine_id
     where jc.id = job_card_service_lines.job_card_id
       and jc.farm_id = job_card_service_lines.farm_id
       and jc.machine_id = job_card_service_lines.machine_id
       and (
         app.effective_farm_role((select auth.uid()), job_card_service_lines.farm_id)
           in ('rr_admin','owner','manager','mechanic')
         or (
           app.current_app_role() = 'workshop'
           and app.has_farm_access(job_card_service_lines.farm_id)
           and app.partner_machine_visible(
             job_card_service_lines.farm_id,
             job_card_service_lines.machine_id
           )
         )
       )
  ));

-- A card created from a fault moves that exact fault into the job atomically. If the
-- fault was deleted between the action's validation and insert, abort the whole insert.
create or replace function public.app_jobcard_fault_linked() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.created_from_fault_id is not null then
    update public.faults
       set status = 'in_job', job_card_id = new.id
     where id = new.created_from_fault_id
       and farm_id = new.farm_id
       and machine_id = new.machine_id
       and deleted_at is null
       and status in ('open', 'in_job')
       and (job_card_id is null or job_card_id = new.id);
    if not found then
      raise exception 'The source fault is unavailable or already belongs to another job card.'
        using errcode = '23503';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.app_jobcard_fault_linked()
  from public, anon, authenticated;
drop trigger if exists job_cards_fault_linked on public.job_cards;
create trigger job_cards_fault_linked
  after insert on public.job_cards
  for each row execute function public.app_jobcard_fault_linked();

create or replace function public.app_jobcard_completed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_date date;
begin
  if new.status in ('completed','approved')
     and old.status is distinct from new.status
     and old.status not in ('completed','approved') then
    v_date := coalesce(new.date_out, current_date);

    update public.service_plan_lines spl
       set last_done_reading = new.meter_reading, last_done_date = v_date
      from public.job_card_service_lines l
     where l.job_card_id = new.id
       and l.farm_id = new.farm_id
       and l.machine_id = new.machine_id
       and l.service_plan_line_id = spl.id
       and spl.farm_id = new.farm_id
       and spl.machine_id = new.machine_id;

    if new.meter_reading is not null then
      insert into public.meter_readings
        (farm_id, machine_id, reading, reading_date, source, by_user)
      values
        (new.farm_id, new.machine_id, new.meter_reading, v_date, 'job', new.mechanic_user_id);
    end if;
    perform app.recalc_machine_service(new.machine_id);

    if coalesce(btrim(new.recommendations), '') <> '' then
      insert into public.watch_items
        (farm_id, machine_id, source_job_card_id, text, status)
      values
        (new.farm_id, new.machine_id, new.id, new.recommendations, 'open');
    end if;

    if new.created_from_fault_id is not null then
      update public.faults
         set status = 'resolved', resolved_at = now()
       where id = new.created_from_fault_id
         and farm_id = new.farm_id
         and machine_id = new.machine_id
         and job_card_id = new.id
         and status <> 'resolved';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.app_jobcard_completed()
  from public, anon, authenticated;
