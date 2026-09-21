-- Can these migrations be applied BEFORE the code that uses them is deployed?
--
-- The live site runs whatever was last pushed, and migrations are applied by hand. So
-- there is always a window where the new schema is live and the old code is calling it.
-- A migration that drops a function signature the deployed app still calls closes that
-- window violently: every call answers PGRST202 until the build goes out.
--
-- This suite pins the call shapes the DEPLOYED app uses, by NAME, exactly as PostgREST
-- resolves them. It caught a real one: 20260920130000 dropped the four-argument
-- `set_notification_prefs` that origin/main calls and demanded a fifth with no default,
-- which would have broken the notification-preferences save for every customer the moment
-- it ran.

\set ON_ERROR_STOP on
set client_min_messages to warning;

begin;

-- == (a) Calls the deployed build makes, by named argument ===================
--
-- Each of these is a `supabase.rpc(...)` in the code at origin/main. They are invoked with
-- NAMED arguments and nothing else, because that is what PostgREST does, and a defaulted
-- parameter is the only thing that keeps an older call working after a signature grows.
do $$
declare
  r record;
  v_oid oid;
  v_missing text := '';
begin
  for r in
    select * from (values
      -- The notification preferences screen. Four arguments on the live site; the fifth
      -- (p_email) was added by 20260920130000 and MUST default.
      ('set_notification_prefs', array['p_inapp','p_push','p_quiet_start','p_quiet_end']),
      -- Sign-up. Seven arguments on the live site; p_promo_code was added by 20260920160000.
      ('billing_create_pending_signup',
       array['p_user','p_email','p_name','p_farm_name','p_plan','p_period','p_quota']),
      -- Checklist sign-off. One argument on the live site; p_actor was added by 20260920120000.
      ('record_checklist_defects', array['p_instance'])
    ) as t(fn, args)
  loop
    -- Resolve exactly as PostgREST would: a function of this name where every argument
    -- the caller names exists, and every argument WITHOUT a default is one the caller
    -- names. `proargnames` is in declaration order and the defaulted ones are the last
    -- `pronargdefaults` of them, which is what makes the slice below the required set.
    select p.oid into v_oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join lateral (
        select coalesce(p.proargnames, array[]::text[]) as names
      ) a
      cross join lateral (
        select a.names[1 : greatest(coalesce(array_length(a.names, 1), 0) - p.pronargdefaults, 0)]
                 as required
      ) q
     where n.nspname = 'public'
       and p.proname = r.fn
       and r.args <@ a.names
       and q.required <@ r.args
     limit 1;

    if v_oid is null then
      v_missing := v_missing || format(E'\n  %s(%s)', r.fn, array_to_string(r.args, ', '));
    end if;
    v_oid := null;
  end loop;

  if v_missing <> '' then
    raise exception
      'DEPLOY COMPAT FAIL: the live site calls these and no function would answer:%',
      v_missing;
  end if;
end $$;

-- == (b) And the calls the NEW code makes resolve too =========================
-- Otherwise this suite would pass by keeping the old signature and breaking the new one.
do $$
declare v_oid oid;
begin
  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_notification_prefs'
     and array['p_inapp','p_push','p_email','p_quiet_start','p_quiet_end']
         <@ coalesce(p.proargnames, array[]::text[]);
  if v_oid is null then
    raise exception 'DEPLOY COMPAT FAIL: the new five-argument preferences call has no function';
  end if;

  select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'billing_create_pending_signup'
     and 'p_promo_code' = any (coalesce(p.proargnames, array[]::text[]));
  if v_oid is null then
    raise exception 'DEPLOY COMPAT FAIL: the promo-code sign-up call has no function';
  end if;
end $$;

-- == (c) One function per name, so PostgREST never has to choose ==============
-- Two overloads of the same name is how "function is not unique" reaches a customer.
do $$
declare r record;
begin
  for r in
    select p.proname, count(*) as n
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'set_notification_prefs', 'billing_create_pending_signup',
         'record_checklist_defects', 'billing_check_promo_code',
         'billing_take_promo_code', 'farm_book_values')
     group by p.proname having count(*) > 1
  loop
    raise exception 'DEPLOY COMPAT FAIL: % has % overloads; PostgREST resolves by name',
      r.proname, r.n;
  end loop;
end $$;

-- == (d) No app-schema helper is executable by anon ==========================
--
-- `create function` grants EXECUTE to PUBLIC, and `anon` inherits through PUBLIC. Eight
-- helpers shipped on 21/09/2026 with that default because each one said `grant execute
-- ... to authenticated` and none said `revoke ... from public`.
--
-- `rls_isolation.sql` has asserted this since G11, but that suite runs only on real
-- Postgres in CI, so every local gate was green while the grants were wrong. This is the
-- same assertion in a suite `pnpm db:check` runs, which is the difference between finding
-- it in thirty seconds and finding it after a push to production.
--
-- `anon` also has no USAGE on schema `app`, so a leaked EXECUTE is not reachable today.
-- That is exactly why it is worth asserting: the product must not depend on the second
-- lock being right for ever.
do $$
declare v_leaked text;
begin
  select string_agg(format('app.%s', p.proname), ', ' order by p.proname)
    into v_leaked
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'app'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_leaked is not null then
    raise exception 'DEPLOY COMPAT FAIL: anon can execute app-schema helpers: %', v_leaked;
  end if;
end $$;

-- == (e) Nor is any app-schema helper reachable through PostgREST ============
-- PostgREST exposes `public` only, so a function in `app` is unreachable by design. This
-- asserts the other half: that nobody has quietly granted `anon` its way into the schema.
do $$
begin
  if has_schema_privilege('anon', 'app', 'USAGE') then
    raise exception 'DEPLOY COMPAT FAIL: anon has USAGE on schema app';
  end if;
end $$;

rollback;
