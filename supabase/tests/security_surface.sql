\set ON_ERROR_STOP on
-- What anonymous callers may execute (20261013140000): no trigger function in our schemas.
-- A trigger function cannot be called directly, so the grant was never reachable; this keeps
-- anon's surface to what is meant to be there as new triggers are added.
begin;
do $$
declare v text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by 1) into v
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app')
     and p.prorettype = 'trigger'::regtype
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v is not null then
    raise exception 'anon may execute trigger functions: %', v;
  end if;
end $$;
rollback;
