-- What is in each tank, counted from every delivery and every draw.
--
-- == What was wrong ===========================================================
-- /fuel worked the balance out in the browser's server render from the rows it had
-- fetched for its lists: the newest 400 deliveries and the newest 600 draws. A farm past
-- either number saw a balance that quietly left out its oldest diesel. Worse, draws are
-- filtered per role (app.row_visible_to_role: an operator sees only the draws of the
-- machines assigned to them), so an operator's tank card subtracted only their own
-- draws from every delivery and showed a tank fuller than it was. The dip variance came
-- from the same capped, filtered rows.
--
-- == What this does ===========================================================
-- One row per tank: litres delivered, litres drawn, the balance, and the latest dip with
-- the book balance on that dip's own date. It reads every row, so it runs as its owner,
-- and it answers exactly the people who can already see the tank itself (the fuel_tanks
-- policy: farm access, and a partner only with the costs scope). It returns LITRES only:
-- no price, no cost, no machine and no person, so a tank total tells an operator nothing
-- the per-role filter is there to keep from them.

create or replace function public.fuel_tank_balances(p_farm uuid default null)
returns table (
  tank_id            uuid,
  delivered_litres   numeric,
  issued_litres      numeric,
  balance_litres     numeric,
  dipped_on          date,
  dip_litres         numeric,
  book_at_dip_litres numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
     and app.partner_scope(t.farm_id, 'costs')
   order by t.name, t.id;
$$;

comment on function public.fuel_tank_balances(uuid) is
  'Per tank: litres delivered, drawn and left, and the latest dip against the book balance '
  'on its own date. Counts every row, answers only callers who can see the tank, and '
  'returns litres only. /fuel reads its tank cards from here.';

revoke execute on function public.fuel_tank_balances(uuid) from public, anon;
grant execute on function public.fuel_tank_balances(uuid) to authenticated, service_role;
