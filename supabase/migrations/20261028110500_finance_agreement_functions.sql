-- 20261028110500_finance_agreement_functions.sql
-- Writing a finance agreement and its schedule, recording what was paid, and reading the
-- balance back.
--
-- Every write is SECURITY DEFINER and starts with the same check the tables' RLS uses
-- (app.can_view_farm_finance: owners and managers of the agreement's farm), because the
-- browser roles hold SELECT only on these tables (20261028110100). Each one ends by
-- reconciling the cost ledger (app.sync_asset_finance_costs), so a schedule and the costs
-- it produces can never be seen out of step.
--
-- Refusals are raised as slugs ('finance-instalment-too-low') with a refusal SQLSTATE, so
-- the app's errorCode() passes them through and errorMessage() turns each into a sentence
-- in the reader's language (src/lib/errors.ts).

-- == Small helpers =============================================================
create or replace function app.finance_today()
returns date
language sql
stable
set search_path = pg_temp
as $$
  -- The farm's date, not the server's: Supabase runs UTC and SAST is two hours ahead.
  select (now() at time zone 'Africa/Johannesburg')::date;
$$;

revoke execute on function app.finance_today() from public, anon;
grant execute on function app.finance_today() to authenticated, service_role;

-- Capital still owed after each row, from the principal down. Rows a person edited keep
-- the column honest.
create or replace function app.finance_recompute_balances(p_agreement uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A schedule edited past the principal never shows a negative balance.
  update public.finance_instalments i
     set balance_after_cents = greatest(s.bal, 0)
    from (
      select x.id,
             a.principal_cents - sum(x.capital_cents) over (order by x.seq rows between unbounded preceding and current row) as bal
        from public.finance_instalments x
        join public.finance_agreements a on a.id = x.agreement_id
       where x.agreement_id = p_agreement and x.deleted_at is null
    ) s
   where i.id = s.id
     and i.balance_after_cents is distinct from greatest(s.bal, 0);
end
$$;

-- An agreement whose every row is paid is paid off: settled, at no settlement charge.
create or replace function app.finance_close_if_paid(p_agreement uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.finance_agreements a
     set status = 'settled',
         settled_on = (select coalesce(max(i.paid_on), max(i.due_date))
                         from public.finance_instalments i
                        where i.agreement_id = a.id and i.deleted_at is null),
         settlement_cents = 0,
         settlement_charge_cents = 0,
         updated_at = now()
   where a.id = p_agreement
     and a.status = 'active'
     and a.deleted_at is null
     and exists (select 1 from public.finance_instalments i
                  where i.agreement_id = a.id and i.deleted_at is null)
     and not exists (select 1 from public.finance_instalments i
                      where i.agreement_id = a.id and i.deleted_at is null and i.status = 'open');
end
$$;

-- == (Re)building the schedule =================================================
-- Rows a payment has touched are history: they, and every row before the last of them,
-- stay exactly as they are. The rest is built again from the capital still owed, over the
-- instalments still to come, on the agreement's current terms. So a prime-linked rate
-- change rewrites only the unpaid future, and a fresh agreement is built whole.
create or replace function app.finance_rebuild_schedule(p_agreement uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a              public.finance_agreements;
  v_step         integer;
  v_count        integer;
  v_kept_seq     integer;
  v_kept_capital bigint;
  v_outstanding  bigint;
begin
  select * into a from public.finance_agreements
   where id = p_agreement and deleted_at is null
   for update;
  if not found then
    raise exception 'finance-not-found' using errcode = 'P0001';
  end if;

  v_step := app.finance_step_months(a.frequency);
  v_count := a.term_months / v_step;

  -- A paid balloon means the whole agreement is history: nothing to rebuild.
  if exists (select 1 from public.finance_instalments
              where agreement_id = a.id and deleted_at is null and kind = 'balloon'
                and (paid_cents > 0 or status <> 'open')) then
    return;
  end if;

  select coalesce(max(seq), 0) into v_kept_seq
    from public.finance_instalments
   where agreement_id = a.id and deleted_at is null and kind = 'instalment'
     and (paid_cents > 0 or status <> 'open');
  -- Never keep more instalments than the (possibly shortened) term has room for.
  if v_kept_seq > v_count then
    raise exception 'finance-term-below-paid' using errcode = '22023';
  end if;

  select coalesce(sum(capital_cents), 0) into v_kept_capital
    from public.finance_instalments
   where agreement_id = a.id and deleted_at is null and kind = 'instalment' and seq <= v_kept_seq;

  update public.finance_instalments
     set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
   where agreement_id = a.id and deleted_at is null and seq > v_kept_seq;

  v_outstanding := a.principal_cents - v_kept_capital;

  if v_kept_seq < v_count then
    if v_outstanding <= a.balloon_cents then
      raise exception 'finance-principal-below-paid' using errcode = '22023';
    end if;
    insert into public.finance_instalments
      (farm_id, agreement_id, seq, kind, due_date, interest_cents, capital_cents, fee_cents, balance_after_cents)
    select a.farm_id, a.id, s.seq, s.kind, s.due_date, s.interest_cents, s.capital_cents, s.fee_cents,
           s.balance_after_cents
      from app.finance_schedule(
             v_outstanding, a.interest_rate_bps, v_count - v_kept_seq, v_step, a.first_instalment_date,
             a.balloon_cents, a.instalment_cents, a.fee_cents, v_kept_seq + 1) s;
  elsif v_outstanding > 0 then
    -- Every instalment is kept; what is still owed is the balloon.
    insert into public.finance_instalments
      (farm_id, agreement_id, seq, kind, due_date, interest_cents, capital_cents, fee_cents, balance_after_cents)
    values (a.farm_id, a.id, v_count + 1, 'balloon',
            app.finance_add_months(a.first_instalment_date, (v_count - 1) * v_step),
            0, v_outstanding, 0, 0);
  end if;

  perform app.finance_recompute_balances(a.id);

  update public.finance_agreements
     set end_date = (select max(due_date) from public.finance_instalments
                      where agreement_id = a.id and deleted_at is null),
         updated_at = now()
   where id = a.id;
end
$$;

-- == Create or edit an agreement ===============================================
-- p_agreement null creates one on p_machine; otherwise it edits that agreement (its
-- machine stays). The schedule is rebuilt when, and only when, a term it is built from
-- changed. p_mark_paid_before (create only): instalments due before that day are taken
-- as already paid, for an agreement captured part-way through its term.
create or replace function public.finance_save_agreement(
  p_agreement        uuid,
  p_machine          uuid,
  p_fields           jsonb,
  p_mark_paid_before date default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- == Record a payment against one instalment ===================================
-- p_amount_cents null pays what is left on it. Part payments add up; a payment is
-- allocated to interest first, then the fee, then capital (the order a lender uses), which
-- is what the balance below reads.
create or replace function public.finance_record_payment(
  p_instalment   uuid,
  p_amount_cents bigint default null,
  p_paid_on      date default null,
  p_reference    text default null
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- == Undo a payment recorded by mistake ========================================
create or replace function public.finance_clear_payment(p_instalment uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- == Correct one row of the schedule ===========================================
-- The lender moved a date or charged a different amount. The interest and fee on the row
-- stay as they were and the difference is capital; the rows after it are left alone
-- (Regenerate rebuilds them from the capital then owed, keeping this row if it is paid).
create or replace function public.finance_update_instalment(
  p_instalment   uuid,
  p_due_date     date,
  p_amount_cents bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- == Rebuild the unpaid rows on the current terms ==============================
create or replace function public.finance_regenerate_schedule(p_agreement uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
  if a.status <> 'active' then
    raise exception 'finance-not-active' using errcode = 'P0001';
  end if;
  perform app.finance_rebuild_schedule(a.id);
  perform app.sync_asset_finance_costs(a.farm_id);
end
$$;

-- == Settle early ==============================================================
-- Every row still open is closed by the settlement. What the settlement cost above the
-- capital still owed (interest to the day, a penalty) is booked once as a finance cost; a
-- settlement BELOW the capital owed books nothing, since a discount on capital is not an
-- income this ledger records.
create or replace function public.finance_settle_agreement(
  p_agreement        uuid,
  p_settled_on       date,
  p_settlement_cents bigint
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- == Remove an agreement captured by mistake ===================================
-- Soft, like every delete here: the rows stay for the history, and the costs it booked are
-- withdrawn from the ledger.
create or replace function public.finance_delete_agreement(p_agreement uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
$$;

-- == The balance, per agreement ================================================
-- SECURITY INVOKER: RLS on the two tables decides whose these are, so a mechanic gets no
-- rows rather than a refusal. Figures:
--   outstanding_capital  principal less the capital the payments have covered
--                        (payments go to interest, then the fee, then capital)
--   remaining            everything still open on the schedule, interest included
--   balance              the lender's statement when it is at least as new as the last
--                        payment, otherwise the schedule's estimate; balance_source says which
create or replace function public.finance_agreement_summaries(p_farm uuid, p_today date default null)
returns table (
  agreement_id              uuid,
  instalments               integer,
  instalments_paid          integer,
  paid_cents                bigint,
  capital_paid_cents        bigint,
  outstanding_capital_cents bigint,
  remaining_cents           bigint,
  interest_total_cents      bigint,
  interest_to_date_cents    bigint,
  overdue_count             integer,
  overdue_cents             bigint,
  next_seq                  integer,
  next_kind                 text,
  next_due_date             date,
  next_due_cents            bigint,
  last_paid_on              date,
  balance_cents             bigint,
  balance_source            text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with today as (
    select coalesce(p_today, (now() at time zone 'Africa/Johannesburg')::date) as d
  ),
  inst as (
    select i.*,
           least(greatest(i.paid_cents - i.interest_cents - i.fee_cents, 0), i.capital_cents) as capital_paid
      from public.finance_instalments i
     where i.farm_id = p_farm and i.deleted_at is null
  ),
  agg as (
    select a.id,
           a.status,
           a.principal_cents,
           a.statement_balance_cents,
           a.statement_balance_on,
           count(r.id) filter (where r.kind = 'instalment')::integer                        as instalments,
           count(r.id) filter (where r.kind = 'instalment' and r.status = 'paid')::integer  as instalments_paid,
           coalesce(sum(r.paid_cents), 0)::bigint                                          as paid_cents,
           coalesce(sum(r.capital_paid), 0)::bigint                                        as capital_paid,
           coalesce(sum(r.amount_cents - r.paid_cents) filter (where r.status = 'open'), 0)::bigint as remaining,
           coalesce(sum(r.interest_cents) filter (where r.status <> 'settled'), 0)::bigint as interest_total,
           coalesce(sum(r.interest_cents) filter (where r.status <> 'settled' and r.due_date <= t.d), 0)::bigint
                                                                                            as interest_to_date,
           (count(r.id) filter (where r.status = 'open' and r.due_date < t.d))::integer    as overdue_count,
           coalesce(sum(r.amount_cents - r.paid_cents) filter (where r.status = 'open' and r.due_date < t.d), 0)::bigint
                                                                                            as overdue_cents,
           max(r.paid_on)                                                                   as last_paid_on
      from public.finance_agreements a
      cross join today t
      left join inst r on r.agreement_id = a.id
     where a.farm_id = p_farm and a.deleted_at is null
     group by a.id, a.status, a.principal_cents, a.statement_balance_cents, a.statement_balance_on
  )
  select g.id,
         g.instalments,
         g.instalments_paid,
         g.paid_cents,
         g.capital_paid,
         case when g.status = 'active' then greatest(g.principal_cents - g.capital_paid, 0) else 0 end::bigint,
         case when g.status = 'active' then g.remaining else 0 end::bigint,
         g.interest_total,
         g.interest_to_date,
         case when g.status = 'active' then g.overdue_count else 0 end,
         case when g.status = 'active' then g.overdue_cents else 0 end::bigint,
         n.seq,
         n.kind,
         n.due_date,
         n.left_cents,
         g.last_paid_on,
         case
           when g.status <> 'active' then 0
           when g.statement_balance_on is not null
                and g.statement_balance_on >= coalesce(g.last_paid_on, g.statement_balance_on)
             then g.statement_balance_cents
           else greatest(g.principal_cents - g.capital_paid, 0)
         end::bigint,
         case
           when g.status <> 'active' then 'closed'
           when g.statement_balance_on is not null
                and g.statement_balance_on >= coalesce(g.last_paid_on, g.statement_balance_on)
             then 'statement'
           else 'schedule'
         end
    from agg g
    left join lateral (
      select r.seq, r.kind, r.due_date, (r.amount_cents - r.paid_cents) as left_cents
        from inst r
       where r.agreement_id = g.id and r.status = 'open' and g.status = 'active'
       order by r.due_date, r.seq
       limit 1
    ) n on true;
$$;

-- == Grants ====================================================================
revoke execute on function app.finance_recompute_balances(uuid) from public, anon, authenticated;
revoke execute on function app.finance_close_if_paid(uuid) from public, anon, authenticated;
revoke execute on function app.finance_rebuild_schedule(uuid) from public, anon, authenticated;
grant execute on function app.finance_recompute_balances(uuid) to service_role;
grant execute on function app.finance_close_if_paid(uuid) to service_role;
grant execute on function app.finance_rebuild_schedule(uuid) to service_role;

revoke execute on function public.finance_save_agreement(uuid, uuid, jsonb, date) from public, anon;
revoke execute on function public.finance_record_payment(uuid, bigint, date, text) from public, anon;
revoke execute on function public.finance_clear_payment(uuid) from public, anon;
revoke execute on function public.finance_update_instalment(uuid, date, bigint) from public, anon;
revoke execute on function public.finance_regenerate_schedule(uuid) from public, anon;
revoke execute on function public.finance_settle_agreement(uuid, date, bigint) from public, anon;
revoke execute on function public.finance_delete_agreement(uuid) from public, anon;
revoke execute on function public.finance_agreement_summaries(uuid, date) from public, anon;
grant execute on function public.finance_save_agreement(uuid, uuid, jsonb, date) to authenticated, service_role;
grant execute on function public.finance_record_payment(uuid, bigint, date, text) to authenticated, service_role;
grant execute on function public.finance_clear_payment(uuid) to authenticated, service_role;
grant execute on function public.finance_update_instalment(uuid, date, bigint) to authenticated, service_role;
grant execute on function public.finance_regenerate_schedule(uuid) to authenticated, service_role;
grant execute on function public.finance_settle_agreement(uuid, date, bigint) to authenticated, service_role;
grant execute on function public.finance_delete_agreement(uuid) to authenticated, service_role;
grant execute on function public.finance_agreement_summaries(uuid, date) to authenticated, service_role;
