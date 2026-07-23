-- 0236_usage_log_jobcard_trigger.sql  (F3 · FR-13.1 capture hook)
-- When a job card is completed/approved, record a driver-usage log with the
-- mechanic/operator as the driver (Scope: "driver = mechanic/operator"). This is a
-- DB trigger so it is route-independent — completion via the job-card editor, the
-- lifecycle actions, or anywhere else all produce exactly one usage_log.
--
-- It mirrors the completion gate in 0202 (`app_jobcard_completed`) so the two stay
-- in lock-step, and only fires on the open→completed/approved transition. Readings
-- captured directly (in-app / QR) write their own usage_log at the app/route layer;
-- there is deliberately no meter_readings→usage_log trigger, so each capture yields
-- one usage_log (no double counting).

create or replace function app_jobcard_usage_log() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('completed','approved')
     and old.status is distinct from new.status
     and old.status not in ('completed','approved')
     and new.meter_reading is not null then
    insert into usage_logs (farm_id, machine_id, driver_user_id, occurred_on, meter_reading, source, note)
    values (
      new.farm_id, new.machine_id, new.mechanic_user_id,
      coalesce(new.date_out, current_date), new.meter_reading, 'job',
      'Job card completion'
    );
  end if;
  return new;
end $$;

create trigger job_cards_usage_log after update on job_cards
  for each row execute function app_jobcard_usage_log();

revoke execute on function app_jobcard_usage_log() from public, anon, authenticated;
