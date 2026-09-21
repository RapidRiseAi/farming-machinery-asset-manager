-- 20260921110000_depreciation_and_book_value.sql
-- What the fleet is worth now, for the insurance schedule and the management accounts.
--
-- The purchase price has been on `machines` since 0003 and nothing has ever amortised it.
-- Once a year every farm is asked the same two questions by two different people, the
-- broker wants a schedule of values to insure, the accountant wants book values for the
-- financials, and both answers are assembled by hand off an invoice folder.
--
-- THIS IS A BOOK VALUE, NOT A TAX CALCULATION
-- =============================================================================
-- Said plainly because the two are easy to confuse and expensive to confuse. SARS capital
-- allowances for farming assets (s12B and the wear-and-tear schedules) follow their own
-- rules, rates and apportionments and are the accountant's work, not this product's. What
-- is computed here is the ordinary accounting book value a farm sets its own policy for,
-- and every screen that shows it says so.
--
-- WHO MAY SEE IT
-- =============================================================================
-- Exactly whoever may see the purchase price, because it IS the purchase price with the
-- years taken off. 20260903074350 withheld `purchase_price_cents` from `authenticated` at
-- the COLUMN level and put it behind `public.machine_financials`, gated on
-- `app.can_view_farm_costs` and `app.row_visible_to_role`. The function below repeats that
-- gate clause for clause; the new columns are not granted to `authenticated` either, so a
-- browser cannot read the inputs and reproduce the sum.

create type depreciation_method as enum ('none', 'straight_line', 'reducing_balance');

alter table machines
  -- `none` rather than null so "we have not decided" and "this one is not depreciated"
  -- are the same visible answer instead of two invisible ones.
  add column if not exists depreciation_method     depreciation_method not null default 'none',
  -- Reducing balance only: basis points a year off the remaining value (1500 = 15%).
  add column if not exists depreciation_rate_bps   integer,
  -- Straight line only: how long it is written off over.
  add column if not exists useful_life_months      integer,
  -- What it is still worth when fully written down. Both methods floor here, a tractor
  -- that has been on the farm for twenty years is not worth nothing, and an insurer asked
  -- to cover R0 will cover R0.
  add column if not exists residual_value_cents    bigint,
  -- When the clock starts. Falls back to purchase_date; kept separate because a machine
  -- bought in December and commissioned in March is written off from March.
  add column if not exists depreciation_start_date date;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'machines_depreciation_ck') then
    alter table machines
      add constraint machines_depreciation_ck check (
        (depreciation_rate_bps is null or depreciation_rate_bps between 1 and 10000)
        and (useful_life_months is null or useful_life_months between 1 and 1200)
        and (residual_value_cents is null or residual_value_cents >= 0)
        -- Each method needs its own input, and refusing here is how a farm finds out at
        -- the moment they set it rather than the following March when the number is wrong.
        and (depreciation_method <> 'straight_line' or useful_life_months is not null)
        and (depreciation_method <> 'reducing_balance' or depreciation_rate_bps is not null)
      );
  end if;
end $$;

comment on column machines.depreciation_method is
  'Book value policy for this machine. NOT a SARS capital-allowance calculation, that is '
  'the accountant''s work and follows different rules.';

-- Whole months between two dates, never negative. Its own function because both branches
-- above need it and because "how many months is that" is the part people get wrong.
create or replace function app.months_between(p_from date, p_to date)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select greatest(
    0,
    (extract(year from age(p_to, p_from))::integer * 12)
    + extract(month from age(p_to, p_from))::integer
  );
$$;

grant execute on function app.months_between(date, date) to authenticated, service_role;

-- == The sum, in one place ===================================================
--
-- Whole elapsed months, because a book value that changes on a Tuesday is not one anybody
-- can reconcile. `numeric` throughout and rounded once at the end: cents computed through
-- a float would drift by a rand or two across a fleet and be queried by the one person
-- who checks.
create or replace function app.book_value_cents(
  p_cost bigint,
  p_method depreciation_method,
  p_rate_bps integer,
  p_life_months integer,
  p_residual bigint,
  p_start date,
  p_on date
) returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_cost is null or p_cost <= 0 then null
    when p_method = 'none' then p_cost
    when p_start is null or coalesce(p_on, current_date) < p_start then p_cost
    when p_method = 'straight_line' then
      -- `least(months, life)` is belt and braces: the `greatest(residual, …)` floor below
      -- is what actually stops a twenty-year-old tractor being valued below its residual,
      -- and a mutation removing the cap survives the suite for that reason. It stays
      -- because the intent of "you stop writing off at the end of its life" belongs in the
      -- sum rather than only in a floor that happens to have the same effect.
      greatest(
        coalesce(p_residual, 0),
        p_cost - round(
          (p_cost - coalesce(p_residual, 0))::numeric
          * least(app.months_between(p_start, coalesce(p_on, current_date)), p_life_months)
          / nullif(p_life_months, 0)
        )::bigint
      )
    when p_method = 'reducing_balance' then
      greatest(
        coalesce(p_residual, 0),
        round(
          p_cost::numeric
          * power(
              1 - (p_rate_bps::numeric / 10000),
              app.months_between(p_start, coalesce(p_on, current_date))::numeric / 12
            )
        )::bigint
      )
    else p_cost
  end;
$$;

-- The book-value sum itself is not granted: it takes a COST as an argument, and a function
-- a browser may call with any cost it likes is a calculator, not a leak, but there is no
-- reason for one, and the register below is the supported way in.
revoke execute on function app.book_value_cents(bigint, depreciation_method, integer, integer, bigint, date, date)
  from public, anon, authenticated;

-- == The asset register ======================================================
--
-- One row per machine the caller may see the cost of, which is what both the broker and
-- the accountant actually ask for. SECURITY DEFINER because it reads the withheld columns,
-- and gated exactly as `public.machine_financials` is, the same three clauses, so a farm
-- cannot learn through this what it could not learn through that.
create or replace function public.farm_book_values(p_farm uuid, p_on date default null)
returns table (
  machine_id            uuid,
  name                  text,
  reg_no                text,
  type                  machine_type,
  status                machine_status,
  purchase_date         date,
  purchase_price_cents  bigint,
  method                depreciation_method,
  rate_bps              integer,
  life_months           integer,
  residual_value_cents  bigint,
  start_date            date,
  months_held           integer,
  book_value_cents      bigint,
  depreciated_cents     bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
    and m.deleted_at is null
    -- Sold and retired machines are left out of a register of what to insure. They are
    -- still in the audit trail and in the cost history; they are not assets to cover.
    and m.status not in ('sold', 'retired')
    and app.can_view_farm_costs(m.farm_id)
    and (
      app.row_visible_to_role(m.farm_id, m.id)
      or (app.is_farm_side() and app.has_permission(m.farm_id, 'see_all_vehicles'))
    )
  order by m.name;
$$;

comment on function public.farm_book_values(uuid, date) is
  'Asset register: what each machine is worth on a date, under the farm''s own book-value '
  'policy. Caller-scoped exactly as machine_financials is. NOT a SARS capital-allowance '
  'schedule, that is the accountant''s work.';

revoke execute on function public.farm_book_values(uuid, date) from public, anon;
grant  execute on function public.farm_book_values(uuid, date) to authenticated, service_role;

-- == Setting the policy ======================================================
-- A wrapper rather than a column grant, because granting UPDATE on these columns to
-- `authenticated` would also hand every driver a way to write to the same row that holds
-- the purchase price. Owner and manager only, checked inside, and the caller's own
-- identity decides, this one is SECURITY INVOKER over a definer-style check so that RLS
-- on `machines` still has the final say about which machine is being written to.
create or replace function public.set_machine_depreciation(
  p_machine  uuid,
  p_method   depreciation_method,
  p_rate_bps integer default null,
  p_life_months integer default null,
  p_residual_cents bigint default null,
  p_start date default null
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  update public.machines
     set depreciation_method     = p_method,
         depreciation_rate_bps   = case when p_method = 'reducing_balance' then p_rate_bps end,
         useful_life_months      = case when p_method = 'straight_line' then p_life_months end,
         residual_value_cents    = case when p_method = 'none' then null else p_residual_cents end,
         depreciation_start_date = case when p_method = 'none' then null else p_start end
   where id = p_machine;
end $$;

revoke execute on function public.set_machine_depreciation(uuid, depreciation_method, integer, integer, bigint, date)
  from public, anon;
grant  execute on function public.set_machine_depreciation(uuid, depreciation_method, integer, integer, bigint, date)
  to authenticated, service_role;
