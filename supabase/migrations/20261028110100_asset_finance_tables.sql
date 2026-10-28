-- 20261028110100_asset_finance_tables.sql
-- Machinery finance and lease tracking (work package C, 2026-10-28): who may see it, and
-- the three tables that hold it.
--
-- == Who may see it ===========================================================
-- Founder default (the question was left open, mapping "features-wording" item 1): OWNERS
-- AND MANAGERS ONLY. A finance agreement says what the farm owes and to whom, and a
-- lease or service contract what it has committed to; that is not workshop material.
-- So this is a check of its own, narrower than `app.can_view_farm_costs`, which also lets
-- in mechanics, operators a farm has opted in, and contractors with the `see_costs` grant.
-- Mechanics, operators and contractors read NONE of these tables, their documents or their
-- history. The interest and lease payments they produce still reach `cost_entries`, so a
-- person who may already see costs keeps seeing them inside TCO, exactly as before; the
-- agreement itself stays closed to them.
--
-- To change the decision later, this one function is the place (and FINANCE_ROLES in
-- src/lib/asset-finance.ts, which only decides what the screens offer).
--
-- == Writes go through functions ==============================================
-- The browser roles get SELECT only. Every write is a SECURITY DEFINER function
-- (20261028110500 / 110600) that checks this same rule, validates, rebuilds the schedule
-- and books the costs in one transaction. A direct table write could leave a schedule
-- that no longer adds up, or a cost ledger out of step with it until the nightly pass.
--
-- == Money ====================================================================
-- Integer cents, ex-VAT, like every amount in the product. Interest on a finance agreement
-- is VAT-exempt (a financial service), so instalments carry no VAT; a lease, rental or
-- service contract carries its own `vat_rate_bps`.

-- == The access rule ==========================================================
create or replace function app.can_view_farm_finance(p_farm uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.user_role;
begin
  if p_farm is null then
    return false;
  end if;
  -- Trusted server code (the nightly engines) already bypasses RLS.
  if auth.role() = 'service_role' then
    return true;
  end if;
  if not app.has_farm_access(p_farm) then
    return false;
  end if;
  -- Rapid Rise support, with two-step (is_rr_admin requires session_is_rapid_rise).
  if app.is_rr_admin() then
    return true;
  end if;
  -- A contractor never, whatever its link grants.
  if app.current_app_role() = 'workshop' then
    return false;
  end if;
  -- The role on THIS farm, never the primary farm's role.
  v_role := app.effective_farm_role(auth.uid(), p_farm);
  return coalesce(v_role in ('owner', 'manager'), false);
end
$$;

comment on function app.can_view_farm_finance(uuid) is
  'Whether the caller may read or change finance agreements, leases and contracts on this '
  'farm: owners and managers (by their role on this farm) and Rapid Rise with two-step. '
  'Never mechanics, operators or contractors. Narrower than can_view_farm_costs on purpose.';

revoke execute on function app.can_view_farm_finance(uuid) from public, anon;
grant execute on function app.can_view_farm_finance(uuid) to authenticated, service_role;

-- PostgREST reaches `public` only.
create or replace function public.can_view_farm_finance(p_farm uuid)
returns boolean
language sql
stable
security invoker
set search_path = public, app, pg_temp
as $$
  select app.can_view_farm_finance(p_farm);
$$;

revoke execute on function public.can_view_farm_finance(uuid) from public, anon;
grant execute on function public.can_view_farm_finance(uuid) to authenticated, service_role;

-- The farms whose finance history this caller may read, worked out once per query (the
-- activity log policy below would otherwise call the check for every row; see
-- 20261026100000 for what that cost on production).
create or replace function app.finance_readable_farm_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select a.farm_id
    from app.accessible_farm_ids() as a(farm_id)
   where app.can_view_farm_finance(a.farm_id);
$$;

revoke all on function app.finance_readable_farm_ids() from public, anon;
grant execute on function app.finance_readable_farm_ids() to authenticated;

-- == Finance agreements ========================================================
-- One per financed machine (a machine can carry more than one over its life). The
-- schedule is in finance_instalments; this row holds the terms it is built from.
create table public.finance_agreements (
  id                      uuid primary key default gen_random_uuid(),
  farm_id                 uuid not null references public.farms(id),
  machine_id              uuid not null,
  kind                    text not null default 'instalment_sale',
  lender                  text not null,
  agreement_number        text,
  principal_cents         bigint not null,           -- amount financed
  deposit_cents           bigint not null default 0, -- paid up front; part of the purchase, never a cost
  interest_rate_bps       integer not null default 0, -- nominal annual rate
  term_months             integer not null,
  frequency               text not null default 'monthly',
  -- The lender's own instalment figure (fee included), when the farmer has it. The
  -- schedule then uses it and its last instalment absorbs the difference.
  instalment_cents        bigint,
  fee_cents               bigint not null default 0, -- service fee per instalment
  balloon_cents           bigint not null default 0, -- due with the last instalment
  start_date              date not null,
  first_instalment_date   date not null,
  end_date                date,                       -- last due date, kept by the schedule builder
  -- Paid by debit order: the nightly pass marks each instalment paid on its due date.
  auto_mark_paid          boolean not null default false,
  status                  text not null default 'active',
  settled_on              date,
  settlement_cents        bigint,
  -- What the settlement cost above the capital still outstanding: a finance cost.
  settlement_charge_cents bigint,
  -- The lender's statement, which wins over the schedule's estimate when it is newer.
  statement_balance_cents bigint,
  statement_balance_on    date,
  reminder_lead_days      integer default 7,         -- null: no reminders
  notes                   text,
  created_by              uuid references public.users(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  deleted_by              uuid,
  constraint finance_agreements_id_farm_uq unique (id, farm_id),
  constraint finance_agreements_machine_fk foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  constraint finance_agreements_kind_ck check (kind in ('instalment_sale', 'loan', 'finance_lease', 'other')),
  constraint finance_agreements_frequency_ck check (frequency in ('monthly', 'quarterly', 'biannual', 'annual')),
  constraint finance_agreements_status_ck check (status in ('active', 'settled', 'cancelled')),
  constraint finance_agreements_lender_ck check (length(btrim(lender)) between 1 and 120),
  constraint finance_agreements_number_ck check (agreement_number is null or length(agreement_number) <= 80),
  constraint finance_agreements_money_ck check (
    principal_cents > 0 and deposit_cents >= 0 and fee_cents >= 0
    and balloon_cents >= 0 and balloon_cents < principal_cents
    and (instalment_cents is null or instalment_cents > 0)),
  constraint finance_agreements_rate_ck check (interest_rate_bps between 0 and 10000),
  constraint finance_agreements_term_ck check (
    term_months between 1 and 360
    and term_months % (case frequency when 'quarterly' then 3 when 'biannual' then 6
                                      when 'annual' then 12 else 1 end) = 0),
  constraint finance_agreements_dates_ck check (first_instalment_date >= start_date),
  constraint finance_agreements_settled_ck check (
    status <> 'settled' or (settled_on is not null and settlement_cents is not null)),
  constraint finance_agreements_settlement_ck check (
    (settlement_cents is null or settlement_cents >= 0)
    and (settlement_charge_cents is null or settlement_charge_cents >= 0)),
  constraint finance_agreements_statement_ck check (
    (statement_balance_cents is null) = (statement_balance_on is null)
    and (statement_balance_cents is null or statement_balance_cents >= 0)),
  constraint finance_agreements_lead_ck check (reminder_lead_days is null or reminder_lead_days between 0 and 90),
  constraint finance_agreements_notes_ck check (notes is null or length(notes) <= 2000)
);
create index finance_agreements_farm_idx on public.finance_agreements(farm_id) where deleted_at is null;
create index finance_agreements_machine_idx on public.finance_agreements(machine_id) where deleted_at is null;

-- == The instalment schedule ===================================================
-- Generated from the agreement (20261028110300), editable row by row, and the record of
-- what was paid. A balloon is its own row on the last due date.
create table public.finance_instalments (
  id                  uuid primary key default gen_random_uuid(),
  farm_id             uuid not null,
  agreement_id        uuid not null,
  seq                 integer not null,
  kind                text not null default 'instalment',
  due_date            date not null,
  interest_cents      bigint not null default 0,
  capital_cents       bigint not null default 0,
  fee_cents           bigint not null default 0,
  amount_cents        bigint generated always as (interest_cents + capital_cents + fee_cents) stored,
  balance_after_cents bigint not null default 0,    -- capital still owed after this row, per schedule
  -- open: owed (possibly part paid); paid: paid in full; settled: closed by an early settlement.
  status              text not null default 'open',
  paid_cents          bigint not null default 0,
  paid_on             date,
  payment_reference   text,
  reminded_at         timestamptz,                  -- "due soon" sent
  overdue_reminded_at timestamptz,                  -- "overdue" sent
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid,
  constraint finance_instalments_agreement_fk foreign key (agreement_id, farm_id)
    references public.finance_agreements(id, farm_id),
  constraint finance_instalments_kind_ck check (kind in ('instalment', 'balloon')),
  constraint finance_instalments_status_ck check (status in ('open', 'paid', 'settled')),
  constraint finance_instalments_money_ck check (
    interest_cents >= 0 and capital_cents >= 0 and fee_cents >= 0 and paid_cents >= 0
    and paid_cents <= interest_cents + capital_cents + fee_cents),
  constraint finance_instalments_reference_ck check (payment_reference is null or length(payment_reference) <= 80)
);
create unique index finance_instalments_seq_uq on public.finance_instalments(agreement_id, seq) where deleted_at is null;
create index finance_instalments_farm_due_idx on public.finance_instalments(farm_id, due_date) where deleted_at is null;

-- == Leases, rentals and service contracts =====================================
-- What the farm pays someone on a schedule for the use or upkeep of a machine, or of the
-- whole farm (machine_id null): an operating lease, a rental, a service or maintenance
-- plan, an extended warranty, an insurance premium.
create table public.asset_contracts (
  id                  uuid primary key default gen_random_uuid(),
  farm_id             uuid not null references public.farms(id),
  machine_id          uuid,                          -- null: covers the farm, not one machine
  kind                text not null default 'operating_lease',
  party               text not null,                 -- lessor, dealer, insurer
  reference           text,
  start_date          date not null,
  end_date            date,                          -- null: runs until ended
  amount_cents        bigint not null default 0,     -- per payment, ex-VAT
  vat_rate_bps        integer not null default 0,
  frequency           text not null default 'monthly',
  first_payment_date  date,                          -- null: the start date
  auto_renews         boolean not null default false,
  renewal_months      integer,
  notice_days         integer,
  notice_date         date generated always as (
                        case when end_date is null or notice_days is null then null
                             else end_date - notice_days end) stored,
  -- Book each payment as a cost when it falls due. Off when the payments already reach
  -- the ledger another way (a contractor's invoices), so nothing is counted twice.
  post_costs          boolean not null default true,
  status              text not null default 'active',
  reminder_lead_days  integer default 30,            -- null: no reminders
  notice_reminded_for date,                          -- the notice date last reminded about
  end_reminded_for    date,                          -- the end date last reminded about
  notes               text,
  created_by          uuid references public.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  deleted_by          uuid,
  constraint asset_contracts_machine_fk foreign key (machine_id, farm_id) references public.machines(id, farm_id),
  constraint asset_contracts_kind_ck check (kind in (
    'operating_lease', 'rental', 'service_contract', 'maintenance_plan',
    'extended_warranty', 'insurance', 'other')),
  constraint asset_contracts_frequency_ck check (frequency in ('monthly', 'quarterly', 'biannual', 'annual', 'once')),
  constraint asset_contracts_status_ck check (status in ('active', 'ended', 'cancelled')),
  constraint asset_contracts_party_ck check (length(btrim(party)) between 1 and 120),
  constraint asset_contracts_reference_ck check (reference is null or length(reference) <= 80),
  constraint asset_contracts_money_ck check (amount_cents >= 0 and vat_rate_bps between 0 and 10000),
  constraint asset_contracts_dates_ck check (
    (end_date is null or end_date >= start_date)
    and (first_payment_date is null or first_payment_date >= start_date)),
  constraint asset_contracts_renewal_ck check (renewal_months is null or renewal_months between 1 and 120),
  constraint asset_contracts_notice_ck check (notice_days is null or notice_days between 0 and 365),
  constraint asset_contracts_lead_ck check (reminder_lead_days is null or reminder_lead_days between 0 and 365),
  constraint asset_contracts_notes_ck check (notes is null or length(notes) <= 2000)
);
create index asset_contracts_farm_idx on public.asset_contracts(farm_id) where deleted_at is null;
create index asset_contracts_machine_idx on public.asset_contracts(machine_id) where deleted_at is null;

-- == RLS: farm-scoped, owners and managers only ================================
alter table public.finance_agreements  enable row level security;
alter table public.finance_agreements  force  row level security;
alter table public.finance_instalments enable row level security;
alter table public.finance_instalments force  row level security;
alter table public.asset_contracts     enable row level security;
alter table public.asset_contracts     force  row level security;

create policy finance_agreements_sel on public.finance_agreements for select to authenticated
  using (deleted_at is null and app.can_view_farm_finance(farm_id));
create policy finance_instalments_sel on public.finance_instalments for select to authenticated
  using (deleted_at is null and app.can_view_farm_finance(farm_id));
create policy asset_contracts_sel on public.asset_contracts for select to authenticated
  using (deleted_at is null and app.can_view_farm_finance(farm_id));

-- Read-only to browser clients; the write functions are the only door (see above).
revoke all on public.finance_agreements, public.finance_instalments, public.asset_contracts from anon, authenticated;
grant select on public.finance_agreements, public.finance_instalments, public.asset_contracts to authenticated;
grant all on public.finance_agreements, public.finance_instalments, public.asset_contracts to service_role;

-- == Audit (append-only history, per 0008) =====================================
create trigger finance_agreements_audit
  after insert or update or delete on public.finance_agreements
  for each row execute function app_audit();
create trigger finance_instalments_audit
  after insert or update or delete on public.finance_instalments
  for each row execute function app_audit();
create trigger asset_contracts_audit
  after insert or update or delete on public.asset_contracts
  for each row execute function app_audit();

-- The activity log holds every row of these tables, before and after, so without this it
-- would be a second door: a mechanic reads `audit_log` for the farm (20261026100000). A
-- restrictive policy, so it narrows whatever permissive policy is current and survives a
-- rewrite of audit_sel. Attachment rows for finance documents are covered too: their
-- diff names the agreement and the stored file.
create policy audit_finance_disclosure on public.audit_log
  as restrictive for select to authenticated
  using (
    (select app.is_rr_admin())
    or farm_id in (select app.finance_readable_farm_ids())
    or not (
      entity in ('finance_agreements', 'finance_instalments', 'asset_contracts')
      or (entity = 'attachments'
          and coalesce(diff -> 'new' ->> 'parent_type', diff -> 'old' ->> 'parent_type')
              in ('finance_agreement', 'asset_contract'))
    )
  );
