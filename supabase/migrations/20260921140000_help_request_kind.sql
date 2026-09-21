-- 20260921140000_help_request_kind.sql
-- A farmer asking for help, from inside the product.
--
-- `/billing` prints an email address. That is the whole of customer support: a farmer with
-- a problem has to leave the product, open a mail client, and describe from memory which
-- screen they were on and what plan they are on. Most will not, and the ones who do
-- describe it wrongly, so the first reply is always a request for the context the product
-- already had.
--
-- The case machinery already exists (20260912160000): a ticket, an escalation clock, and a
-- delivery queue to the support dashboard. What is missing is a door a customer can use.
--
-- WHAT THIS DOES NOT REUSE
-- =============================================================================
-- `app.support_ticket_evidence`. That builder reads five billing tables and assembles an
-- object that LEAVES THE BUILDING, and it is the most sensitive function in this schema. A
-- help request needs the farm, the plan, the role and the screen they were on. Attaching a
-- billing dossier to "the QR code will not scan" would put a card's last four and an
-- attempt history into a support queue for no reason at all.
--
-- WHO IT SPEAKS FOR
-- =============================================================================
-- The signed-in user, established from `auth.uid()` inside the function. Nothing about the
-- farm comes from the caller, so a farmer cannot open a case against somebody else's farm
-- by editing a form field.

do $$ begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'support_ticket_kind' and e.enumlabel = 'help_request'
  ) then
    alter type support_ticket_kind add value 'help_request';
  end if;
end $$;

-- THE VALUE IS ADDED IN A FILE OF ITS OWN
-- =============================================================================
-- Postgres refuses "unsafe use of new value" when an enum value is added and then used in
-- the same transaction, and the migration runner applies one file per transaction. So this
-- file adds the value and commits; 20260921141000 uses it. Splitting them is the standard
-- answer and the only one that does not involve pretending the value already exists.
