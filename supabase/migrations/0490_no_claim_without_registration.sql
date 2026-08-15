-- 0490_no_claim_without_registration.sql
-- A business that is not registered for VAT cannot claim input VAT. Ever.
--
-- 0401 made VAT registration a property of the workshop and guarded the SALES side with a
-- trigger: a non-registered partner's documents are forced to a zero rate, so a stale form
-- or an import cannot issue VAT on their behalf. The PURCHASE side never got the
-- equivalent, and the gap is not cosmetic.
--
-- What actually happens without this. A non-registered workshop captures a supplier
-- invoice for R1 150. They type 15% because that is what the supplier's paper says — which
-- is correct, they DID pay it — and `vat_claimable` is ticked by default. The row stores
-- R1 000 ex-VAT plus R150 VAT marked claimable. `app.partner_pl` then counts R1 000 as the
-- cost and R0 as blocked, so profit reads R150 higher than it was. Measured before this
-- migration on exactly that input: cost 100000, blocked 0, against R1 150 that genuinely
-- left the bank.
--
-- That is the same failure the 0460 header warns about for blocked VAT generally — money
-- that left the account and quietly stopped being a cost — except here it applies to EVERY
-- purchase the business makes, not just the entertainment ones.
--
-- The rule is not a preference and not a default anybody should be able to override from a
-- form, so it is enforced where 0401 enforces its half: in the database, on the way in.
-- The expense still records the VAT it paid (that is a real number on real paper, and it
-- belongs in the total that leaves the bank) — only the CLAIM is refused, which is what
-- turns the VAT into a cost rather than a receivable.
--
-- Nothing here refuses a write. A partner who registers for VAT later flips one switch in
-- their settings and the guard stops applying; their older rows keep the history of what
-- was true at the time, which is what an auditor asks about.

create or replace function app_expense_vat_claimable_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- SECURITY DEFINER because the row's own workshop is readable to the writer, but the
  -- `workshops` row is not always — a partner reads their own, and this must hold for a
  -- service-role import and the recurring generator too.
  if not exists (
    select 1 from workshops w
     where w.id = new.workshop_id
       and w.vat_registered
  ) then
    new.vat_claimable := false;
  end if;
  return new;
end $$;

comment on function app_expense_vat_claimable_guard() is
  'Forces vat_claimable false for a workshop that is not registered for VAT (0490). The '
  'mirror of 0401''s sales-side guard: input VAT a business may never reclaim is a cost, '
  'and no form should be able to say otherwise.';

create trigger partner_expenses_vat_claimable
  before insert or update on partner_expenses
  for each row execute function app_expense_vat_claimable_guard();

create trigger recurring_expenses_vat_claimable
  before insert or update on recurring_expenses
  for each row execute function app_expense_vat_claimable_guard();

-- Correct what is already stored. A claim that was never claimable was never a claim, and
-- leaving the old rows alone would mean a partner's own history disagrees with the rule
-- their next capture obeys — which is worse than either answer on its own.
update partner_expenses e
   set vat_claimable = false
  from workshops w
 where w.id = e.workshop_id
   and not w.vat_registered
   and e.vat_claimable;

update recurring_expenses r
   set vat_claimable = false
  from workshops w
 where w.id = r.workshop_id
   and not w.vat_registered
   and r.vat_claimable;
