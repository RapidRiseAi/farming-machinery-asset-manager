-- 0232_enum_fault_lifecycle.sql  (F3 · FR-7.3)
-- Extend the fault lifecycle with `acknowledged` and `in_progress` so a fault can
-- move Open → Acknowledged → In progress → Resolved. The existing workflow values
-- (`in_job`, `scheduled`) keep working unchanged — these are additive.
--
-- Own migration step (enum values must be committed before they are used).
alter type fault_status add value if not exists 'acknowledged';
alter type fault_status add value if not exists 'in_progress';
