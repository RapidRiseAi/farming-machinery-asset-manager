-- 0202_service_engine_and_jobcards.sql
-- Week 2 core backend: the service due-date engine, the job-card ↔ service-plan-line
-- link, and job-card completion side-effects (reset service lines, capture the meter
-- reading, raise a watch item, resolve the originating fault).

-- ── Which service-plan lines a scheduled-service job card covers (Scope §4.4) ──
create table job_card_service_lines (
  job_card_id          uuid not null,
  service_plan_line_id uuid not null,
  farm_id              uuid not null,
  created_at           timestamptz not null default now(),
  primary key (job_card_id, service_plan_line_id),
  constraint jcsl_jc_fk   foreign key (job_card_id, farm_id) references job_cards(id, farm_id) on delete cascade,
  constraint jcsl_spl_fk  foreign key (service_plan_line_id) references service_plan_lines(id) on delete cascade,
  constraint jcsl_farm_fk foreign key (farm_id) references farms(id)
);
create index job_card_service_lines_spl_idx  on job_card_service_lines(service_plan_line_id);
create index job_card_service_lines_farm_idx on job_card_service_lines(farm_id);

alter table job_card_service_lines enable row level security;
alter table job_card_service_lines force  row level security;
create policy jcsl_sel on job_card_service_lines for select to authenticated using (app.has_farm_access(farm_id));
create policy jcsl_ins on job_card_service_lines for insert to authenticated with check (app.has_farm_access(farm_id));
create policy jcsl_del on job_card_service_lines for delete to authenticated using (app.has_farm_access(farm_id));
grant select, insert, update, delete on job_card_service_lines to authenticated;
grant all on job_card_service_lines to service_role;
create trigger job_card_service_lines_audit
  after insert or update or delete on job_card_service_lines
  for each row execute function app_audit();

-- ── Due engine: recompute status + next-due for one machine's service lines ──
-- Handles both triggers (hours/km and calendar), whichever comes first (Scope §4.3).
create or replace function app.recalc_machine_service(p_machine uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_reading   numeric;
  v_meter     meter_type;
  v_settings  jsonb;
  v_due_hours numeric;
  v_due_days  int;
  r           record;
  v_next_reading numeric;
  v_next_date    date;
  v_status    service_line_status;
begin
  select m.current_reading, m.meter_type, f.settings
    into v_reading, v_meter, v_settings
  from machines m join farms f on f.id = m.farm_id
  where m.id = p_machine;
  if not found then return; end if;

  v_due_hours := coalesce((v_settings->>'due_soon_hours')::numeric, 25);
  v_due_days  := coalesce((v_settings->>'due_soon_days')::int, 14);

  for r in select * from service_plan_lines where machine_id = p_machine and deleted_at is null loop
    v_next_reading := case when r.interval_hours is not null and r.last_done_reading is not null
                           then r.last_done_reading + r.interval_hours else r.next_due_reading end;
    v_next_date := case when r.interval_months is not null and r.last_done_date is not null
                        then (r.last_done_date + (r.interval_months || ' months')::interval)::date else r.next_due_date end;

    if (v_next_reading is not null and v_meter in ('hours','km') and v_reading is not null and v_reading >= v_next_reading)
       or (v_next_date is not null and current_date >= v_next_date) then
      v_status := 'overdue';
    elsif (v_next_reading is not null and v_meter in ('hours','km') and v_reading is not null and v_reading >= v_next_reading - v_due_hours)
       or (v_next_date is not null and current_date >= v_next_date - v_due_days) then
      v_status := 'due_soon';
    else
      v_status := 'ok';
    end if;

    update service_plan_lines
      set next_due_reading = v_next_reading, next_due_date = v_next_date, status = v_status
      where id = r.id;
  end loop;
end $$;

-- Nightly recompute (calendar-based dues drift even without new readings). Call from
-- a cron / service-role route.
create or replace function app.recalc_all_due() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare m uuid;
begin
  for m in select id from machines where deleted_at is null and status not in ('retired','sold') loop
    perform app.recalc_machine_service(m);
  end loop;
end $$;

revoke execute on function app.recalc_machine_service(uuid) from public, anon, authenticated;
revoke execute on function app.recalc_all_due() from public, anon, authenticated;
grant execute on function app.recalc_all_due() to service_role;

-- ── Meter readings feed the schedule: advance current reading + recalc ──
create or replace function app_meter_reading_after() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update machines
    set current_reading = new.reading, current_reading_date = new.reading_date
    where id = new.machine_id
      and (current_reading_date is null or new.reading_date >= current_reading_date);
  perform app.recalc_machine_service(new.machine_id);
  return new;
end $$;

create trigger meter_readings_after
  after insert on meter_readings
  for each row execute function app_meter_reading_after();

-- ── Job-card completion side-effects (Scope §4.4) ──
create or replace function app_jobcard_completed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_date date;
begin
  if new.status in ('completed','approved')
     and old.status is distinct from new.status
     and old.status not in ('completed','approved') then
    v_date := coalesce(new.date_out, current_date);

    -- reset covered service lines' last-done
    update service_plan_lines spl
      set last_done_reading = new.meter_reading, last_done_date = v_date
      from job_card_service_lines l
      where l.job_card_id = new.id and l.service_plan_line_id = spl.id;

    -- capture the meter reading (advances current reading + recalcs via its trigger)
    if new.meter_reading is not null then
      insert into meter_readings (farm_id, machine_id, reading, reading_date, source, by_user)
      values (new.farm_id, new.machine_id, new.meter_reading, v_date, 'job', new.mechanic_user_id);
    end if;
    perform app.recalc_machine_service(new.machine_id);

    -- recommendations become an open watch item
    if coalesce(btrim(new.recommendations), '') <> '' then
      insert into watch_items (farm_id, machine_id, source_job_card_id, text, status)
      values (new.farm_id, new.machine_id, new.id, new.recommendations, 'open');
    end if;

    -- resolve the originating fault
    if new.created_from_fault_id is not null then
      update faults set status = 'resolved', resolved_at = now()
      where id = new.created_from_fault_id and status <> 'resolved';
    end if;
  end if;
  return new;
end $$;

create trigger job_cards_completed
  after update on job_cards
  for each row execute function app_jobcard_completed();

revoke execute on function app_meter_reading_after() from public, anon, authenticated;
revoke execute on function app_jobcard_completed() from public, anon, authenticated;
