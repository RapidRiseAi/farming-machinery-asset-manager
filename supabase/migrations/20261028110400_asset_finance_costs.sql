-- 20261028110400_asset_finance_costs.sql
-- What finance agreements and contracts COST, booked into the one cost ledger the rest of
-- the product already reads (cost_entries, 0210): TCO, cost per hour and per km on the
-- machine page and in reports, budgets, the assistant's figures and the accounting journal.
--
-- == The rule that keeps the books honest: capital is never an expense ========
-- A financed machine already carries its full price as ONE 'purchase' entry (0211), dated
-- on the purchase date. Repaying the loan pays for that same machine again in pieces, so
-- booking instalments' capital as a cost would count the machine twice. Only what the
-- credit COSTS is an expense:
--
--   instalment     interest + service fee     'finance'   dated on its due date (accrual)
--   settlement     amount above the capital   'finance'   dated on the settlement date
--                  still owed (penalty or interest to the settlement day)
--   lease, rental  each payment               'lease'     dated as it falls due
--   other contract each payment               'other'     dated as it falls due
--
-- Capital repaid, the deposit and the balloon are NEVER cost entries. They show on the
-- cash-flow view (money leaving the bank), which is a different question from cost.
--
-- Interest is booked when an instalment falls DUE, not when the agreement is captured, so
-- lifetime TCO is what the credit has cost so far rather than the whole term in the month
-- of purchase (the old 'machine_finance' lump, which 20261028110700 retires).
--
-- A contract that the farm is already invoiced for through a contractor (those invoices
-- reach cost_entries on their own, 0381) is saved with post_costs off, and books nothing.
--
-- == Idempotent by construction ===============================================
-- One function rebuilds the wanted set for a farm and reconciles the ledger to it: add
-- what is missing, correct what changed, soft-delete what is no longer wanted (an edited
-- schedule, a deleted agreement, a contract ended early). Run it twice and the second run
-- changes nothing, which is what lets every write call it AND the nightly pass call it.
-- Keys: (source_type, source_id) for an instalment or a settlement; (source_type,
-- source_id, occurred_on) for a contract, one row per payment date.
--
-- Interest carries no VAT (financial services are exempt); a contract payment carries the
-- contract's own rate, so the journal codes it STD and the interest NONE.

create or replace function app.sync_asset_finance_costs(p_farm uuid, p_today date default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'Africa/Johannesburg')::date);
begin
  if p_farm is null then
    return;
  end if;

  -- == (0) The old lump gives way to the agreement ==========================
  -- 0211 books (monthly x term - principal) once, on the purchase date, from the finance
  -- fields that used to sit on the machine. A machine with a live agreement has its
  -- interest booked per instalment below, so the lump would count the credit twice.
  update public.cost_entries ce
     set deleted_at = now()
   where ce.farm_id = p_farm
     and ce.source_type = 'machine_finance'
     and ce.deleted_at is null
     and exists (select 1 from public.finance_agreements fa
                  where fa.machine_id = ce.machine_id and fa.deleted_at is null);

  -- == (1) Interest and service fees, one entry per instalment ==============
  with want as (
    select i.id                              as source_id,
           i.farm_id,
           a.machine_id,
           (i.interest_cents + i.fee_cents)  as amount,
           i.due_date                        as on_date
      from public.finance_instalments i
      join public.finance_agreements a on a.id = i.agreement_id
     where i.farm_id = p_farm
       and i.deleted_at is null
       and a.deleted_at is null
       and a.status <> 'cancelled'
       -- An instalment closed by an early settlement never accrued its interest; what the
       -- settlement did cost is booked once, in (2).
       and i.status <> 'settled'
       and i.due_date <= v_today
       and i.interest_cents + i.fee_cents > 0
  ),
  fix as (
    update public.cost_entries ce
       set amount_cents = w.amount,
           occurred_on  = w.on_date,
           machine_id   = w.machine_id
      from want w
     where ce.source_type = 'finance_instalment'
       and ce.source_id = w.source_id
       and ce.deleted_at is null
       and (ce.amount_cents, ce.occurred_on, ce.machine_id)
           is distinct from (w.amount, w.on_date, w.machine_id)
    returning ce.id
  ),
  ins as (
    insert into public.cost_entries
      (farm_id, machine_id, type, amount_cents, vat_rate_bps, source_type, source_id, occurred_on, note)
    select w.farm_id, w.machine_id, 'finance', w.amount, 0, 'finance_instalment', w.source_id, w.on_date,
           'Finance interest and fees'
      from want w
     where not exists (
       select 1 from public.cost_entries ce
        where ce.source_type = 'finance_instalment' and ce.source_id = w.source_id and ce.deleted_at is null)
    returning id
  )
  update public.cost_entries ce
     set deleted_at = now()
   where ce.farm_id = p_farm
     and ce.source_type = 'finance_instalment'
     and ce.deleted_at is null
     and not exists (select 1 from want w where w.source_id = ce.source_id);

  -- == (2) What an early settlement cost above the capital still owed =======
  with want as (
    select a.id as source_id, a.farm_id, a.machine_id,
           a.settlement_charge_cents as amount, a.settled_on as on_date
      from public.finance_agreements a
     where a.farm_id = p_farm
       and a.deleted_at is null
       and a.status = 'settled'
       and coalesce(a.settlement_charge_cents, 0) > 0
       and a.settled_on <= v_today
  ),
  fix as (
    update public.cost_entries ce
       set amount_cents = w.amount,
           occurred_on  = w.on_date,
           machine_id   = w.machine_id
      from want w
     where ce.source_type = 'finance_settlement'
       and ce.source_id = w.source_id
       and ce.deleted_at is null
       and (ce.amount_cents, ce.occurred_on, ce.machine_id)
           is distinct from (w.amount, w.on_date, w.machine_id)
    returning ce.id
  ),
  ins as (
    insert into public.cost_entries
      (farm_id, machine_id, type, amount_cents, vat_rate_bps, source_type, source_id, occurred_on, note)
    select w.farm_id, w.machine_id, 'finance', w.amount, 0, 'finance_settlement', w.source_id, w.on_date,
           'Finance settlement charge'
      from want w
     where not exists (
       select 1 from public.cost_entries ce
        where ce.source_type = 'finance_settlement' and ce.source_id = w.source_id and ce.deleted_at is null)
    returning id
  )
  update public.cost_entries ce
     set deleted_at = now()
   where ce.farm_id = p_farm
     and ce.source_type = 'finance_settlement'
     and ce.deleted_at is null
     and not exists (select 1 from want w where w.source_id = ce.source_id);

  -- == (3) Lease, rental and contract payments, one entry per payment date ==
  with c as (
    select c.id, c.farm_id, c.machine_id, c.kind, c.amount_cents, c.vat_rate_bps, c.frequency,
           coalesce(c.first_payment_date, c.start_date)  as anchor,
           least(v_today, coalesce(c.end_date, v_today)) as upto
      from public.asset_contracts c
     where c.farm_id = p_farm
       and c.deleted_at is null
       and c.status <> 'cancelled'
       and c.post_costs
       and c.amount_cents > 0
  ),
  want as (
    select c.id as source_id, c.farm_id, c.machine_id, d.on_date,
           c.amount_cents as amount, c.vat_rate_bps as rate,
           (case when c.kind in ('operating_lease', 'rental') then 'lease' else 'other' end)::public.cost_entry_type as ctype,
           case when c.kind in ('operating_lease', 'rental') then 'Lease or rental payment'
                else 'Contract payment' end as note
      from c
      cross join lateral app.asset_contract_dates(c.anchor, c.frequency, c.anchor, c.upto) as d(on_date)
  ),
  fix as (
    update public.cost_entries ce
       set amount_cents = w.amount,
           vat_rate_bps = w.rate,
           type         = w.ctype,
           machine_id   = w.machine_id,
           note         = w.note
      from want w
     where ce.source_type = 'asset_contract'
       and ce.source_id = w.source_id
       and ce.occurred_on = w.on_date
       and ce.deleted_at is null
       and (ce.amount_cents, ce.vat_rate_bps, ce.type, ce.machine_id)
           is distinct from (w.amount, w.rate, w.ctype, w.machine_id)
    returning ce.id
  ),
  ins as (
    insert into public.cost_entries
      (farm_id, machine_id, type, amount_cents, vat_rate_bps, source_type, source_id, occurred_on, note)
    select w.farm_id, w.machine_id, w.ctype, w.amount, w.rate, 'asset_contract', w.source_id, w.on_date, w.note
      from want w
     where not exists (
       select 1 from public.cost_entries ce
        where ce.source_type = 'asset_contract' and ce.source_id = w.source_id
          and ce.occurred_on = w.on_date and ce.deleted_at is null)
    returning id
  )
  update public.cost_entries ce
     set deleted_at = now()
   where ce.farm_id = p_farm
     and ce.source_type = 'asset_contract'
     and ce.deleted_at is null
     and not exists (
       select 1 from want w where w.source_id = ce.source_id and w.on_date = ce.occurred_on);
end
$$;

comment on function app.sync_asset_finance_costs(uuid, date) is
  'Reconcile a farm''s cost ledger with its finance agreements and contracts: interest and '
  'fees per instalment due, settlement charges, and lease or contract payments due. Never '
  'books capital. Idempotent. Called by every finance write and by the nightly pass.';

-- Called from the SECURITY DEFINER write functions and the nightly wrapper only.
revoke execute on function app.sync_asset_finance_costs(uuid, date) from public, anon, authenticated;
grant execute on function app.sync_asset_finance_costs(uuid, date) to service_role;
