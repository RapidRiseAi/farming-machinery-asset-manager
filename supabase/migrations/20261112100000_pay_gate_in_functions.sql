-- 20261112100000_pay_gate_in_functions.sql
-- The pay gate inside the functions that run as their owner, on notifications, and on files.
--
-- == Why =======================================================================
-- 20261112090000 put the gate on every table with a farm_id, as restrictive row-security
-- policies. A SECURITY DEFINER function runs as its owner, postgres, which bypasses row
-- security, so a member of a business that has not paid could still call one of them over
-- REST and change that business's records. This migration gives those functions the same
-- rule as the tables: one that WRITES a business's working data refuses a business whose
-- gate is not 'ok'; one that READS it refuses a 'pending' business, which has never paid.
--
-- == How =======================================================================
-- app.require_open_farm(farm, writing) raises sqlstate 42501 with the message
-- 'farm-not-active' (the code the app already translates, src/lib/errors.ts) when the caller
-- reaches that business and its gate stops them; Rapid Rise, a session with no user (the
-- service role, the crons) and a business the caller does not reach pass through, so the
-- function's own access check still decides those, and nothing is learned about a business
-- the caller does not belong to. Each changed function below is its last definition,
-- restated unchanged except for one call, placed after the function has found the business
-- and checked the caller. CREATE OR REPLACE keeps owner, grants and comments.
--
-- == Changed: writing refuses any stopped business (27) ==========================
-- Finance and contracts: asset_contract_delete, asset_contract_end, asset_contract_renew,
--   asset_contract_save, finance_clear_payment, finance_delete_agreement,
--   finance_record_payment, finance_regenerate_schedule, finance_save_agreement,
--   finance_settle_agreement, finance_update_instalment.
-- AI settings: ai_set_farm_limit, ai_set_farm_switches, ai_set_member_limit.
-- Work and driving: apply_assistant_proposal (a diesel draw by voice), correct_meter_reading,
--   record_driving_event, remove_job_card_line, set_machine_depreciation, trip_start,
--   trip_finish, trip_job_deliver, run_report_schedule.
-- The business's settings: set_company_type, update_farm_settings.
-- WhatsApp: whatsapp_begin_link, whatsapp_finish_link (linking a phone to the business).
--
-- == Changed: reading refuses a pending business (7) =============================
-- ai_farm_usage, driving_people, driving_vehicles, farm_book_values, fuel_tank_balances,
-- machine_financials (the export reads it for a suspended or closed business, which stays
-- allowed), and resolve_member_qr, which now finds nothing for any stopped business, as the
-- capture functions it leads to (record_public_qr_*) already do.
--
-- == Left open on purpose (50) =================================================
-- Paying and the gate: farm_billing_gate, farm_vehicle_allowance, update_farm_billing (the
--   invoice details), has_entitlement (a plan check, no records).
-- The person's own account and rights: ai_notice_ack, set_notification_prefs,
--   erase_personal_data and export_personal_data (privacy rights never wait on payment),
--   whatsapp_manage_link (disconnecting must always work; authorising writes no business
--   data and the assistant it enables is refused by the table policies),
--   whatsapp_link_status.
-- Help: open_help_request, reply_to_help_request, my_help_request, my_help_requests,
--   my_farm_support_visits, support_contact.
-- Rapid Rise staff, never stopped (is_rr_admin or is_rr_support inside): admin_client,
--   admin_set_user_active, ai_admin_month, configure_driver_connection, link_driver_device,
--   log_admin_farm_access, support_add_note, support_assign, support_badge,
--   support_holiday_remove, support_holiday_set, support_mark_emailed,
--   support_open_for_customer, support_overview, support_queue, support_reply,
--   support_set_status, support_staff, support_ticket, support_update_settings,
--   support_visit_end, support_visit_start.
-- A contractor's own books (contractor_open in app.pay_gate_rules): next_document_number,
--   revise_document, write_off_document, run_recurring_invoice, run_recurring_expense,
--   update_document_layout.
-- Plumbing with no business data: claim_request, finish_request, release_request,
--   rate_limit_take, consume_assistant_turn.
-- Already refuses: record_member_qr, whose writes go through record_public_qr_*, which
--   require app.farm_billing_gate = 'ok'.
-- These are all 84 SECURITY DEFINER functions in public that `authenticated` may execute on
-- 12 November 2026. The invoker functions (record_fault, fit_tyre and the rest) write as
-- the caller and are covered by the table policies.
--
-- == Notifications =============================================================
-- notifications_ins and notifications_del (0101) let any member of a business create a
-- notification addressed to anybody, and delete anybody's on that business. Every
-- notification is written by an owner-run function (app.notify_farm and its relatives), and
-- the app never inserts or deletes one through a person's session, so the insert policy
-- goes and a person may delete only their own (or Rapid Rise any), as notifications_upd
-- already says.
--
-- == Files =====================================================================
-- The farm buckets are written through the person's own session too (machine photos from
-- the browser, checklist photos, finance documents), and every path there starts with the
-- business's id. Restrictive pay_gate_* policies on storage.objects apply the table rule to
-- those buckets. partner-docs, partner-receipts and partner-branding are a contractor's own,
-- and billing-proofs is Rapid Rise's: not gated. Applied only where storage exists.

-- == The check =================================================================
create or replace function app.require_open_farm(p_farm uuid, p_writing boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_gate text;
begin
  if p_farm is null or auth.uid() is null or app.is_rr_admin() or not app.has_farm_access(p_farm) then
    return true;
  end if;
  v_gate := app.farm_billing_gate(p_farm);
  if v_gate = 'pending' or (p_writing and v_gate <> 'ok') then
    raise exception 'farm-not-active'
      using errcode = '42501',
            detail = format('This business is %s until its account is paid, so its records cannot be %s.',
                            v_gate, case when p_writing then 'changed' else 'read' end),
            hint = 'Pay on /activate, /suspended or /closed.';
  end if;
  return true;
end
$$;
revoke all on function app.require_open_farm(uuid, boolean) from public, anon, authenticated, service_role;
comment on function app.require_open_farm(uuid, boolean) is
  'Raises 42501 farm-not-active when the caller reaches this business and the pay gate stops '
  'it: writing while it is not ok, reading while it is pending. Called by the definer '
  'functions that act on a business''s records (20261112100000).';

-- == The functions =============================================================

-- asset_contract_delete
CREATE OR REPLACE FUNCTION public.asset_contract_delete(p_contract uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform app.require_open_farm(c.farm_id, true);

  update public.attachments
     set deleted_at = now(), deleted_by = auth.uid()
   where parent_type = 'asset_contract' and parent_id = c.id and farm_id = c.farm_id
     and deleted_at is null;
  update public.asset_contracts
     set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
   where id = c.id;

  perform app.sync_asset_finance_costs(c.farm_id);
end
$function$;

-- asset_contract_end
CREATE OR REPLACE FUNCTION public.asset_contract_end(p_contract uuid, p_end_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform app.require_open_farm(c.farm_id, true);
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
$function$;

-- asset_contract_renew
CREATE OR REPLACE FUNCTION public.asset_contract_renew(p_contract uuid, p_end_date date, p_amount_cents bigint DEFAULT NULL::bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform app.require_open_farm(c.farm_id, true);
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
$function$;

-- asset_contract_save
CREATE OR REPLACE FUNCTION public.asset_contract_save(p_contract uuid, p_farm uuid, p_fields jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform app.require_open_farm(v_farm, true);
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
$function$;

-- finance_clear_payment
CREATE OR REPLACE FUNCTION public.finance_clear_payment(p_instalment uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  i public.finance_instalments;
  a public.finance_agreements;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into i from public.finance_instalments x
   where x.id = p_instalment and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(i.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(i.farm_id, true);
  select x.* into a from public.finance_agreements x
   where x.id = i.agreement_id and x.deleted_at is null
   for update;
  -- Paid off by its instalments (settled at no charge) reopens; a real settlement does not.
  if a.status = 'settled' and coalesce(a.settlement_cents, 0) = 0 and i.status = 'paid' then
    update public.finance_agreements
       set status = 'active', settled_on = null, settlement_cents = null,
           settlement_charge_cents = null, updated_at = now()
     where id = a.id;
  elsif a.status is distinct from 'active' or i.status = 'settled' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;

  update public.finance_instalments
     set paid_cents = 0, paid_on = null, payment_reference = null, status = 'open', updated_at = now()
   where id = i.id;

  perform app.sync_asset_finance_costs(i.farm_id);
end
$function$;

-- finance_delete_agreement
CREATE OR REPLACE FUNCTION public.finance_delete_agreement(p_agreement uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  a public.finance_agreements;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into a from public.finance_agreements x
   where x.id = p_agreement and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(a.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(a.farm_id, true);

  update public.finance_instalments
     set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
   where agreement_id = a.id and deleted_at is null;
  update public.attachments
     set deleted_at = now(), deleted_by = auth.uid()
   where parent_type = 'finance_agreement' and parent_id = a.id and farm_id = a.farm_id
     and deleted_at is null;
  update public.finance_agreements
     set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
   where id = a.id;

  perform app.sync_asset_finance_costs(a.farm_id);
end
$function$;

-- finance_record_payment
CREATE OR REPLACE FUNCTION public.finance_record_payment(p_instalment uuid, p_amount_cents bigint DEFAULT NULL::bigint, p_paid_on date DEFAULT NULL::date, p_reference text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  i        public.finance_instalments;
  v_status text;
  v_amount bigint;
  v_on     date := coalesce(p_paid_on, app.finance_today());
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into i from public.finance_instalments x
   where x.id = p_instalment and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(i.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(i.farm_id, true);
  select a.status into v_status from public.finance_agreements a
   where a.id = i.agreement_id and a.deleted_at is null;
  if v_status is distinct from 'active' or i.status <> 'open' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;

  v_amount := coalesce(p_amount_cents, i.amount_cents - i.paid_cents);
  if v_amount <= 0 then
    raise exception 'finance-payment-amount' using errcode = '22023';
  end if;
  if i.paid_cents + v_amount > i.amount_cents then
    raise exception 'finance-payment-too-much' using errcode = '22023';
  end if;
  if v_on > app.finance_today() then
    raise exception 'finance-payment-future' using errcode = '22023';
  end if;

  update public.finance_instalments
     set paid_cents = i.paid_cents + v_amount,
         paid_on = v_on,
         payment_reference = coalesce(left(nullif(btrim(p_reference), ''), 80), payment_reference),
         status = case when i.paid_cents + v_amount >= i.amount_cents then 'paid' else 'open' end,
         updated_at = now()
   where id = i.id;

  perform app.finance_close_if_paid(i.agreement_id);
  perform app.sync_asset_finance_costs(i.farm_id);
  return i.paid_cents + v_amount;
end
$function$;

-- finance_regenerate_schedule
CREATE OR REPLACE FUNCTION public.finance_regenerate_schedule(p_agreement uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  a public.finance_agreements;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into a from public.finance_agreements x
   where x.id = p_agreement and x.deleted_at is null;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(a.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(a.farm_id, true);
  if a.status <> 'active' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;
  perform app.finance_rebuild_schedule(a.id);
  perform app.sync_asset_finance_costs(a.farm_id);
end
$function$;

-- finance_save_agreement
CREATE OR REPLACE FUNCTION public.finance_save_agreement(p_agreement uuid, p_machine uuid, p_fields jsonb, p_mark_paid_before date DEFAULT NULL::date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_old         public.finance_agreements;
  v_farm        uuid;
  v_machine     uuid;
  v_id          uuid;
  v_kind        text    := coalesce(nullif(btrim(p_fields ->> 'kind'), ''), 'instalment_sale');
  v_lender      text    := nullif(btrim(p_fields ->> 'lender'), '');
  v_number      text    := nullif(btrim(p_fields ->> 'agreement_number'), '');
  v_principal   bigint  := nullif(p_fields ->> 'principal_cents', '')::bigint;
  v_deposit     bigint  := coalesce(nullif(p_fields ->> 'deposit_cents', '')::bigint, 0);
  v_rate        integer := nullif(p_fields ->> 'interest_rate_bps', '')::integer;
  v_term        integer := nullif(p_fields ->> 'term_months', '')::integer;
  v_frequency   text    := coalesce(nullif(btrim(p_fields ->> 'frequency'), ''), 'monthly');
  v_instalment  bigint  := nullif(p_fields ->> 'instalment_cents', '')::bigint;
  v_fee         bigint  := coalesce(nullif(p_fields ->> 'fee_cents', '')::bigint, 0);
  v_balloon     bigint  := coalesce(nullif(p_fields ->> 'balloon_cents', '')::bigint, 0);
  v_start       date    := nullif(p_fields ->> 'start_date', '')::date;
  v_first       date    := nullif(p_fields ->> 'first_instalment_date', '')::date;
  v_auto        boolean := coalesce(nullif(p_fields ->> 'auto_mark_paid', '')::boolean, false);
  v_lead        integer := nullif(p_fields ->> 'reminder_lead_days', '')::integer;
  v_notes       text    := nullif(btrim(p_fields ->> 'notes'), '');
  v_stmt_cents  bigint  := nullif(p_fields ->> 'statement_balance_cents', '')::bigint;
  v_stmt_on     date    := nullif(p_fields ->> 'statement_balance_on', '')::date;
  v_step        integer;
  v_count       integer;
  v_terms       boolean := true;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_agreement is null then
    select m.farm_id, m.id into v_farm, v_machine
      from public.machines m
     where m.id = p_machine and m.deleted_at is null;
    if v_farm is null then
      raise exception 'finance-machine-invalid' using errcode = '22023';
    end if;
  else
    select * into v_old from public.finance_agreements
     where id = p_agreement and deleted_at is null
     for update;
    if not found then
      raise exception 'finance-not-found' using errcode = 'P0001';
    end if;
    v_farm := v_old.farm_id;
    v_machine := v_old.machine_id;
  end if;
  if not app.can_view_farm_finance(v_farm) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(v_farm, true);
  if v_old.id is not null and v_old.status <> 'active' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;

  -- What a person can put right, each named.
  if v_lender is null then
    raise exception 'finance-lender-required' using errcode = '22023';
  end if;
  if v_principal is null or v_principal <= 0 then
    raise exception 'finance-principal-required' using errcode = '22023';
  end if;
  if v_kind not in ('instalment_sale', 'loan', 'finance_lease', 'other')
     or v_frequency not in ('monthly', 'quarterly', 'biannual', 'annual') then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;
  v_step := app.finance_step_months(v_frequency);
  if v_term is null or v_term not between 1 and 360 then
    raise exception 'finance-term-required' using errcode = '22023';
  end if;
  if v_term % v_step <> 0 then
    raise exception 'finance-term-frequency' using errcode = '22023';
  end if;
  v_count := v_term / v_step;
  if v_start is null or v_first is null or v_first < v_start then
    raise exception 'finance-dates' using errcode = '22023';
  end if;
  if v_balloon < 0 or v_balloon >= v_principal then
    raise exception 'finance-balloon-too-large' using errcode = '22023';
  end if;
  if v_deposit < 0 or v_fee < 0 or (v_instalment is not null and v_instalment <= 0)
     or (v_lead is not null and v_lead not between 0 and 90) then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;
  if (v_stmt_cents is null) <> (v_stmt_on is null) or coalesce(v_stmt_cents, 0) < 0 then
    raise exception 'finance-statement-incomplete' using errcode = '22023';
  end if;

  -- No rate, but the lender's instalment: the rate it implies.
  if v_rate is null then
    if v_instalment is null then
      raise exception 'finance-rate-or-instalment' using errcode = '22023';
    end if;
    v_rate := app.finance_implied_rate_bps(v_principal, v_instalment - v_fee, v_count, v_step, v_balloon);
    if v_rate is null then
      if v_instalment - v_fee < app.finance_annuity_payment(v_principal, 0, v_count, v_step, v_balloon) then
        raise exception 'finance-instalment-too-low' using errcode = '22023';
      end if;
      raise exception 'finance-instalment-too-high' using errcode = '22023';
    end if;
  elsif v_rate not between 0 and 10000 then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;

  if v_old.id is null then
    insert into public.finance_agreements
      (farm_id, machine_id, kind, lender, agreement_number, principal_cents, deposit_cents,
       interest_rate_bps, term_months, frequency, instalment_cents, fee_cents, balloon_cents,
       start_date, first_instalment_date, auto_mark_paid, reminder_lead_days, notes,
       statement_balance_cents, statement_balance_on, created_by)
    values
      (v_farm, v_machine, v_kind, v_lender, v_number, v_principal, v_deposit,
       v_rate, v_term, v_frequency, v_instalment, v_fee, v_balloon,
       v_start, v_first, v_auto, v_lead, v_notes,
       v_stmt_cents, v_stmt_on, auth.uid())
    returning id into v_id;
  else
    v_id := v_old.id;
    v_terms := (v_old.principal_cents, v_old.interest_rate_bps, v_old.term_months, v_old.frequency,
                v_old.first_instalment_date, v_old.balloon_cents, v_old.instalment_cents, v_old.fee_cents)
               is distinct from
               (v_principal, v_rate, v_term, v_frequency, v_first, v_balloon, v_instalment, v_fee);
    update public.finance_agreements
       set kind = v_kind, lender = v_lender, agreement_number = v_number,
           principal_cents = v_principal, deposit_cents = v_deposit, interest_rate_bps = v_rate,
           term_months = v_term, frequency = v_frequency, instalment_cents = v_instalment,
           fee_cents = v_fee, balloon_cents = v_balloon, start_date = v_start,
           first_instalment_date = v_first, auto_mark_paid = v_auto, reminder_lead_days = v_lead,
           notes = v_notes, statement_balance_cents = v_stmt_cents,
           statement_balance_on = v_stmt_on, updated_at = now()
     where id = v_id;
  end if;

  if v_terms then
    perform app.finance_rebuild_schedule(v_id);
  end if;

  if v_old.id is null and p_mark_paid_before is not null then
    update public.finance_instalments
       set paid_cents = interest_cents + capital_cents + fee_cents,
           paid_on = due_date,
           status = 'paid',
           updated_at = now()
     where agreement_id = v_id and deleted_at is null and status = 'open'
       and due_date < p_mark_paid_before;
    perform app.finance_close_if_paid(v_id);
  end if;

  perform app.sync_asset_finance_costs(v_farm);
  return v_id;
end
$function$;

-- finance_settle_agreement
CREATE OR REPLACE FUNCTION public.finance_settle_agreement(p_agreement uuid, p_settled_on date, p_settlement_cents bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  a             public.finance_agreements;
  v_outstanding bigint;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into a from public.finance_agreements x
   where x.id = p_agreement and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(a.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(a.farm_id, true);
  if a.status <> 'active' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;
  if p_settled_on is null or p_settled_on < a.start_date or p_settled_on > app.finance_today() then
    raise exception 'finance-settle-date' using errcode = '22023';
  end if;
  if p_settlement_cents is null or p_settlement_cents < 0 then
    raise exception 'finance-payment-amount' using errcode = '22023';
  end if;

  select greatest(a.principal_cents - coalesce(sum(
           least(greatest(i.paid_cents - i.interest_cents - i.fee_cents, 0), i.capital_cents)), 0), 0)
    into v_outstanding
    from public.finance_instalments i
   where i.agreement_id = a.id and i.deleted_at is null;

  update public.finance_instalments
     set status = 'settled', updated_at = now()
   where agreement_id = a.id and deleted_at is null and status = 'open';

  update public.finance_agreements
     set status = 'settled',
         settled_on = p_settled_on,
         settlement_cents = p_settlement_cents,
         settlement_charge_cents = greatest(p_settlement_cents - v_outstanding, 0),
         updated_at = now()
   where id = a.id;

  perform app.sync_asset_finance_costs(a.farm_id);
end
$function$;

-- finance_update_instalment
CREATE OR REPLACE FUNCTION public.finance_update_instalment(p_instalment uuid, p_due_date date, p_amount_cents bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  i        public.finance_instalments;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select x.* into i from public.finance_instalments x
   where x.id = p_instalment and x.deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;
  if not app.can_view_farm_finance(i.farm_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(i.farm_id, true);
  select a.status into v_status from public.finance_agreements a
   where a.id = i.agreement_id and a.deleted_at is null;
  if v_status is distinct from 'active' or i.status <> 'open' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;
  if p_due_date is null or p_amount_cents is null then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;
  if p_amount_cents < i.interest_cents + i.fee_cents then
    raise exception 'finance-instalment-below-interest' using errcode = '22023';
  end if;
  if p_amount_cents < i.paid_cents then
    raise exception 'finance-payment-too-much' using errcode = '22023';
  end if;

  update public.finance_instalments
     set due_date = p_due_date,
         capital_cents = p_amount_cents - i.interest_cents - i.fee_cents,
         -- A moved date is reminded about again.
         reminded_at = case when p_due_date <> i.due_date then null else reminded_at end,
         overdue_reminded_at = case when p_due_date <> i.due_date then null else overdue_reminded_at end,
         status = case when i.paid_cents >= p_amount_cents then 'paid' else 'open' end,
         updated_at = now()
   where id = i.id;

  perform app.finance_recompute_balances(i.agreement_id);
  update public.finance_agreements
     set end_date = (select max(due_date) from public.finance_instalments
                      where agreement_id = i.agreement_id and deleted_at is null),
         updated_at = now()
   where id = i.agreement_id;
  perform app.finance_close_if_paid(i.agreement_id);
  perform app.sync_asset_finance_costs(i.farm_id);
end
$function$;

-- ai_set_farm_limit
CREATE OR REPLACE FUNCTION public.ai_set_farm_limit(p_farm uuid, p_limit_cents bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_max bigint;
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can change the AI limit.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  v_max := app.ai_max_owner_limit(p_farm);
  -- Until the farm has paid, the trial limit caps whatever is set, for a Rapid Rise admin
  -- too (ai_effective_limit applies it), so a higher value is refused rather than saved
  -- and silently ignored.
  if p_limit_cents is not null and not app.ai_farm_has_paid(p_farm) and p_limit_cents > v_max then
    return jsonb_build_object('ok', false, 'reason', 'trial_limit', 'max_limit_cents', v_max);
  end if;
  if p_limit_cents is not null and (p_limit_cents < 0 or (p_limit_cents > v_max and not app.is_rr_admin())) then
    return jsonb_build_object('ok', false, 'reason', 'limit_out_of_range', 'max_limit_cents', v_max);
  end if;
  insert into public.farm_ai_settings (farm_id, monthly_limit_cents, updated_by, updated_at)
  values (p_farm, p_limit_cents, auth.uid(), now())
  on conflict (farm_id) do update
    set monthly_limit_cents = excluded.monthly_limit_cents, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'limit_cents', app.ai_effective_limit(p_farm));
end $function$;

-- ai_set_farm_switches
CREATE OR REPLACE FUNCTION public.ai_set_farm_switches(p_farm uuid, p_ai_enabled boolean, p_voice_enabled boolean, p_own_key_fallback text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can change AI settings.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  if p_own_key_fallback is not null and p_own_key_fallback not in ('pause', 'platform') then
    return jsonb_build_object('ok', false, 'reason', 'bad_fallback');
  end if;
  insert into public.farm_ai_settings (farm_id) values (p_farm) on conflict (farm_id) do nothing;
  update public.farm_ai_settings
     set ai_enabled = coalesce(p_ai_enabled, ai_enabled),
         voice_enabled = coalesce(p_voice_enabled, voice_enabled),
         own_key_fallback = coalesce(p_own_key_fallback, own_key_fallback),
         updated_by = auth.uid(), updated_at = now()
   where farm_id = p_farm;
  return jsonb_build_object('ok', true);
end $function$;

-- ai_set_member_limit
CREATE OR REPLACE FUNCTION public.ai_set_member_limit(p_farm uuid, p_user uuid, p_limit_cents bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can change AI limits.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  -- Rapid Rise staff are not members for this purpose: their support use is internal.
  if app.ai_member_role(p_user, p_farm) is null or app.ai_member_role(p_user, p_farm) = 'rr_admin' then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  if p_limit_cents is null then
    delete from public.farm_member_ai_limits where farm_id = p_farm and user_id = p_user;
  elsif p_limit_cents < 0 or (p_limit_cents > app.ai_max_owner_limit(p_farm) and not app.is_rr_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'limit_out_of_range', 'max_limit_cents', app.ai_max_owner_limit(p_farm));
  else
    insert into public.farm_member_ai_limits (farm_id, user_id, monthly_limit_cents, updated_by, updated_at)
    values (p_farm, p_user, p_limit_cents, auth.uid(), now())
    on conflict (farm_id, user_id) do update
      set monthly_limit_cents = excluded.monthly_limit_cents, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- ai_farm_usage
CREATE OR REPLACE FUNCTION public.ai_farm_usage(p_farm uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_month date := app.ai_month(now());
begin
  if not app.is_farm_billing_admin(p_farm) then
    raise exception 'Only the farm owner can see AI and voice usage.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, false);
  return jsonb_build_object(
    'month', v_month,
    'limit_cents', app.ai_effective_limit(p_farm),
    'has_paid', app.ai_farm_has_paid(p_farm),
    'max_limit_cents', app.ai_max_owner_limit(p_farm),
    'billed_cents', coalesce((select sum(billed_cents) from public.ai_usage
                               where farm_id = p_farm and month = v_month and credential = 'platform'), 0),
    'held_cents', coalesce((select sum(estimate_cents) from public.ai_reservations
                             where farm_id = p_farm and month = v_month and settled_at is null
                               and credential = 'platform'), 0),
    'settings', (select to_jsonb(s) - 'warned_80' - 'warned_100' from public.farm_ai_settings s where s.farm_id = p_farm),
    'key', (select jsonb_build_object('hint', k.hint, 'status', k.status, 'checked_at', k.checked_at)
              from public.farm_ai_keys k where k.farm_id = p_farm),
    'people', coalesce((
      select jsonb_agg(p order by p->>'name') from (
        select jsonb_build_object(
          'user_id', u.id,
          'name', coalesce(nullif(btrim(u.name), ''), u.email),
          'voice_seconds', coalesce((select sum(coalesce(x.audio_ms, 0) + coalesce(x.audio_fixed_ms, 0)) / 1000
                                       from public.ai_usage x where x.farm_id = p_farm and x.user_id = u.id
                                        and x.month = v_month and x.feature = 'voice'), 0),
          'ai_requests', (select count(*) from public.ai_usage x where x.farm_id = p_farm and x.user_id = u.id
                            and x.month = v_month and x.feature <> 'voice' and x.outcome in ('ok', 'fallback')),
          'billed_cents', coalesce((select sum(x.billed_cents) from public.ai_usage x where x.farm_id = p_farm
                                     and x.user_id = u.id and x.month = v_month and x.credential = 'platform'), 0),
          'limit_cents', (select l.monthly_limit_cents from public.farm_member_ai_limits l
                           where l.farm_id = p_farm and l.user_id = u.id)
        ) as p
        from public.users u
       -- Everyone who belongs to the farm (home farm or membership), so a limit can be set
       -- before someone's first use, and anyone billed this month. Never Rapid Rise staff:
       -- their support use is internal, not billed, and a limit would never apply to it.
       where u.role <> 'rr_admin'
         and u.id in (select user_id from public.ai_usage where farm_id = p_farm and month = v_month
                                                             and credential = 'platform'
                      union select user_id from public.farm_member_ai_limits where farm_id = p_farm
                      union select id from public.users where farm_id = p_farm and active and deleted_at is null
                      union select m.user_id from public.user_farm_memberships m
                             where m.farm_id = p_farm and m.active and m.deleted_at is null)
      ) people), '[]'::jsonb),
    -- The five months before this one; this month is the card at the top.
    'months', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'billed_cents', m.billed) order by m.month desc)
        from (select month, sum(billed_cents) as billed from public.ai_usage
               where farm_id = p_farm and credential = 'platform'
                 and month >= (v_month - interval '5 months')::date and month < v_month
               group by month) m), '[]'::jsonb)
  );
end $function$;

-- apply_assistant_proposal
CREATE OR REPLACE FUNCTION public.apply_assistant_proposal(p_proposal_id uuid, p_action text, p_expected_farm uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare v_user uuid:=auth.uid(); v_proposal_farm uuid;
begin
  if v_user is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  if p_proposal_id is null or p_action is null or p_expected_farm is null or p_action not in ('confirm','reject') then
    return jsonb_build_object('ok',false,'code','bad_request','message','A proposal ID, selected farm, and confirm/reject action are required.');
  end if;
  if auth.jwt()->>'fw_channel'='whatsapp' then
    perform 1 from public.whatsapp_links where id::text=auth.jwt()->>'fw_link_id' and user_id=v_user for update;
    if not found or not app.whatsapp_scope(p_expected_farm) then
      raise exception 'WhatsApp authorization expired.' using errcode='42501';
    end if;
  end if;
  select i.farm_id into v_proposal_farm from public.ai_interactions i
    where i.id=p_proposal_id and i.user_id=v_user and i.deleted_at is null for update;
  if not found then raise exception 'Proposal not found.' using errcode='42501'; end if;
  if v_proposal_farm is distinct from p_expected_farm then
    return jsonb_build_object('ok',false,'code','farm_context_changed','message','The selected farm changed after this proposal was prepared.');
  end if;
  perform app.require_open_farm(v_proposal_farm, true);
  return public.apply_assistant_proposal_internal(p_proposal_id,p_action);
end $function$;

-- correct_meter_reading
CREATE OR REPLACE FUNCTION public.correct_meter_reading(p_farm uuid, p_machine uuid, p_reading uuid, p_reason text DEFAULT NULL::text)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'app', 'pg_temp'
AS $function$
declare
  v_role user_role;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_reading numeric;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required.' using errcode = '42501';
  end if;
  v_role := app.effective_farm_role(auth.uid(), p_farm);
  if v_role is null or v_role not in ('rr_admin','owner','manager') then
    raise exception 'Only this farm''s owner or manager may correct a meter reading.'
      using errcode = '42501';
  end if;
  if not app.has_farm_access(p_farm) then
    raise exception 'Farm access denied.' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  if v_reason is not null and char_length(v_reason) > 500 then
    raise exception 'That reason is too long.' using errcode = '22023';
  end if;

  -- The UPDATE is RLS-checked in its own right; this is here so a wrong id is a sentence
  -- rather than a silent no-op.
  perform 1
     from public.meter_readings mr
    where mr.id = p_reading
      and mr.machine_id = p_machine
      and mr.farm_id = p_farm
      and mr.deleted_at is null
    for update;
  if not found then
    raise exception 'That meter reading was not found.' using errcode = '42501';
  end if;

  -- The only write. `app_meter_reading_voided` (above) rolls the machine back and
  -- recalculates, so a void performed any other way behaves identically.
  update public.meter_readings
     set deleted_at = now(),
         deleted_by = auth.uid(),
         voided_reason = v_reason
   where id = p_reading
     and farm_id = p_farm;

  select er.reading into v_reading from app.machine_effective_reading(p_machine) er;
  return v_reading;
end $function$;

-- record_driving_event
CREATE OR REPLACE FUNCTION public.record_driving_event(p_farm uuid, p_machine uuid, p_driver uuid, p_kind text, p_at timestamp with time zone DEFAULT now(), p_location text DEFAULT NULL::text, p_notes text DEFAULT NULL::text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_session uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r user_role;
begin
  r:=app.effective_farm_role(auth.uid(),p_farm);
  if auth.uid() is null or r is null or (p_driver<>auth.uid() and r not in ('owner','manager','rr_admin'))
    or not app.driver_member(auth.uid(),p_farm) then raise exception 'forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(p_farm, true);
  -- Lock in the same order as the internal writer before checking a stale dialog.
  perform 1 from farms where id=p_farm for update;
  if p_session is not null and not exists(select 1 from driving_sessions where id=p_session and farm_id=p_farm and machine_id=p_machine and driver_id=p_driver and ended_at is null) then
    raise exception 'session_changed' using errcode='22023'; end if;
  return app.write_driving_event(p_farm,p_machine,p_driver,p_kind,p_at,p_location,p_notes,p_lat,p_lng,auth.uid(),null,null);
end $function$;

-- remove_job_card_line
CREATE OR REPLACE FUNCTION public.remove_job_card_line(p_job uuid, p_line uuid, p_version timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare card public.job_cards%rowtype; item public.job_card_lines%rowtype;
begin
  if auth.uid() is null or not app.job_card_worker(auth.uid(),p_job) then
    raise exception 'forbidden' using errcode='42501'; end if;
  select * into card from public.job_cards where id=p_job and deleted_at is null for update;
  if not found then raise exception 'not_found' using errcode='P0002'; end if;
  perform app.require_open_farm(card.farm_id, true);
  select * into item from public.job_card_lines where id=p_line and job_card_id=p_job and farm_id=card.farm_id for update;
  if not found then return false; end if;
  if item.deleted_at is not null then return true; end if;
  if card.locked or card.status in ('completed','approved') then
    raise exception 'The work record is complete.' using errcode='23514'; end if;
  if p_version is null or item.updated_at is distinct from p_version then return false; end if;
  update public.job_card_lines set deleted_at=clock_timestamp(),deleted_by=auth.uid() where id=p_line;
  return true;
end $function$;

-- set_machine_depreciation
CREATE OR REPLACE FUNCTION public.set_machine_depreciation(p_machine uuid, p_method depreciation_method, p_rate_bps integer DEFAULT NULL::integer, p_life_months integer DEFAULT NULL::integer, p_residual_cents bigint DEFAULT NULL::bigint, p_start date DEFAULT NULL::date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_farm uuid;
begin
  select farm_id into v_farm from public.machines
   where id = p_machine and deleted_at is null;
  if v_farm is null then
    raise exception 'Machine not found.' using errcode = 'P0002';
  end if;
  -- Definer, so the farm and the role are both checked here by hand. `has_farm_access`
  -- alone would let a linked workshop set a customer's book-value policy.
  if not app.has_farm_access(v_farm)
     or app.current_app_role() not in ('rr_admin', 'owner', 'manager') then
    raise exception 'Only the owner or a manager may set a book-value policy.'
      using errcode = '42501';
  end if;
  perform app.require_open_farm(v_farm, true);

  update public.machines
     set depreciation_method     = p_method,
         depreciation_rate_bps   = case when p_method = 'reducing_balance' then p_rate_bps end,
         useful_life_months      = case when p_method = 'straight_line' then p_life_months end,
         residual_value_cents    = case when p_method = 'none' then null else p_residual_cents end,
         depreciation_start_date = case when p_method = 'none' then null else p_start end
   where id = p_machine;
end $function$;

-- trip_start
CREATE OR REPLACE FUNCTION public.trip_start(p_trip uuid, p_reading numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v public.trips%rowtype;
  v_session uuid;
begin
  select * into v from public.trips where id = p_trip and deleted_at is null for update;
  if not found then raise exception 'no such trip' using errcode = 'P0002'; end if;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  perform app.require_open_farm(v.farm_id, true);
  if v.status <> 'planned' then raise exception 'this trip has already started' using errcode = '22023'; end if;
  update public.trips set status = 'underway', started_at = now(), opening_reading = p_reading where id = p_trip;

  if v.driver_id is not null then
    select id into v_session from public.driving_sessions
     where machine_id = v.machine_id and driver_id = v.driver_id and ended_at is null;
    if v_session is null then
      begin
        perform app.write_driving_event(v.farm_id, v.machine_id, v.driver_id, 'start', now(),
                                        left(v.origin, 200), null, null, null, auth.uid(), null, null);
        select id into v_session from public.driving_sessions
         where machine_id = v.machine_id and driver_id = v.driver_id and ended_at is null;
      exception when sqlstate '22023' or sqlstate '42501' then
        -- Driving something else, or the vehicle is with somebody else: the trip goes ahead.
        v_session := null;
      end;
    end if;
    update public.trips set driving_session_id = v_session where id = p_trip;
  end if;
end $function$;

-- trip_finish
CREATE OR REPLACE FUNCTION public.trip_finish(p_trip uuid, p_reading numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v public.trips%rowtype;
begin
  select * into v from public.trips where id = p_trip and deleted_at is null for update;
  if not found then raise exception 'no such trip' using errcode = 'P0002'; end if;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  perform app.require_open_farm(v.farm_id, true);
  if v.status <> 'underway' then raise exception 'this trip is not underway' using errcode = '22023'; end if;
  if p_reading is not null and v.opening_reading is not null and p_reading < v.opening_reading then
    raise exception 'the closing reading is below the opening reading' using errcode = '22023';
  end if;
  update public.trips set status = 'completed', ended_at = now(), closing_reading = p_reading where id = p_trip;

  if v.driving_session_id is not null
     and exists (select 1 from public.driving_sessions where id = v.driving_session_id and ended_at is null) then
    begin
      perform app.write_driving_event(v.farm_id, v.machine_id, v.driver_id, 'end', now(),
                                      left(v.destination, 200), null, null, null, auth.uid(), null, null);
    exception when sqlstate '22023' or sqlstate '42501' then
      null;
    end;
  end if;
end $function$;

-- trip_job_deliver
CREATE OR REPLACE FUNCTION public.trip_job_deliver(p_job uuid, p_status text, p_received_by text, p_note text, p_photo text, p_signature text, p_lat double precision, p_lng double precision)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  j public.trip_jobs%rowtype;
  v public.trips%rowtype;
begin
  select * into j from public.trip_jobs where id = p_job and deleted_at is null for update;
  if not found then raise exception 'no such job' using errcode = 'P0002'; end if;
  select * into v from public.trips where id = j.trip_id;
  if v.driver_id is distinct from auth.uid() and not app.trips_manager(v.farm_id) then
    raise exception 'this trip is not yours' using errcode = '42501';
  end if;
  perform app.require_open_farm(v.farm_id, true);
  if j.status <> 'pending' then raise exception 'this has already been closed' using errcode = '22023'; end if;
  if p_status not in ('delivered', 'failed') then raise exception 'unknown outcome' using errcode = '22023'; end if;
  if p_status = 'delivered' and coalesce(btrim(p_received_by), '') = '' then
    raise exception 'say who received it' using errcode = '22023';
  end if;
  update public.trip_jobs
     set status = p_status, delivered_at = now(), received_by = nullif(btrim(p_received_by), ''),
         pod_note = nullif(btrim(p_note), ''), pod_photo_path = p_photo, pod_signature_path = p_signature,
         pod_lat = p_lat, pod_lng = p_lng
   where id = p_job;
end $function$;

-- run_report_schedule
CREATE OR REPLACE FUNCTION public.run_report_schedule(p_id uuid)
 RETURNS TABLE(run_id uuid, schedule_id uuid, farm_id uuid, farm_name text, schedule_name text, report_key report_family, output_format report_format, lang app_language, period_start date, period_end date, include_inactive boolean, site text, recipients text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_farm uuid;
  v_role public.user_role;
begin
  select s.farm_id
    into v_farm
    from public.report_schedules s
   where s.id = p_id
     and s.deleted_at is null;

  if v_farm is null then
    raise exception 'schedule not found' using errcode = 'P0002';
  end if;

  if not app.is_rr_admin() then
    v_role := app.effective_farm_role(auth.uid(), v_farm);
    if v_role is distinct from 'owner' and v_role is distinct from 'manager' then
      raise exception 'That schedule belongs to another farm.' using errcode = '42501';
    end if;
  end if;
  perform app.require_open_farm(v_farm, true);

  return query
    select * from app.run_due_report_schedules(p_id, null);
end;
$function$;

-- set_company_type
CREATE OR REPLACE FUNCTION public.set_company_type(p_farm uuid, p_type text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(app.effective_farm_role(auth.uid(), p_farm)::text, '') not in ('owner', 'manager') then
    raise exception 'only the owner or a manager can change this' using errcode = '42501';
  end if;
  perform app.require_open_farm(p_farm, true);
  update public.farms set company_type = p_type where id = p_farm;
end $function$;

-- update_farm_settings
CREATE OR REPLACE FUNCTION public.update_farm_settings(p_farm uuid, p_settings jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not app.is_rr_admin()
     and not exists (
       select 1 from users
       where id = auth.uid() and farm_id = p_farm and role in ('owner','manager')
         and active and deleted_at is null
     ) then
    raise exception 'not allowed to change settings for this farm';
  end if;
  perform app.require_open_farm(p_farm, true);
  update farms set settings = coalesce(settings, '{}'::jsonb) || p_settings where id = p_farm;
end $function$;

-- whatsapp_begin_link
CREATE OR REPLACE FUNCTION public.whatsapp_begin_link(p_farm uuid, p_phone text, p_hash text, p_notifications boolean, p_assistant boolean)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id uuid;
begin
  if auth.jwt()->>'fw_channel'='whatsapp' or not app.whatsapp_member(auth.uid(),p_farm)
    or not (p_notifications or p_assistant) then raise exception 'Forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(p_farm, true);
  -- Serializes rate limits and challenge replacement for this person.
  perform 1 from public.users where id=auth.uid() for update;
  if (select count(*) from public.whatsapp_link_challenges where user_id=auth.uid()
       and created_at>now()-interval '1 hour') >= 5 then
    raise exception 'Link rate limit' using errcode='P0001';
  end if;
  update public.whatsapp_link_challenges set consumed_at=now() where user_id=auth.uid() and consumed_at is null;
  insert into public.whatsapp_link_challenges(user_id,farm_id,phone,token_hash,notifications_enabled,assistant_enabled)
    values(auth.uid(),p_farm,p_phone,p_hash,p_notifications,p_assistant) returning id into v_id;
  return v_id;
end $function$;

-- whatsapp_finish_link
CREATE OR REPLACE FUNCTION public.whatsapp_finish_link(p_challenge uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.whatsapp_link_challenges%rowtype; v_id uuid;
begin
  if auth.jwt()->>'fw_channel'='whatsapp' then raise exception 'Forbidden' using errcode='42501'; end if;
  perform 1 from public.users where id=auth.uid() for update;
  select * into c from public.whatsapp_link_challenges where id=p_challenge and user_id=auth.uid() for update;
  if not found or c.consumed_at is not null or c.expires_at<=now() or c.verified_at is null
     or not app.whatsapp_member(auth.uid(),c.farm_id) then
    raise exception 'Link not verified or expired' using errcode='42501';
  end if;
  perform app.require_open_farm(c.farm_id, true);
  -- A number cannot be silently stolen from another account, even after expiry.
  if exists(select 1 from public.whatsapp_links where phone=c.phone and user_id<>auth.uid() and revoked_at is null) then
    raise exception 'Number unavailable' using errcode='23505';
  end if;
  update public.whatsapp_links set revoked_at=now(),conversation=null where user_id=auth.uid() and revoked_at is null;
  insert into public.whatsapp_links(user_id,farm_id,phone,notifications_enabled,assistant_enabled)
    values(c.user_id,c.farm_id,c.phone,c.notifications_enabled,c.assistant_enabled) returning id into v_id;
  update public.whatsapp_link_challenges set consumed_at=now() where id=c.id;
  return v_id;
end $function$;

-- driving_people
CREATE OR REPLACE FUNCTION public.driving_people(p_farm uuid)
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select u.id,u.name from users u where app.require_open_farm(p_farm, false) and app.driver_member(u.id,p_farm)
    and (u.id=auth.uid() or app.effective_farm_role(auth.uid(),p_farm) in ('owner','manager','rr_admin')) order by u.name;
$function$;

-- driving_vehicles
CREATE OR REPLACE FUNCTION public.driving_vehicles(p_farm uuid)
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.id,m.name from machines m where app.require_open_farm(p_farm, false) and m.farm_id=p_farm and m.deleted_at is null
    and m.status not in ('retired','sold') and app.driver_member(auth.uid(),p_farm) order by m.name;
$function$;

-- farm_book_values
CREATE OR REPLACE FUNCTION public.farm_book_values(p_farm uuid, p_on date DEFAULT NULL::date)
 RETURNS TABLE(machine_id uuid, name text, reg_no text, type machine_type, status machine_status, purchase_date date, purchase_price_cents bigint, method depreciation_method, rate_bps integer, life_months integer, residual_value_cents bigint, start_date date, months_held integer, book_value_cents bigint, depreciated_cents bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    m.id,
    m.name,
    m.reg_no,
    m.type,
    m.status,
    m.purchase_date,
    m.purchase_price_cents,
    m.depreciation_method,
    m.depreciation_rate_bps,
    m.useful_life_months,
    m.residual_value_cents,
    coalesce(m.depreciation_start_date, m.purchase_date),
    app.months_between(
      coalesce(m.depreciation_start_date, m.purchase_date),
      coalesce(p_on, current_date)),
    app.book_value_cents(
      m.purchase_price_cents, m.depreciation_method, m.depreciation_rate_bps,
      m.useful_life_months, m.residual_value_cents,
      coalesce(m.depreciation_start_date, m.purchase_date), coalesce(p_on, current_date)),
    m.purchase_price_cents - app.book_value_cents(
      m.purchase_price_cents, m.depreciation_method, m.depreciation_rate_bps,
      m.useful_life_months, m.residual_value_cents,
      coalesce(m.depreciation_start_date, m.purchase_date), coalesce(p_on, current_date))
  from public.machines m
  where m.farm_id = p_farm
    and app.require_open_farm(p_farm, false)
    and m.deleted_at is null
    -- Sold and retired machines are left out of a register of what to insure. They are
    -- still in the audit trail and in the cost history; they are not assets to cover.
    and m.status not in ('sold', 'retired')
    and app.can_view_farm_costs(m.farm_id)
    -- Book value is asset analytics, a Professional feature (20261104220000). The purchase
    -- price itself stays a record every plan keeps (machine detail, sale pack); this is
    -- the depreciated register built from it.
    and (app.is_rr_admin() or app.has_entitlement(m.farm_id, 'tco'))
    and (
      app.row_visible_to_role(m.farm_id, m.id)
      or (app.is_farm_side() and app.has_permission(m.farm_id, 'see_all_vehicles'))
    )
  order by m.name;
$function$;

-- fuel_tank_balances
CREATE OR REPLACE FUNCTION public.fuel_tank_balances(p_farm uuid DEFAULT NULL::uuid)
 RETURNS TABLE(tank_id uuid, delivered_litres numeric, issued_litres numeric, balance_litres numeric, dipped_on date, dip_litres numeric, book_at_dip_litres numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select t.id,
         coalesce(d.total, 0),
         coalesce(i.total, 0),
         coalesce(d.total, 0) - coalesce(i.total, 0),
         dip.dipped_on,
         dip.litres,
         case when dip.dipped_on is null then null else
             coalesce((select sum(fd.litres) from public.fuel_deliveries fd
                        where fd.tank_id = t.id and fd.farm_id = t.farm_id
                          and fd.deleted_at is null and fd.date <= dip.dipped_on), 0)
           - coalesce((select sum(fi.litres) from public.fuel_issues fi
                        where fi.tank_id = t.id and fi.farm_id = t.farm_id
                          and fi.deleted_at is null and fi.date <= dip.dipped_on), 0)
         end
    from public.fuel_tanks t
    left join lateral (
      select sum(fd.litres) as total from public.fuel_deliveries fd
       where fd.tank_id = t.id and fd.farm_id = t.farm_id and fd.deleted_at is null
    ) d on true
    left join lateral (
      select sum(fi.litres) as total from public.fuel_issues fi
       where fi.tank_id = t.id and fi.farm_id = t.farm_id and fi.deleted_at is null
    ) i on true
    left join lateral (
      select x.dipped_on, x.litres from public.fuel_dips x
       where x.tank_id = t.id and x.farm_id = t.farm_id and x.deleted_at is null
       order by x.dipped_on desc, x.created_at desc
       limit 1
    ) dip on true
   where t.deleted_at is null
     and (p_farm is null or t.farm_id = p_farm)
     and app.has_farm_access(t.farm_id)
     and app.require_open_farm(t.farm_id, false)
     and app.partner_scope(t.farm_id, 'costs')
   order by t.name, t.id;
$function$;

-- machine_financials
CREATE OR REPLACE FUNCTION public.machine_financials(p_machine uuid)
 RETURNS TABLE(machine_id uuid, farm_id uuid, purchase_price_cents bigint, supplier text, finance_provider text, finance_total_cents bigint, finance_monthly_cents bigint, finance_term_months integer, finance_interest_bps integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select
    m.id,
    m.farm_id,
    m.purchase_price_cents,
    m.supplier,
    m.finance_provider,
    m.finance_total_cents,
    m.finance_monthly_cents,
    m.finance_term_months,
    m.finance_interest_bps
  from public.machines m
  where m.id = p_machine
    and m.deleted_at is null
    and app.can_view_farm_costs(m.farm_id)
    and app.require_open_farm(m.farm_id, false)
    and (
      app.row_visible_to_role(m.farm_id, m.id)
      or (app.is_farm_side() and app.has_permission(m.farm_id, 'see_all_vehicles'))
    );
$function$;

-- resolve_member_qr
CREATE OR REPLACE FUNCTION public.resolve_member_qr(p_token uuid)
 RETURNS TABLE(id uuid, farm_id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select m.id,m.farm_id,m.name from machines m join farms f on f.id=m.farm_id
  where m.public_token=p_token and m.deleted_at is null and f.deleted_at is null
    and f.status in ('trial','active') and app.farm_billing_gate(m.farm_id) = 'ok' and app.driver_member(auth.uid(),m.farm_id);
$function$;

-- == Notifications are addressed by the system, not by members =================
drop policy if exists notifications_ins on public.notifications;
revoke insert on public.notifications from authenticated;
drop policy if exists notifications_del on public.notifications;
create policy notifications_del on public.notifications for delete to authenticated
  using (app.is_rr_admin() or user_id = (select auth.uid()));

-- == Files in the farm buckets =================================================
-- The same expression as the table policies, with the business read from the path's first
-- folder (app.finance_storage_farm: null for anything that is not a business id). A
-- function, so the suite can apply it to a stand-in storage.objects where there is none.
create or replace function app.pay_gate_storage_apply()
returns integer
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_cmd  text;
  v_test text;
begin
  if to_regclass('storage.objects') is null then
    return 0;
  end if;
  foreach v_cmd in array array['select', 'insert', 'update', 'delete'] loop
    execute format('drop policy if exists %I on storage.objects', 'pay_gate_' || v_cmd);
    v_test := format(
      '(bucket_id <> all (array[''machine-photos'', ''machine-docs'', ''fault-photos'', ''fault-voice'', '
      '''jobcard-photos'', ''checklist-photos'', ''finance-docs'']) '
      'or app.finance_storage_farm(name) is null '
      'or app.finance_storage_farm(name) <> all (array(select app.stopped_farm_ids(%s))))',
      case when v_cmd = 'select' then 'false' else 'true' end);
    execute format('create policy %I on storage.objects as restrictive for %s to authenticated %s %s',
      'pay_gate_' || v_cmd, v_cmd,
      case when v_cmd <> 'insert' then 'using ' || v_test else '' end,
      case when v_cmd in ('insert', 'update') then 'with check ' || v_test else '' end);
  end loop;
  return 4;
end
$fn$;
revoke all on function app.pay_gate_storage_apply() from public, anon, authenticated, service_role;
comment on function app.pay_gate_storage_apply() is
  'Creates (again) the restrictive pay_gate_* policies on storage.objects for the farm '
  'buckets, when storage exists. Run by migrations only (20261112100000).';

select app.pay_gate_storage_apply();
