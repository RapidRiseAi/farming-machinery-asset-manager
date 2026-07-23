-- 0231_enum_machine_status_out_of_service.sql  (F3 · FR-7.5)
-- Add `out_of_service` to machine_status. It is treated as **active-but-down**:
-- the asset is still on the fleet (counts on dashboards/reports, still notified),
-- unlike `retired`/`sold` which are excluded everywhere. A `stopped`-urgency fault
-- flips a machine here (see 0235); an owner/manager can revert via the edit form.
--
-- Own migration step — the new enum value cannot be used in the same transaction
-- that adds it (0235 references it).
alter type machine_status add value if not exists 'out_of_service';
