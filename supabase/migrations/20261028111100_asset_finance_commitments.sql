-- 20261028111100_asset_finance_commitments.sql
-- What the farm has committed to pay, day by day: the cash-flow view of finance and
-- contracts (/finance, its CSV and workbook).
--
-- CASH, NOT COST. An instalment here is the WHOLE amount still to pay on it, capital
-- included, because that is what leaves the bank; the cost ledger (20261028110400) books
-- only its interest and fee. A contract payment is shown ex-VAT with its VAT beside it, so
-- the screen can add them into the gross amount the bank will see. Notice and end dates
-- come through too, with no amount, so the same list can say "give notice by".
--
-- An auto-renewing contract is projected past its end date (it renews unless notice is
-- given); any other stops at its end date.
--
-- SECURITY INVOKER: RLS on finance_instalments and asset_contracts decides whose these
-- are, so anybody but an owner or a manager reads nothing.

create or replace function public.farm_finance_commitments(p_farm uuid, p_from date, p_to date)
returns table (
  kind         text,
  source_id    uuid,
  item_id      uuid,
  machine_id   uuid,
  machine_name text,
  party        text,
  reference    text,
  on_date      date,
  amount_cents bigint,
  vat_cents    bigint
)
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select case i.kind when 'balloon' then 'balloon' else 'instalment' end,
         a.id, i.id, a.machine_id, m.name, nullif(a.lender, '-'), a.agreement_number, i.due_date,
         (i.amount_cents - i.paid_cents)::bigint, 0::bigint
    from public.finance_instalments i
    join public.finance_agreements a on a.id = i.agreement_id
    left join public.machines m on m.id = a.machine_id
   where i.farm_id = p_farm
     and i.deleted_at is null and a.deleted_at is null
     and a.status = 'active' and i.status = 'open'
     and i.due_date between p_from and p_to

  union all

  select 'contract_payment', c.id, null::uuid, c.machine_id, m.name, c.party, c.reference, d.on_date,
         c.amount_cents, round(c.amount_cents::numeric * c.vat_rate_bps / 10000)::bigint
    from public.asset_contracts c
    left join public.machines m on m.id = c.machine_id
    cross join lateral app.asset_contract_dates(
      coalesce(c.first_payment_date, c.start_date), c.frequency, p_from,
      case when c.auto_renews then p_to else least(p_to, coalesce(c.end_date, p_to)) end
    ) as d(on_date)
   where c.farm_id = p_farm
     and c.deleted_at is null and c.status = 'active' and c.amount_cents > 0

  union all

  select 'contract_notice', c.id, null::uuid, c.machine_id, m.name, c.party, c.reference, c.notice_date,
         null::bigint, null::bigint
    from public.asset_contracts c
    left join public.machines m on m.id = c.machine_id
   where c.farm_id = p_farm
     and c.deleted_at is null and c.status = 'active'
     and c.notice_date between p_from and p_to

  union all

  select 'contract_end', c.id, null::uuid, c.machine_id, m.name, c.party, c.reference, c.end_date,
         null::bigint, null::bigint
    from public.asset_contracts c
    left join public.machines m on m.id = c.machine_id
   where c.farm_id = p_farm
     and c.deleted_at is null and c.status = 'active'
     and c.end_date between p_from and p_to

  order by 8, 1;
$$;

comment on function public.farm_finance_commitments(uuid, date, date) is
  'Instalments still owed (capital included), contract payments (ex-VAT, VAT beside) and '
  'contract notice and end dates between two days. Cash, not cost. SECURITY INVOKER: '
  'owners and managers only, by RLS.';

revoke execute on function public.farm_finance_commitments(uuid, date, date) from public, anon;
grant execute on function public.farm_finance_commitments(uuid, date, date) to authenticated, service_role;
