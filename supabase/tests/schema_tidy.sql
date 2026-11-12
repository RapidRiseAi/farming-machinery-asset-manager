\set ON_ERROR_STOP on
-- The schema tidy of 11 November 2026 (20261111150000, 20261111160000): row-security
-- policies evaluate auth.uid() once per query, four functions carry a pinned search_path,
-- and the functions nothing called are gone.
begin;

do $t$
declare
  v text;
  raw integer := 0;
  names text := '';
  r record;
  e text;
  s text;
begin
  -- No policy in public or app calls auth.uid(), auth.jwt(), auth.role() or auth.email()
  -- directly: each call sits inside (select ...), which Postgres prints as "( SELECT auth.uid()".
  for r in
    select p.polname, c.relname,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'app')
  loop
    e := r.expr;
    foreach s in array array['auth.uid()', 'auth.jwt()', 'auth.role()', 'auth.email()'] loop
      raw := (length(e) - length(replace(e, s, ''))) / length(s)
           - (length(e) - length(replace(e, 'SELECT ' || s, ''))) / length('SELECT ' || s);
      if raw > 0 then names := names || r.relname || '.' || r.polname || ' '; end if;
    end loop;
  end loop;
  if names <> '' then raise exception 'policies still call auth functions per row: %', names; end if;

  -- The four functions the advisor named carry a search_path.
  foreach s in array array['public.app_purchase_order_totals()', 'public.app_service_job_source()',
                           'public.app_job_line_version()', 'app.stock_needs_reorder(numeric,numeric)'] loop
    select array_to_string(proconfig, ',') into v from pg_proc where oid = s::regprocedure;
    if v is null or v not like 'search_path=%' then raise exception '% has no pinned search_path', s; end if;
  end loop;

  -- The unused functions are gone, and the app-schema helpers the suites still use remain.
  if to_regprocedure('public.ai_my_usage(uuid)') is not null
     or to_regprocedure('public.fuel_tank_reconciliation(uuid)') is not null
     or to_regprocedure('app.fuel_tank_reconciliation(uuid)') is not null
     or to_regprocedure('public.partner_over_limit(uuid,date)') is not null
     or to_regprocedure('public.purchase_order_invoiced(uuid)') is not null
     or to_regprocedure('public.sync_apply_reading(uuid,uuid,numeric,date,meter_source,uuid,timestamptz)') is not null then
    raise exception 'an unused function is still there';
  end if;
  if to_regprocedure('app.partner_over_limit(uuid,date)') is null
     or to_regprocedure('app.purchase_order_invoiced(uuid)') is null then
    raise exception 'an app-schema helper the suites use is missing';
  end if;
end $t$;

rollback;
