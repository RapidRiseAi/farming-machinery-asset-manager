-- 0235_fault_out_of_service_trigger.sql  (F3 · FR-7.5)
-- Reporting a `stopped`-urgency fault flips the machine to `out_of_service`
-- (active-but-down). This fires no matter which path inserts the fault — in-app
-- (RLS client), or the public QR route (service role) — so a stopped machine is
-- always marked down for the fleet. It is intentionally revertible: an owner/manager
-- changes the status back via the machine edit form.
--
-- Guardrails:
--   * only `stopped` faults flip status (can_work / limping do not);
--   * `retired` / `sold` are never touched (they stay excluded everywhere);
--   * already `out_of_service` machines are left as-is (no redundant audit churn).
-- SECURITY DEFINER so it can update `machines` regardless of the caller's RLS
-- (the same pattern as the audit / notify triggers in 0008 / 0203).

create or replace function app_fault_out_of_service() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.urgency = 'stopped' and new.deleted_at is null then
    update machines
      set status = 'out_of_service'
      where id = new.machine_id
        and status not in ('out_of_service', 'retired', 'sold');
  end if;
  return new;
end $$;

create trigger faults_out_of_service after insert on faults
  for each row execute function app_fault_out_of_service();

revoke execute on function app_fault_out_of_service() from public, anon, authenticated;
