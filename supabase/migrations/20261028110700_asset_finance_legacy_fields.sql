-- 20261028110700_asset_finance_legacy_fields.sql
-- Retire the five finance fields on `machines` (0210) in favour of finance agreements.
--
-- Until now finance was a note on the machine: provider, amount financed, monthly
-- instalment, term and rate, entered in the Edit machine dialog. 0211 turned it into ONE
-- 'finance' cost entry of (monthly x term - principal), dated on the purchase date, so the
-- whole cost of the credit sat in the month the machine was bought and the rate was never
-- used. The new Finance section replaces those fields (the app no longer writes them).
--
-- 1. Every machine that carries those fields and has no agreement gets one, marked
--    `migrated_from_machine` so the screen can say where it came from:
--      lender     the provider, or '-' when none was recorded (the screen says "not recorded")
--      principal  the amount financed; term in months, monthly, from the day after the
--                 purchase month (one month after the purchase date, or the date the
--                 machine was added); the rate, or when only the monthly figure was kept,
--                 the rate that figure implies (app.finance_implied_rate_bps)
--      paid       instalments already due are taken as paid: the machine record never held
--                 a payment history, and showing years of arrears would be wrong too
-- 2. The fields are then cleared, which makes 0211's trigger withdraw the old lump; the
--    per-instalment interest of the new agreement takes its place in the ledger.
-- 3. The trigger itself no longer books the lump for a machine that has an agreement, so
--    an older build still writing those fields (between this migration and the deploy)
--    cannot bring the double count back.
--
-- Rows the new schedule cannot represent (no term, a term over 30 years, no amount) are
-- left exactly as they were, with their lump, for a person to look at.

alter table public.finance_agreements
  add column if not exists migrated_from_machine boolean not null default false;

comment on column public.finance_agreements.migrated_from_machine is
  'Created on 2026-10-28 from the finance fields that used to sit on machines (0210).';

-- == The trigger: the lump only for a machine with no agreement ================
create or replace function public.app_cost_from_machine() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_when     date := coalesce(new.purchase_date, new.created_at::date, current_date);
  v_interest bigint;
begin
  -- purchase (capital price)
  if new.deleted_at is null and coalesce(new.purchase_price_cents, 0) <> 0 then
    if exists (select 1 from cost_entries where source_type = 'machine' and source_id = new.id) then
      update cost_entries
         set farm_id = new.farm_id, machine_id = new.id, type = 'purchase',
             amount_cents = new.purchase_price_cents, occurred_on = v_when, deleted_at = null, deleted_by = null
       where source_type = 'machine' and source_id = new.id;
    else
      insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
      values (new.farm_id, new.id, 'purchase', new.purchase_price_cents, 'machine', new.id, v_when);
    end if;
  else
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'machine' and source_id = new.id and deleted_at is null;
  end if;

  -- finance interest = (monthly x term) - principal, when derivable and positive, and only
  -- while the machine has no finance agreement: an agreement books its interest per
  -- instalment as it falls due (20261028110400), and both would count the credit twice.
  v_interest := null;
  if new.finance_monthly_cents is not null and new.finance_term_months is not null and new.finance_total_cents is not null then
    v_interest := new.finance_monthly_cents * new.finance_term_months - new.finance_total_cents;
  end if;
  if new.deleted_at is null and coalesce(v_interest, 0) > 0
     and not exists (select 1 from finance_agreements fa where fa.machine_id = new.id and fa.deleted_at is null) then
    if exists (select 1 from cost_entries where source_type = 'machine_finance' and source_id = new.id) then
      update cost_entries
         set farm_id = new.farm_id, machine_id = new.id, type = 'finance',
             amount_cents = v_interest, occurred_on = v_when, deleted_at = null, deleted_by = null
       where source_type = 'machine_finance' and source_id = new.id;
    else
      insert into cost_entries (farm_id, machine_id, type, amount_cents, source_type, source_id, occurred_on)
      values (new.farm_id, new.id, 'finance', v_interest, 'machine_finance', new.id, v_when);
    end if;
  else
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'machine_finance' and source_id = new.id and deleted_at is null;
  end if;

  return new;
end $$;

revoke execute on function public.app_cost_from_machine() from anon, authenticated, public;

-- == Move the data =============================================================
do $move$
declare
  r       record;
  v_id    uuid;
  v_start date;
  v_rate  integer;
  v_inst  bigint;
begin
  for r in
    select m.id, m.farm_id, m.finance_provider, m.finance_total_cents, m.finance_monthly_cents,
           m.finance_term_months, m.finance_interest_bps, m.purchase_date, m.created_at
      from public.machines m
     where m.deleted_at is null
       and coalesce(m.finance_total_cents, 0) > 0
       and m.finance_term_months between 1 and 360
       and not exists (select 1 from public.finance_agreements a
                        where a.machine_id = m.id and a.deleted_at is null)
  loop
    v_start := coalesce(r.purchase_date, r.created_at::date);
    v_inst := nullif(r.finance_monthly_cents, 0);
    v_rate := case when r.finance_interest_bps between 0 and 10000 then r.finance_interest_bps end;
    if v_rate is null and v_inst is not null then
      v_rate := app.finance_implied_rate_bps(r.finance_total_cents, v_inst, r.finance_term_months, 1, 0);
    end if;

    insert into public.finance_agreements
      (farm_id, machine_id, kind, lender, principal_cents, interest_rate_bps, term_months,
       frequency, instalment_cents, start_date, first_instalment_date, migrated_from_machine)
    values
      (r.farm_id, r.id, 'instalment_sale',
       coalesce(left(nullif(btrim(r.finance_provider), ''), 120), '-'),
       r.finance_total_cents, coalesce(v_rate, 0), r.finance_term_months, 'monthly',
       -- The lender's figure is kept only where a rate was found to go with it.
       case when v_rate is not null then v_inst end,
       v_start, app.finance_add_months(v_start, 1), true)
    returning id into v_id;

    begin
      perform app.finance_rebuild_schedule(v_id);
    exception when others then
      -- The monthly figure did not fit the rate and term: build from the rate alone.
      update public.finance_agreements set instalment_cents = null where id = v_id;
      perform app.finance_rebuild_schedule(v_id);
    end;

    update public.finance_instalments
       set paid_cents = interest_cents + capital_cents + fee_cents,
           paid_on = due_date,
           status = 'paid',
           updated_at = now()
     where agreement_id = v_id and deleted_at is null and status = 'open'
       and due_date < app.finance_today();
    perform app.finance_close_if_paid(v_id);
    perform app.sync_asset_finance_costs(r.farm_id);

    -- Cleared last: the machine trigger now withdraws the old lump.
    update public.machines
       set finance_provider = null, finance_total_cents = null, finance_monthly_cents = null,
           finance_term_months = null, finance_interest_bps = null
     where id = r.id;
  end loop;
end
$move$;
