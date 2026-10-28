-- 20261028100000_support_request_kinds.sql
-- Two more kinds of support request: a privacy or deletion request, and a request for a
-- full data export (founder decisions 2026-10-26, "Third parties and privacy" and "Data
-- ownership and export"). Customers send both through general support; Xander handles the
-- privacy ones and the team handles exports that the built-in reports do not cover.
--
-- THE VALUES ARE ADDED IN A FILE OF THEIR OWN
-- Postgres refuses "unsafe use of new value" when an enum value is added and used in one
-- transaction, and the runner applies one file per transaction (20261028100500 onwards use
-- them). Same pattern as 20260921140000.

do $$ begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'support_ticket_kind' and e.enumlabel = 'privacy_request'
  ) then
    alter type support_ticket_kind add value 'privacy_request';
  end if;
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'support_ticket_kind' and e.enumlabel = 'export_request'
  ) then
    alter type support_ticket_kind add value 'export_request';
  end if;
end $$;
