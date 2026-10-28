-- 20261028110300_asset_finance_schedule_maths.sql
-- The arithmetic of a finance schedule and of a contract's payment dates, in one place.
--
-- Pure functions: no table is read or written here. `src/lib/asset-finance.ts` mirrors
-- them for the live preview in the agreement form and for the unit tests, and the SQL
-- suite (asset_finance.sql) and the TS tests assert the SAME worked examples, so the two
-- cannot drift apart unnoticed (the rule CLAUDE.md sets for a figure that exists in both).
--
-- == The schedule =============================================================
-- An annuity: equal instalments of interest plus capital, interest charged each period on
-- the capital still owed, at the nominal annual rate divided by the periods in a year.
--
--   periodic rate  i = rate_bps x months_per_period / 120 000
--   instalment     A = (P - B(1+i)^-n) i / (1 - (1+i)^-n)       (A = (P - B) / n at 0%)
--   each period    interest = round(balance x i), capital = A - interest
--   last period    capital = balance - B: the last instalment absorbs every rounding cent,
--                  so the capital column always adds up to the principal EXACTLY.
--   balloon        B on its own row, on the last instalment's date.
--
-- Rounding is half up to the cent, on integers: interest is
-- round(balance x rate_bps x months / 120000) computed exactly, never through a float.
--
-- When the farmer has the lender's own instalment figure it is used as A (less the
-- service fee) and the last instalment still absorbs the difference. A figure that never
-- repays the loan, or repays it early, is refused with a reason rather than producing a
-- schedule that is plainly wrong. With the instalment and no rate, the rate is IMPLIED:
-- the whole basis point whose annuity comes closest to the lender's figure.
--
-- This is an ESTIMATE per schedule. Banks charge daily interest and prime-linked rates
-- move, so the screens say so and a lender's statement balance wins when it is newer.
--
-- == Dates ====================================================================
-- Due date n = first date + (n - 1) x months, always counted from the FIRST date and
-- clamped to the month's end the way Postgres adds months: 31 Jan, 28 Feb, 31 Mar, never
-- 31 Jan, 28 Feb, 28 Mar.

create or replace function app.finance_step_months(p_frequency text)
returns integer
language sql
immutable
set search_path = pg_temp
as $$
  select case p_frequency
           when 'monthly' then 1
           when 'quarterly' then 3
           when 'biannual' then 6
           when 'annual' then 12
         end;
$$;

create or replace function app.finance_add_months(p_date date, p_months integer)
returns date
language sql
immutable
set search_path = pg_temp
as $$
  select (p_date + make_interval(months => p_months))::date;
$$;

-- The instalment (interest plus capital, no fee) that repays p_principal less a balloon.
create or replace function app.finance_annuity_payment(
  p_principal bigint,
  p_rate_bps  integer,
  p_count     integer,
  p_step      integer,
  p_balloon   bigint default 0
)
returns bigint
language plpgsql
immutable
set search_path = pg_temp
as $$
declare
  v_i numeric;
  v_v numeric;
begin
  if p_principal is null or p_count is null or p_count < 1 or p_step is null or p_rate_bps is null then
    return null;
  end if;
  if p_rate_bps = 0 then
    return round((p_principal - coalesce(p_balloon, 0))::numeric / p_count);
  end if;
  v_i := p_rate_bps::numeric * p_step / 120000;
  v_v := power(1 + v_i, -p_count);
  return round((p_principal - coalesce(p_balloon, 0) * v_v) * v_i / (1 - v_v));
end
$$;

-- The whole basis point whose annuity comes closest to a lender's instalment (fee
-- excluded), or null when no rate from 0% to 100% gives it.
create or replace function app.finance_implied_rate_bps(
  p_principal bigint,
  p_payment   bigint,
  p_count     integer,
  p_step      integer,
  p_balloon   bigint default 0
)
returns integer
language plpgsql
immutable
set search_path = pg_temp
as $$
declare
  lo  integer := 0;
  hi  integer := 10000;
  mid integer;
begin
  if p_payment is null or p_payment <= 0 then
    return null;
  end if;
  if p_payment < app.finance_annuity_payment(p_principal, 0, p_count, p_step, p_balloon)
     or p_payment > app.finance_annuity_payment(p_principal, 10000, p_count, p_step, p_balloon) then
    return null;
  end if;
  -- The payment rises with the rate: find the smallest rate that reaches the figure.
  while lo < hi loop
    mid := (lo + hi) / 2;
    if app.finance_annuity_payment(p_principal, mid, p_count, p_step, p_balloon) < p_payment then
      lo := mid + 1;
    else
      hi := mid;
    end if;
  end loop;
  -- The rate just below may be the closer one; a tie goes to the lower rate.
  if lo > 0 and abs(app.finance_annuity_payment(p_principal, lo - 1, p_count, p_step, p_balloon) - p_payment)
              <= abs(app.finance_annuity_payment(p_principal, lo, p_count, p_step, p_balloon) - p_payment) then
    return lo - 1;
  end if;
  return lo;
end
$$;

-- The schedule rows. `p_first_seq` > 1 builds the tail of a schedule from the capital
-- still owed (a rebuild after a rate change keeps every row a payment has touched).
create or replace function app.finance_schedule(
  p_principal  bigint,
  p_rate_bps   integer,
  p_count      integer,
  p_step       integer,
  p_anchor     date,
  p_balloon    bigint default 0,
  p_instalment bigint default null,
  p_fee        bigint default 0,
  p_first_seq  integer default 1
)
returns table (
  seq                 integer,
  kind                text,
  due_date            date,
  interest_cents      bigint,
  capital_cents       bigint,
  fee_cents           bigint,
  balance_after_cents bigint
)
language plpgsql
immutable
set search_path = pg_temp
as $$
declare
  v_balloon bigint := coalesce(p_balloon, 0);
  v_fee     bigint := coalesce(p_fee, 0);
  v_pay     bigint;
  v_bal     bigint := p_principal;
  v_int     bigint;
  v_cap     bigint;
  k         integer;
begin
  if p_principal is null or p_principal <= 0 or p_count is null or p_count < 1
     or p_step is null or p_step not in (1, 3, 6, 12) or p_anchor is null
     or p_rate_bps is null or p_rate_bps not between 0 and 10000
     or v_fee < 0 or coalesce(p_first_seq, 0) < 1 then
    raise exception 'finance-schedule-invalid' using errcode = '22023';
  end if;
  if v_balloon < 0 or v_balloon >= p_principal then
    raise exception 'finance-balloon-too-large' using errcode = '22023';
  end if;

  if p_instalment is not null then
    v_pay := p_instalment - v_fee;
    if v_pay <= 0 then
      raise exception 'finance-instalment-too-low' using errcode = '22023';
    end if;
  else
    v_pay := app.finance_annuity_payment(p_principal, p_rate_bps, p_count, p_step, v_balloon);
  end if;

  for k in 1 .. p_count loop
    -- Exact integer arithmetic, rounded half up (round() on numeric, positive values).
    v_int := round(v_bal::numeric * p_rate_bps * p_step / 120000);
    if k < p_count then
      v_cap := v_pay - v_int;
      if v_cap <= 0 then
        raise exception 'finance-instalment-too-low' using errcode = '22023';
      end if;
      if v_bal - v_cap < v_balloon then
        raise exception 'finance-instalment-too-high' using errcode = '22023';
      end if;
    else
      v_cap := v_bal - v_balloon;
      if p_instalment is not null and p_count > 1 and v_int + v_cap > 2 * v_pay then
        raise exception 'finance-instalment-mismatch' using errcode = '22023';
      end if;
    end if;
    v_bal := v_bal - v_cap;

    seq := p_first_seq + k - 1;
    kind := 'instalment';
    due_date := app.finance_add_months(p_anchor, (p_first_seq + k - 2) * p_step);
    interest_cents := v_int;
    capital_cents := v_cap;
    fee_cents := v_fee;
    balance_after_cents := v_bal;
    return next;
  end loop;

  if v_balloon > 0 then
    seq := p_first_seq + p_count;
    kind := 'balloon';
    due_date := app.finance_add_months(p_anchor, (p_first_seq + p_count - 2) * p_step);
    interest_cents := 0;
    capital_cents := v_balloon;
    fee_cents := 0;
    balance_after_cents := 0;
    return next;
  end if;
end
$$;

-- The days a contract falls due between two dates (both inclusive): the anchor and every
-- step after it, or the anchor alone for a once-off payment.
create or replace function app.asset_contract_dates(
  p_anchor    date,
  p_frequency text,
  p_from      date,
  p_to        date
)
returns setof date
language plpgsql
immutable
set search_path = pg_temp
as $$
declare
  v_step integer;
  v_from date := coalesce(p_from, p_anchor);
  k      integer := 0;
  d      date;
begin
  if p_anchor is null or p_to is null or p_to < v_from then
    return;
  end if;
  if p_frequency = 'once' then
    if p_anchor between v_from and p_to then
      return next p_anchor;
    end if;
    return;
  end if;
  v_step := app.finance_step_months(p_frequency);
  if v_step is null then
    return;
  end if;
  -- Start a step short of the window, so a long-running contract is not walked from 2010.
  if v_from > p_anchor then
    k := greatest(
      ((extract(year from v_from)::int - extract(year from p_anchor)::int) * 12
        + (extract(month from v_from)::int - extract(month from p_anchor)::int)) / v_step - 1,
      0);
  end if;
  loop
    d := app.finance_add_months(p_anchor, k * v_step);
    exit when d > p_to;
    if d >= v_from then
      return next d;
    end if;
    k := k + 1;
    exit when k > 12000;
  end loop;
end
$$;

revoke execute on function app.finance_step_months(text) from public, anon;
revoke execute on function app.finance_add_months(date, integer) from public, anon;
revoke execute on function app.finance_annuity_payment(bigint, integer, integer, integer, bigint) from public, anon;
revoke execute on function app.finance_implied_rate_bps(bigint, bigint, integer, integer, bigint) from public, anon;
revoke execute on function app.finance_schedule(bigint, integer, integer, integer, date, bigint, bigint, bigint, integer) from public, anon;
revoke execute on function app.asset_contract_dates(date, text, date, date) from public, anon;
grant execute on function app.finance_step_months(text) to authenticated, service_role;
grant execute on function app.finance_add_months(date, integer) to authenticated, service_role;
grant execute on function app.finance_annuity_payment(bigint, integer, integer, integer, bigint) to authenticated, service_role;
grant execute on function app.finance_implied_rate_bps(bigint, bigint, integer, integer, bigint) to authenticated, service_role;
grant execute on function app.finance_schedule(bigint, integer, integer, integer, date, bigint, bigint, bigint, integer) to authenticated, service_role;
grant execute on function app.asset_contract_dates(date, text, date, date) to authenticated, service_role;
