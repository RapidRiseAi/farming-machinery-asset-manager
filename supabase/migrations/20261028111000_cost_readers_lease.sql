-- 20261028111000_cost_readers_lease.sql
-- The readers that list cost types one by one learn the new 'lease' type (20261028110000),
-- so a lease payment is neither dropped nor counted under the wrong heading.
--
-- 1. app.cost_account_code: the cost type to the farm journal's account, in one place.
--    'lease' is 6250 "Lease and rental", an expense; interest stays on 6200 "Finance
--    charges". src/lib/accounting.ts lists the same chart for the screen and the export.
-- 2. app.farm_journal (0510) reads it. Otherwise unchanged: VAT is coded from the entry's
--    own rate, so interest (no VAT, a financial service) is NONE and a lease or rental
--    payment carrying VAT is STD.
-- 3. public.assistant_cost_summary (20261005130000) has one column per type and no lease
--    column. Adding one changes the function's result shape, which the deployed build and
--    deploy_compatibility.sql pin; instead lease is counted in other_cents, so the total
--    still equals the sum of the columns (assistant_farm_data.sql asserts that).

create or replace function app.cost_account_code(p_type public.cost_entry_type)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case p_type::text
           when 'purchase' then '1600'   -- plant & machinery, an asset not an expense
           when 'finance'  then '6200'
           when 'lease'    then '6250'
           when 'fuel'     then '6300'
           when 'parts'    then '6400'
           when 'labour'   then '6500'
           when 'invoice'  then '6600'
           else                 '6900'
         end;
$$;

revoke execute on function app.cost_account_code(public.cost_entry_type) from public, anon;
grant execute on function app.cost_account_code(public.cost_entry_type) to authenticated, service_role;

create or replace function app.farm_journal(
  p_farm uuid,
  p_from date,
  p_to   date
) returns table (
  entry_date   date,
  entry_key    text,
  entry_ref    text,
  line_no      int,
  account_code text,
  account_key  text,
  party        text,
  description  text,
  debit_cents  bigint,
  credit_cents bigint,
  vat_code     text,
  vat_rate_bps int,
  source_kind  text,
  source_id    uuid
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with entries as (
    select c.id,
           c.occurred_on,
           c.type,
           c.amount_cents,
           coalesce(c.vat_rate_bps, 0) as rate,
           coalesce(nullif(btrim(m.name), ''), '-')       as machine_name,
           coalesce(nullif(btrim(c.note), ''),
                    coalesce(nullif(btrim(c.source_type), ''), c.type::text)) as descr
      from cost_entries c
      left join machines m on m.id = c.machine_id and m.farm_id = c.farm_id
     where c.farm_id = p_farm
       and c.deleted_at is null
       and c.occurred_on between p_from and p_to
       and c.amount_cents <> 0
  ),
  lines as (
    select e.occurred_on, 'cost:' || e.id::text as k,
           coalesce(nullif(btrim(e.descr), ''), e.type::text) as ref, 1 as ln,
           app.cost_account_code(e.type) as code,
           'cost_' || e.type::text as akey,
           e.machine_name as party, e.descr,
           e.amount_cents::bigint as dr, 0::bigint as cr,
           case when e.rate > 0 then 'STD' else 'NONE' end as vcode,
           e.rate, 'cost_entry' as skind, e.id as sid
      from entries e
    union all
    select e.occurred_on, 'cost:' || e.id::text,
           coalesce(nullif(btrim(e.descr), ''), e.type::text), 2,
           '2000', 'contra', e.machine_name, e.descr,
           0::bigint, e.amount_cents::bigint,
           'NONE', e.rate, 'cost_entry', e.id
      from entries e
  )
  select l.occurred_on, l.k, l.ref, l.ln, l.code, l.akey, l.party, l.descr,
         l.dr::bigint, l.cr::bigint, l.vcode, l.rate, l.skind, l.sid
    from lines l
   order by l.occurred_on, l.k, l.ln;
$$;

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
           -- Lease and rental payments count here: there is no lease column (see above).
           coalesce(sum(ce.amount_cents) filter (where ce.type in ('other', 'lease')), 0)::bigint,
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
