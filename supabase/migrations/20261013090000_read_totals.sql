-- 20261013090000_read_totals.sql
-- Totals the database adds up, for screens that summed rows the API stops at a thousand.
--
-- The API returns at most 1 000 rows a request and says nothing when it stops. The machines
-- list summed every cost entry of the farm to give each machine its lifetime cost per hour,
-- and every fuel draw writes a cost entry, so a ten-machine farm passes a thousand within a
-- few months and from then on the list shows costs that are simply too low. Rapid Rise's
-- farm and partner lists counted every machine, user, job card, fault, link and document on
-- the platform the same way. A partner's expenses page summed its figures over its newest
-- 200 rows. Each now asks for one row per machine, per farm, per partner, or one in all.
--
-- Each runs as the caller (security invoker), so it returns exactly what the caller's own
-- policies allow: no costs for a role that may not see them, only its own farm or workshop
-- for a farm or partner user, everything for Rapid Rise.

create or replace function public.machine_cost_totals(p_farm uuid default null)
returns table (machine_id uuid, total_cents bigint, entries integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select ce.machine_id,
         coalesce(sum(ce.amount_cents), 0)::bigint,
         count(*)::integer
    from public.cost_entries ce
   where ce.deleted_at is null
     and ce.machine_id is not null
     and (p_farm is null or ce.farm_id = p_farm)
   group by ce.machine_id
$$;

comment on function public.machine_cost_totals(uuid) is
  'Lifetime cost ledger total per machine (every cost type), optionally for one farm, under '
  'the caller''s own policies: nothing for a role that may not see costs.';

revoke execute on function public.machine_cost_totals(uuid) from public, anon;
grant execute on function public.machine_cost_totals(uuid) to authenticated, service_role;

create or replace function public.admin_farm_activity(p_month_start timestamptz)
returns table (
  farm_id         uuid,
  machines        integer,
  active_users    integer,
  jobs_this_month integer,
  last_activity   timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with m as (
    select mc.farm_id, count(*)::integer as n
      from public.machines mc
     where mc.deleted_at is null
     group by mc.farm_id
  ), u as (
    select us.farm_id, count(*)::integer as n
      from public.users us
     where us.active and us.farm_id is not null
     group by us.farm_id
  ), j as (
    select jc.farm_id,
           (count(*) filter (where jc.created_at >= p_month_start))::integer as n,
           max(jc.created_at) as last
      from public.job_cards jc
     where jc.deleted_at is null
     group by jc.farm_id
  ), f as (
    select ft.farm_id, max(ft.created_at) as last
      from public.faults ft
     where ft.deleted_at is null
     group by ft.farm_id
  )
  select fa.id, coalesce(m.n, 0), coalesce(u.n, 0), coalesce(j.n, 0), greatest(j.last, f.last)
    from public.farms fa
    left join m on m.farm_id = fa.id
    left join u on u.farm_id = fa.id
    left join j on j.farm_id = fa.id
    left join f on f.farm_id = fa.id
$$;

comment on function public.admin_farm_activity(timestamptz) is
  'Per farm: live machines, active users, job cards opened since p_month_start and the last '
  'job card or fault, under the caller''s own policies (every farm for Rapid Rise).';

revoke execute on function public.admin_farm_activity(timestamptz) from public, anon;
grant execute on function public.admin_farm_activity(timestamptz) to authenticated, service_role;

-- A partner's expense figures: what is still owed to suppliers, what was spent, the VAT that
-- can be claimed, and the VAT claimed with no tax invoice behind it. The expenses page summed
-- these over its newest 200 rows, so an unpaid bill older than those fell out of "still
-- owed". One row, always (an aggregate with no grouping).
create or replace function public.partner_expense_position(p_workshop uuid)
returns table (
  expenses              integer,
  spent_cents           bigint,
  claimable_vat_cents   bigint,
  unpaid                integer,
  unpaid_cents          bigint,
  unsupported           integer,
  unsupported_vat_cents bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select count(*)::integer,
         coalesce(sum(pe.amount_cents + pe.vat_cents), 0)::bigint,
         coalesce(sum(pe.vat_cents) filter (where pe.vat_claimable), 0)::bigint,
         (count(*) filter (where pe.paid_on is null))::integer,
         coalesce(sum(pe.amount_cents + pe.vat_cents) filter (where pe.paid_on is null), 0)::bigint,
         (count(*) filter (where pe.vat_claimable and pe.vat_cents > 0 and pe.receipt_path is null))::integer,
         coalesce(sum(pe.vat_cents) filter (where pe.vat_claimable and pe.vat_cents > 0 and pe.receipt_path is null), 0)::bigint
    from public.partner_expenses pe
   where pe.deleted_at is null
     and pe.workshop_id = p_workshop
$$;

comment on function public.partner_expense_position(uuid) is
  'One workshop''s expense figures (VAT-inclusive totals, claimable VAT, unpaid, VAT with no '
  'tax invoice) over every expense, under the caller''s own policies.';

revoke execute on function public.partner_expense_position(uuid) from public, anon;
grant execute on function public.partner_expense_position(uuid) to authenticated, service_role;

-- Rapid Rise's partner list: active farm links and issued documents per partner, counted
-- here instead of reading every link and document on the platform.
create or replace function public.admin_partner_activity()
returns table (workshop_id uuid, active_clients integer, documents integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with l as (
    select wl.workshop_id, count(*)::integer as n
      from public.workshop_links wl
     where wl.deleted_at is null and wl.status = 'active'
     group by wl.workshop_id
  ), d as (
    select pd.workshop_id, count(*)::integer as n
      from public.partner_documents pd
     where pd.deleted_at is null and pd.status <> 'draft'
     group by pd.workshop_id
  )
  select w.id, coalesce(l.n, 0), coalesce(d.n, 0)
    from public.workshops w
    left join l on l.workshop_id = w.id
    left join d on d.workshop_id = w.id
   where w.deleted_at is null
$$;

comment on function public.admin_partner_activity() is
  'Per partner: active farm links and documents past draft, under the caller''s own policies '
  '(every partner for Rapid Rise).';

revoke execute on function public.admin_partner_activity() from public, anon;
grant execute on function public.admin_partner_activity() to authenticated, service_role;
