-- The numbers the assistant reads to answer "how much diesel did we use", "what did the
-- red tractor cost us this month", "which machine uses the most fuel".
--
-- == Why these exist ==========================================================
-- Until now the assistant's AI could not see the farm at all: it read the words of a hard
-- request and nothing else, and every farm answer came from a handful of fixed phrasings,
-- none of them about fuel or money. The founder asked for an assistant that can answer
-- from the farm's own records. Answering well means the model reads finished numbers: an
-- AI adding up six hundred fuel rows gets the sum wrong, and fetching them would run into
-- the 1 000-row page anyway. So the database aggregates, and the model reads the result.
--
-- == Bounded results ==========================================================
-- PostgREST returns at most 1 000 rows, silently. So no function here returns one row per
-- machine per month: each answers by machine OR by month (p_by), optionally for one
-- machine (p_machine), and the cost ledger's types are columns, not rows. A farm would
-- need a thousand machines to reach the cap.
--
-- == Whose numbers ============================================================
-- SECURITY INVOKER, all three. Every row below is read under the person's own row
-- policies through the same projections the screens use:
--   * an operator counts only the draws on machines assigned to them
--     (app.row_visible_to_role on fuel_issues), as /fuel shows them;
--   * a role that may not see money gets litres with every amount NULL
--     (fuel_issues_visible), and no cost rows at all (cost_entries_sel requires
--     app.can_view_farm_costs), so a total in rand is never available to them;
--   * another farm's rows are invisible as everywhere else.
-- Nothing here widens what anybody can read; it only adds up what they already can.
--
-- The period is bounded (at most about three years) so a request can never ask the
-- database to scan a farm's whole history for one sentence.

create or replace function public.assistant_fuel_summary(
  p_farm    uuid,
  p_from    date,
  p_to      date,
  p_by      text default 'machine',
  p_machine uuid default null
)
returns table (
  machine_id   uuid,
  month        date,
  litres       numeric,
  cost_cents   bigint,
  draws        integer,
  priced_draws integer
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_farm is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100
     or p_by is null or p_by not in ('machine', 'month') then
    raise exception 'A farm, a period of at most three years and machine or month are required.'
      using errcode = '22023';
  end if;
  return query
    select case when p_by = 'machine' then fi.machine_id else p_machine end,
           case when p_by = 'month' then date_trunc('month', fi.date)::date end,
           coalesce(sum(fi.litres), 0)::numeric,
           sum(fi.cost_cents)::bigint,
           count(*)::integer,
           count(fi.cost_cents)::integer
      from public.fuel_issues_visible fi
     where fi.farm_id = p_farm
       and fi.deleted_at is null
       and fi.date between p_from and p_to
       and (p_machine is null or fi.machine_id = p_machine)
     group by 1, 2;
end $$;

comment on function public.assistant_fuel_summary(uuid, date, date, text, uuid) is
  'Fuel drawn in a period, by machine or by month, optionally for one machine, under the '
  'caller''s own policies: litres, cost (NULL when the caller may not see money), draws, '
  'and how many draws carried a price.';

-- Litres per hour (or per kilometre) by the interval method lib/fuel.ts computeConsumption
-- uses on /fuel: metered draws sorted by meter, and each positive meter step counts the
-- litres of the draw that closed it. Same ordering, same rule, so the assistant and the
-- fuel page cannot disagree about a machine over the same draws.
create or replace function public.assistant_fuel_consumption(
  p_farm    uuid,
  p_from    date,
  p_to      date,
  p_machine uuid default null
)
returns table (
  machine_id      uuid,
  interval_litres numeric,
  meter_span      numeric,
  intervals       integer
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_farm is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100 then
    raise exception 'A farm and a period of at most three years are required.' using errcode = '22023';
  end if;
  return query
    with metered as (
      select fi.machine_id,
             fi.litres,
             fi.meter_reading,
             lag(fi.meter_reading) over (
               partition by fi.machine_id order by fi.meter_reading, fi.date, fi.id
             ) as previous
        from public.fuel_issues_visible fi
       where fi.farm_id = p_farm
         and fi.deleted_at is null
         and fi.machine_id is not null
         and fi.meter_reading is not null
         and fi.litres > 0
         and fi.date between p_from and p_to
         and (p_machine is null or fi.machine_id = p_machine)
    )
    select m.machine_id,
           coalesce(sum(m.litres) filter (where m.meter_reading - m.previous > 0), 0)::numeric,
           coalesce(sum(m.meter_reading - m.previous) filter (where m.meter_reading - m.previous > 0), 0)::numeric,
           (count(*) filter (where m.meter_reading - m.previous > 0))::integer
      from metered m
     group by m.machine_id;
end $$;

comment on function public.assistant_fuel_consumption(uuid, date, date, uuid) is
  'Per machine: litres and meter span over positive meter steps in a period (the /fuel '
  'interval method), under the caller''s own policies.';

-- Money from the one cost ledger the reports and TCO already read (cost_entries: fuel per
-- draw, parts, labour and invoices from job cards, purchase, finance, other), so the
-- assistant's rand figures are the reports' rand figures. Amounts are ex VAT, like the
-- ledger. A caller who may not see costs reads no rows here at all.
create or replace function public.assistant_cost_summary(
  p_farm    uuid,
  p_from    date,
  p_to      date,
  p_by      text default 'machine',
  p_machine uuid default null
)
returns table (
  machine_id     uuid,
  month          date,
  fuel_cents     bigint,
  parts_cents    bigint,
  labour_cents   bigint,
  invoice_cents  bigint,
  other_cents    bigint,
  purchase_cents bigint,
  finance_cents  bigint,
  total_cents    bigint,
  entries        integer
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_farm is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 1100
     or p_by is null or p_by not in ('machine', 'month') then
    raise exception 'A farm, a period of at most three years and machine or month are required.'
      using errcode = '22023';
  end if;
  return query
    select case when p_by = 'machine' then ce.machine_id else p_machine end,
           case when p_by = 'month' then date_trunc('month', ce.occurred_on)::date end,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'fuel'), 0)::bigint,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'parts'), 0)::bigint,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'labour'), 0)::bigint,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'invoice'), 0)::bigint,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'other'), 0)::bigint,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'purchase'), 0)::bigint,
           coalesce(sum(ce.amount_cents) filter (where ce.type = 'finance'), 0)::bigint,
           coalesce(sum(ce.amount_cents), 0)::bigint,
           count(*)::integer
      from public.cost_entries ce
     where ce.farm_id = p_farm
       and ce.deleted_at is null
       and ce.occurred_on between p_from and p_to
       and (p_machine is null or ce.machine_id = p_machine)
     group by 1, 2;
end $$;

comment on function public.assistant_cost_summary(uuid, date, date, text, uuid) is
  'Cost ledger totals in a period (ex VAT), by machine or by month, optionally for one '
  'machine, one column per cost type, under the caller''s own policies: nothing for a role '
  'that may not see costs.';

revoke execute on function public.assistant_fuel_summary(uuid, date, date, text, uuid) from public, anon;
revoke execute on function public.assistant_fuel_consumption(uuid, date, date, uuid) from public, anon;
revoke execute on function public.assistant_cost_summary(uuid, date, date, text, uuid) from public, anon;
grant execute on function public.assistant_fuel_summary(uuid, date, date, text, uuid) to authenticated, service_role;
grant execute on function public.assistant_fuel_consumption(uuid, date, date, uuid) to authenticated, service_role;
grant execute on function public.assistant_cost_summary(uuid, date, date, text, uuid) to authenticated, service_role;
