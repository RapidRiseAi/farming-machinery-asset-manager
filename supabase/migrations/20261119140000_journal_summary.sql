-- 20261119140000_journal_summary.sql
-- The accounting page's summary worked out in the database (task B3; BRIEF section 19).
--
-- /accounting read every journal line of the period (up to 100,000) into the server to sum
-- the totals and the per-account summary it leads with. A busy year is tens of thousands of
-- lines held in memory to show a dozen numbers. These two functions sum the same lines in
-- SQL and return only the summary. They are SECURITY INVOKER and read the same
-- farm_journal / partner_journal functions, so the caller's own permissions decide exactly
-- as they do for the journal itself; nothing here widens who may see what.
--
-- Additive: four new functions; the journal functions and the CSV export are unchanged.

create or replace function public.farm_journal_accounts(p_farm uuid, p_from date, p_to date)
returns table (account_key text, account_code text, debit_cents bigint, credit_cents bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  select j.account_key, min(j.account_code), sum(j.debit_cents)::bigint, sum(j.credit_cents)::bigint
    from public.farm_journal(p_farm, p_from, p_to) j
   group by j.account_key;
$$;

create or replace function public.partner_journal_accounts(p_workshop uuid, p_from date, p_to date)
returns table (account_key text, account_code text, debit_cents bigint, credit_cents bigint)
language sql stable security invoker set search_path = public, pg_temp as $$
  select j.account_key, min(j.account_code), sum(j.debit_cents)::bigint, sum(j.credit_cents)::bigint
    from public.partner_journal(p_workshop, p_from, p_to) j
   group by j.account_key;
$$;

-- Totals, and the entries whose debits and credits differ (the first twenty named).
create or replace function public.farm_journal_totals(p_farm uuid, p_from date, p_to date)
returns table (debit_cents bigint, credit_cents bigint, entries bigint, lines bigint, unbalanced_count bigint, unbalanced text[])
language sql stable security invoker set search_path = public, pg_temp as $$
  with e as (
    select j.entry_key, sum(j.debit_cents) as dr, sum(j.credit_cents) as cr, count(*) as n
      from public.farm_journal(p_farm, p_from, p_to) j
     group by j.entry_key
  )
  select coalesce(sum(dr), 0)::bigint, coalesce(sum(cr), 0)::bigint, count(*)::bigint, coalesce(sum(n), 0)::bigint,
         (count(*) filter (where dr <> cr))::bigint,
         coalesce((array_agg(entry_key order by entry_key) filter (where dr <> cr))[1:20], '{}')
    from e;
$$;

create or replace function public.partner_journal_totals(p_workshop uuid, p_from date, p_to date)
returns table (debit_cents bigint, credit_cents bigint, entries bigint, lines bigint, unbalanced_count bigint, unbalanced text[])
language sql stable security invoker set search_path = public, pg_temp as $$
  with e as (
    select j.entry_key, sum(j.debit_cents) as dr, sum(j.credit_cents) as cr, count(*) as n
      from public.partner_journal(p_workshop, p_from, p_to) j
     group by j.entry_key
  )
  select coalesce(sum(dr), 0)::bigint, coalesce(sum(cr), 0)::bigint, count(*)::bigint, coalesce(sum(n), 0)::bigint,
         (count(*) filter (where dr <> cr))::bigint,
         coalesce((array_agg(entry_key order by entry_key) filter (where dr <> cr))[1:20], '{}')
    from e;
$$;

do $do$
declare f text;
begin
  foreach f in array array[
    'public.farm_journal_accounts(uuid,date,date)',
    'public.partner_journal_accounts(uuid,date,date)',
    'public.farm_journal_totals(uuid,date,date)',
    'public.partner_journal_totals(uuid,date,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
