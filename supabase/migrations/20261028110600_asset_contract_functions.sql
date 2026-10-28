-- 20261028110600_asset_contract_functions.sql
-- Writing a lease, rental or service contract: capture or edit it, end it, renew it, or
-- remove one captured by mistake.
--
-- Same shape as the agreement functions (20261028110500): SECURITY DEFINER, the finance
-- check first (owners and managers of the contract's farm), refusals as slugs, and the
-- cost ledger reconciled before returning, so a payment that has fallen due is booked the
-- moment the contract is saved and withdrawn the moment it is ended early or removed.
--
-- VAT: amounts are ex-VAT like every amount here. `vat_charged` true captures the farm's
-- own VAT rate (app.farm_vat_rate_bps) on the contract, which the cost entries carry and
-- the journal codes as standard-rated.

create or replace function public.asset_contract_save(
  p_contract uuid,
  p_farm     uuid,
  p_fields   jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old       public.asset_contracts;
  v_farm      uuid;
  v_id        uuid;
  v_machine   uuid    := nullif(p_fields ->> 'machine_id', '')::uuid;
  v_kind      text    := coalesce(nullif(btrim(p_fields ->> 'kind'), ''), 'operating_lease');
  v_party     text    := nullif(btrim(p_fields ->> 'party'), '');
  v_reference text    := nullif(btrim(p_fields ->> 'reference'), '');
  v_start     date    := nullif(p_fields ->> 'start_date', '')::date;
  v_end       date    := nullif(p_fields ->> 'end_date', '')::date;
  v_amount    bigint  := coalesce(nullif(p_fields ->> 'amount_cents', '')::bigint, 0);
  v_vat       boolean := coalesce(nullif(p_fields ->> 'vat_charged', '')::boolean, false);
  v_frequency text    := coalesce(nullif(btrim(p_fields ->> 'frequency'), ''), 'monthly');
  v_first     date    := nullif(p_fields ->> 'first_payment_date', '')::date;
  v_auto      boolean := coalesce(nullif(p_fields ->> 'auto_renews', '')::boolean, false);
  v_renewal   integer := nullif(p_fields ->> 'renewal_months', '')::integer;
  v_notice    integer := nullif(p_fields ->> 'notice_days', '')::integer;
  v_post      boolean := coalesce(nullif(p_fields ->> 'post_costs', '')::boolean, true);
  v_lead      integer := nullif(p_fields ->> 'reminder_lead_days', '')::integer;
  v_notes     text    := nullif(btrim(p_fields ->> 'notes'), '');
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_contract is null then
    v_farm := p_farm;
  else
    select * into v_old from public.asset_contracts
     where id = p_contract and deleted_at is null
     for update;
    if not found then
      raise exception 'finance-not-found' using errcode = 'P0001';
    end if;
    v_farm := v_old.farm_id;
  end if;
  if v_farm is null or not app.can_view_farm_finance(v_farm) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_old.id is not null and v_old.status = 'cancelled' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;

  if v_machine is not null and not exists (
       select 1 from public.machines m
        where m.id = v_machine and m.farm_id = v_farm and m.deleted_at is null) then
    raise exception 'finance-machine-invalid' using errcode = '22023';
  end if;
  if v_party is null then
    raise exception 'contract-party-required' using errcode = '22023';
  end if;
  if v_kind not in ('operating_lease', 'rental', 'service_contract', 'maintenance_plan',
                    'extended_warranty', 'insurance', 'other')
     or v_frequency not in ('monthly', 'quarterly', 'biannual', 'annual', 'once') then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;
  if v_start is null or (v_end is not null and v_end < v_start)
     or (v_first is not null and v_first < v_start) then
    raise exception 'contract-dates' using errcode = '22023';
  end if;
  if v_amount < 0 or (v_renewal is not null and v_renewal not between 1 and 120)
     or (v_notice is not null and v_notice not between 0 and 365)
     or (v_lead is not null and v_lead not between 0 and 365) then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;
  if v_auto and (v_end is null or v_renewal is null) then
    raise exception 'contract-renewal-needs-end' using errcode = '22023';
  end if;

  if v_old.id is null then
    insert into public.asset_contracts
      (farm_id, machine_id, kind, party, reference, start_date, end_date, amount_cents,
       vat_rate_bps, frequency, first_payment_date, auto_renews, renewal_months, notice_days,
       post_costs, reminder_lead_days, notes, created_by)
    values
      (v_farm, v_machine, v_kind, v_party, v_reference, v_start, v_end, v_amount,
       case when v_vat then app.farm_vat_rate_bps(v_farm) else 0 end,
       v_frequency, v_first, v_auto, v_renewal, v_notice, v_post, v_lead, v_notes, auth.uid())
    returning id into v_id;
  else
    v_id := v_old.id;
    update public.asset_contracts
       set machine_id = v_machine, kind = v_kind, party = v_party, reference = v_reference,
           start_date = v_start, end_date = v_end, amount_cents = v_amount,
           -- Keep the rate captured when the contract was made unless VAT was switched.
           vat_rate_bps = case when not v_vat then 0
                               when v_old.vat_rate_bps > 0 then v_old.vat_rate_bps
                               else app.farm_vat_rate_bps(v_farm) end,
           frequency = v_frequency, first_payment_date = v_first, auto_renews = v_auto,
           renewal_months = v_renewal, notice_days = v_notice, post_costs = v_post,
           reminder_lead_days = v_lead, notes = v_notes,
           -- A contract given a later end date is running again.
           status = case when v_old.status = 'ended' and (v_end is null or v_end >= app.finance_today())
                         then 'active' else v_old.status end,
           updated_at = now()
     where id = v_id;
  end if;

  perform app.sync_asset_finance_costs(v_farm);
  return v_id;
end
$$;

-- End a contract on a day: nothing falls due after it, and it no longer renews.
create or replace function public.asset_contract_end(p_contract uuid, p_end_date date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.asset_contracts;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into c from public.asset_contracts x
   where x.id = p_contract and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(c.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if c.status <> 'active' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;
  if p_end_date is null or p_end_date < c.start_date then
    raise exception 'contract-dates' using errcode = '22023';
  end if;

  update public.asset_contracts
     set status = 'ended', end_date = p_end_date, auto_renews = false, updated_at = now()
   where id = c.id;

  perform app.sync_asset_finance_costs(c.farm_id);
end
$$;

-- Renew to a new end date, optionally at a new amount. The old end date and amount stay
-- in the activity log; the reminders for the new dates start afresh because they are kept
-- against the date they were sent for.
create or replace function public.asset_contract_renew(
  p_contract     uuid,
  p_end_date     date,
  p_amount_cents bigint default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.asset_contracts;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into c from public.asset_contracts x
   where x.id = p_contract and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(c.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if c.status = 'cancelled' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;
  if p_end_date is null or p_end_date < c.start_date
     or (c.end_date is not null and p_end_date <= c.end_date) then
    raise exception 'contract-renew-date' using errcode = '22023';
  end if;
  if p_amount_cents is not null and p_amount_cents < 0 then
    raise exception 'finance-payment-amount' using errcode = '22023';
  end if;

  update public.asset_contracts
     set status = 'active',
         end_date = p_end_date,
         amount_cents = coalesce(p_amount_cents, amount_cents),
         updated_at = now()
   where id = c.id;

  perform app.sync_asset_finance_costs(c.farm_id);
end
$$;

-- Remove a contract captured by mistake: soft, and the costs it booked are withdrawn.
create or replace function public.asset_contract_delete(p_contract uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.asset_contracts;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into c from public.asset_contracts x
   where x.id = p_contract and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(c.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.attachments
     set deleted_at = now(), deleted_by = auth.uid()
   where parent_type = 'asset_contract' and parent_id = c.id and farm_id = c.farm_id
     and deleted_at is null;
  update public.asset_contracts
     set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
   where id = c.id;

  perform app.sync_asset_finance_costs(c.farm_id);
end
$$;

revoke execute on function public.asset_contract_save(uuid, uuid, jsonb) from public, anon;
revoke execute on function public.asset_contract_end(uuid, date) from public, anon;
revoke execute on function public.asset_contract_renew(uuid, date, bigint) from public, anon;
revoke execute on function public.asset_contract_delete(uuid) from public, anon;
grant execute on function public.asset_contract_save(uuid, uuid, jsonb) to authenticated, service_role;
grant execute on function public.asset_contract_end(uuid, date) to authenticated, service_role;
grant execute on function public.asset_contract_renew(uuid, date, bigint) to authenticated, service_role;
grant execute on function public.asset_contract_delete(uuid) to authenticated, service_role;
