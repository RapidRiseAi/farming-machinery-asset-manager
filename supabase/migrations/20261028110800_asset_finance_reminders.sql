-- 20261028110800_asset_finance_reminders.sql
-- The nightly pass for finance agreements and contracts, and the reminders they send.
--
-- Two engines, the 0205/0263 pattern exactly: app.* functions nobody but the service role
-- may execute, fronted by public.cron_* wrappers the nightly route calls
-- (src/app/api/cron/nightly/route.ts).
--
-- == app.asset_finance_nightly =================================================
--   1. An auto-renewing contract whose end date has passed rolls on by its renewal term
--      (that is what the contract does); one that does not renew is marked ended.
--   2. A debit-order agreement has each instalment due by today marked paid on its due
--      date, and is closed when nothing is left.
--   3. The cost ledger is reconciled for every farm with finance rows, so interest and
--      lease payments are booked on the day they fall due without anybody opening a page.
--
-- == app.enqueue_asset_finance_reminders =======================================
-- Through the existing notification engine: app.notify_farm queues an in-app row for the
-- farm's owners and managers (the only people who may see finance), and the email, push
-- and WhatsApp deliveries pick it up by each person's own choice of channel. Quiet hours
-- are honoured (app.quiet_deliver_after). Each reminder fires once per date:
--   finance_instalment_due      an open instalment due within the agreement's lead days
--   finance_instalment_overdue  an open instalment past due, within 14 days of the date
--                               (never for a debit order, and never a flood of years of
--                               arrears for an agreement captured late)
--   contract_notice_due         the last day to give notice is within the lead days
--   contract_ending             the end date is within the lead days
-- NO AMOUNTS in any payload: these travel by email, push and WhatsApp to a phone somebody
-- else may be holding, and a figure there is a second door onto the agreement.
-- Template names start with finance_ / contract_, never payment_: format.ts routes any
-- payment_ template to the documents family.

create or replace function app.asset_finance_nightly(p_today date default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := coalesce(p_today, app.finance_today());
  r       record;
  v_end   date;
  v_n     integer;
begin
  -- 1. Contracts past their end date.
  for r in
    select c.id, c.end_date, c.renewal_months
      from public.asset_contracts c
     where c.deleted_at is null and c.status = 'active' and c.auto_renews
       and c.renewal_months is not null and c.end_date is not null and c.end_date < v_today
  loop
    v_n := 0;
    v_end := r.end_date;
    while v_end < v_today and v_n < 1200 loop
      v_n := v_n + 1;
      v_end := app.finance_add_months(r.end_date, r.renewal_months * v_n);
    end loop;
    update public.asset_contracts set end_date = v_end, updated_at = now() where id = r.id;
  end loop;

  update public.asset_contracts
     set status = 'ended', updated_at = now()
   where deleted_at is null and status = 'active' and not auto_renews
     and end_date is not null and end_date < v_today;

  -- 2. Debit orders.
  for r in
    select distinct i.agreement_id
      from public.finance_instalments i
      join public.finance_agreements a on a.id = i.agreement_id
     where a.auto_mark_paid and a.status = 'active' and a.deleted_at is null
       and i.deleted_at is null and i.status = 'open' and i.due_date <= v_today
  loop
    update public.finance_instalments
       set paid_cents = interest_cents + capital_cents + fee_cents,
           paid_on = due_date,
           status = 'paid',
           updated_at = now()
     where agreement_id = r.agreement_id and deleted_at is null and status = 'open'
       and due_date <= v_today;
    perform app.finance_close_if_paid(r.agreement_id);
  end loop;

  -- 3. The cost ledger, farm by farm.
  for r in
    select farm_id from public.finance_agreements
    union
    select farm_id from public.asset_contracts
  loop
    perform app.sync_asset_finance_costs(r.farm_id, v_today);
  end loop;
end
$$;

create or replace function app.enqueue_asset_finance_reminders(p_today date default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := coalesce(p_today, app.finance_today());
  r       record;
  v_sent  integer := 0;
begin
  -- (A) An instalment coming due.
  for r in
    select i.id, i.farm_id, i.seq, i.kind, i.due_date, a.id as agreement_id, a.lender,
           a.machine_id, m.name as machine_name, f.settings,
           (select count(*) from public.finance_instalments x
             where x.agreement_id = a.id and x.deleted_at is null and x.kind = 'instalment') as instalments
      from public.finance_instalments i
      join public.finance_agreements a on a.id = i.agreement_id
      join public.machines m on m.id = a.machine_id
      join public.farms f on f.id = i.farm_id
     where i.deleted_at is null and i.status = 'open' and i.reminded_at is null
       and a.deleted_at is null and a.status = 'active' and a.reminder_lead_days is not null
       and m.deleted_at is null
       and f.deleted_at is null and f.status in ('trial', 'active')
       and i.due_date between v_today and v_today + a.reminder_lead_days
  loop
    perform app.notify_farm(r.farm_id, 'finance_instalment_due',
      jsonb_build_object(
        'agreement_id', r.agreement_id, 'machine_id', r.machine_id, 'machine_name', r.machine_name,
        'lender', r.lender, 'seq', r.seq, 'count', r.instalments, 'kind', r.kind,
        'due_date', r.due_date),
      app.quiet_deliver_after(r.settings));
    update public.finance_instalments set reminded_at = now() where id = r.id;
    v_sent := v_sent + 1;
  end loop;

  -- (B) An instalment past due and not marked paid.
  for r in
    select i.id, i.farm_id, i.seq, i.kind, i.due_date, a.id as agreement_id, a.lender,
           a.machine_id, m.name as machine_name, f.settings
      from public.finance_instalments i
      join public.finance_agreements a on a.id = i.agreement_id
      join public.machines m on m.id = a.machine_id
      join public.farms f on f.id = i.farm_id
     where i.deleted_at is null and i.status = 'open' and i.overdue_reminded_at is null
       and a.deleted_at is null and a.status = 'active' and a.reminder_lead_days is not null
       and not a.auto_mark_paid
       and m.deleted_at is null
       and f.deleted_at is null and f.status in ('trial', 'active')
       and i.due_date < v_today and i.due_date >= v_today - 14
  loop
    perform app.notify_farm(r.farm_id, 'finance_instalment_overdue',
      jsonb_build_object(
        'agreement_id', r.agreement_id, 'machine_id', r.machine_id, 'machine_name', r.machine_name,
        'lender', r.lender, 'seq', r.seq, 'kind', r.kind, 'due_date', r.due_date),
      app.quiet_deliver_after(r.settings));
    update public.finance_instalments set overdue_reminded_at = now() where id = r.id;
    v_sent := v_sent + 1;
  end loop;

  -- (C) The last day to give notice on a contract.
  for r in
    select c.id, c.farm_id, c.party, c.notice_date, c.end_date, c.auto_renews, c.machine_id,
           m.name as machine_name, f.settings
      from public.asset_contracts c
      left join public.machines m on m.id = c.machine_id
      join public.farms f on f.id = c.farm_id
     where c.deleted_at is null and c.status = 'active' and c.reminder_lead_days is not null
       and c.notice_date is not null
       and c.notice_reminded_for is distinct from c.notice_date
       and (c.machine_id is null or m.deleted_at is null)
       and f.deleted_at is null and f.status in ('trial', 'active')
       and c.notice_date between v_today and v_today + c.reminder_lead_days
  loop
    perform app.notify_farm(r.farm_id, 'contract_notice_due',
      jsonb_build_object(
        'contract_id', r.id, 'machine_id', r.machine_id, 'machine_name', r.machine_name,
        'party', r.party, 'notice_date', r.notice_date, 'end_date', r.end_date,
        'auto_renews', r.auto_renews),
      app.quiet_deliver_after(r.settings));
    update public.asset_contracts set notice_reminded_for = r.notice_date where id = r.id;
    v_sent := v_sent + 1;
  end loop;

  -- (D) A contract coming to its end.
  for r in
    select c.id, c.farm_id, c.party, c.end_date, c.auto_renews, c.machine_id,
           m.name as machine_name, f.settings
      from public.asset_contracts c
      left join public.machines m on m.id = c.machine_id
      join public.farms f on f.id = c.farm_id
     where c.deleted_at is null and c.status = 'active' and c.reminder_lead_days is not null
       and c.end_date is not null
       and c.end_reminded_for is distinct from c.end_date
       and (c.machine_id is null or m.deleted_at is null)
       and f.deleted_at is null and f.status in ('trial', 'active')
       and c.end_date between v_today and v_today + c.reminder_lead_days
  loop
    perform app.notify_farm(r.farm_id, 'contract_ending',
      jsonb_build_object(
        'contract_id', r.id, 'machine_id', r.machine_id, 'machine_name', r.machine_name,
        'party', r.party, 'end_date', r.end_date, 'auto_renews', r.auto_renews),
      app.quiet_deliver_after(r.settings));
    update public.asset_contracts set end_reminded_for = r.end_date where id = r.id;
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end
$$;

revoke execute on function app.asset_finance_nightly(date) from public, anon, authenticated;
revoke execute on function app.enqueue_asset_finance_reminders(date) from public, anon, authenticated;
grant execute on function app.asset_finance_nightly(date) to service_role;
grant execute on function app.enqueue_asset_finance_reminders(date) to service_role;

-- == PostgREST-callable cron wrappers ==========================================
create or replace function public.cron_asset_finance_nightly()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.asset_finance_nightly(null);
end
$$;

create or replace function public.cron_enqueue_asset_finance_reminders()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform app.enqueue_asset_finance_reminders(null);
end
$$;

revoke execute on function public.cron_asset_finance_nightly() from public, anon, authenticated;
revoke execute on function public.cron_enqueue_asset_finance_reminders() from public, anon, authenticated;
grant execute on function public.cron_asset_finance_nightly() to service_role;
grant execute on function public.cron_enqueue_asset_finance_reminders() to service_role;
