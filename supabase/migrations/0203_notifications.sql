-- 0203_notifications.sql
-- Notification queue enqueue (Scope §4.7). v1 uses the in-app channel; WhatsApp
-- Stage 2 (API) is deferred — Stage 1 is manual. Events enqueue an in-app notification
-- to the farm's owner/manager; a cron/worker later maps queued rows to WhatsApp.

create or replace function app.notify_farm(p_farm uuid, p_template text, p_payload jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notifications (farm_id, user_id, channel, template, payload, status)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued'
  from users u
  where u.farm_id = p_farm and u.role in ('owner','manager') and u.active and u.deleted_at is null;
end $$;

-- New fault → notify the farm
create or replace function app_fault_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.notify_farm(new.farm_id, 'fault_reported', jsonb_build_object(
    'fault_id', new.id, 'machine_id', new.machine_id,
    'urgency', new.urgency, 'description', left(coalesce(new.description, ''), 140)));
  return new;
end $$;
create trigger faults_notify after insert on faults
  for each row execute function app_fault_notify();

-- Job completed/approved → notify the farm with the cost
create or replace function app_jobcard_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status in ('completed','approved')
     and old.status is distinct from new.status
     and old.status not in ('completed','approved') then
    perform app.notify_farm(new.farm_id, 'job_completed', jsonb_build_object(
      'job_card_id', new.id, 'machine_id', new.machine_id, 'total_cents', new.total_cents));
  end if;
  return new;
end $$;
create trigger job_cards_notify after update on job_cards
  for each row execute function app_jobcard_notify();

revoke execute on function app.notify_farm(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function app_fault_notify() from public, anon, authenticated;
revoke execute on function app_jobcard_notify() from public, anon, authenticated;
