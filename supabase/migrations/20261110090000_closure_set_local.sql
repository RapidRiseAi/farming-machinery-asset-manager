-- 20261110090000_closure_set_local.sql
-- Permanent closure could not run on the live database.
--
-- Both functions below switched the guard triggers off with set_config(), and only a superuser
-- may do that. The hosted database has no superuser: it lets the database owner change this
-- one setting through a plain SET statement, which goes through a check that set_config()
-- skips. So the two functions are restated with SET LOCAL and nothing else changed. LOCAL
-- keeps it to this transaction, and each function turns the guards back on before it returns.

create or replace function public.close_farm_permanently(p_farm uuid, p_by uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_farm    public.farms%rowtype;
  v_closer  public.users%rowtype;
  v_keep    text[] := array['billing_invoices', 'billing_invoice_lines', 'billing_payments',
                            'billing_payment_attempts', 'billing_subscriptions',
                            'farm_closures'];
  v_leaving uuid[];
  v_files   jsonb;
  v_rows    bigint := 0;
  v_n       bigint;
  v_changed boolean;
  v_closure uuid;
  t         record;
  fk        record;
  v_where   text;
begin
  select * into v_farm from public.farms where id = p_farm for update;
  if not found then raise exception 'no such account' using errcode = 'P0002'; end if;
  if v_farm.deleted_at is not null then raise exception 'already closed' using errcode = 'P0001'; end if;

  select * into v_closer from public.users where id = p_by;

  select coalesce(jsonb_agg(jsonb_build_object('bucket', f.bucket_id, 'path', f.name)), '[]'::jsonb)
    into v_files from public.farm_file_objects(p_farm) f;

  -- Whoever belongs only here leaves altogether; anyone else moves to another of their sites.
  select coalesce(array_agg(u.id), '{}') into v_leaving
    from public.users u
   where u.farm_id = p_farm
     and not exists (
       select 1 from public.user_farm_memberships m
        where m.user_id = u.id and m.farm_id <> p_farm and m.active and m.deleted_at is null);

  update public.users u
     set farm_id = (select m.farm_id from public.user_farm_memberships m
                     where m.user_id = u.id and m.farm_id <> p_farm and m.active and m.deleted_at is null
                     order by m.created_at limit 1)
   where u.farm_id = p_farm and not (u.id = any (v_leaving));

  -- Past the guards from here: they exist to stop exactly the deleting this function is for.
  set local session_replication_role = replica;

  -- A contractor's own records, without the link to this account.
  update public.partner_documents set farm_id = null where farm_id = p_farm;
  update public.partner_document_lines set farm_id = null where farm_id = p_farm;
  update public.partner_document_revisions set farm_id = null where farm_id = p_farm;
  update public.partner_payments set farm_id = null where farm_id = p_farm;
  update public.partner_clients set farm_id = null, link_status = 'unlinked' where farm_id = p_farm;

  for t in
    select c.table_schema s, c.table_name n
      from information_schema.columns c
      join information_schema.tables b on b.table_schema = c.table_schema and b.table_name = c.table_name
     where c.column_name = 'farm_id' and b.table_type = 'BASE TABLE'
       and c.table_schema in ('public', 'app') and not (c.table_name = any (v_keep))
  loop
    execute format('delete from %I.%I where farm_id = $1', t.s, t.n) using p_farm;
    get diagnostics v_n = row_count;
    v_rows := v_rows + v_n;
  end loop;

  -- The replica role also skipped every cascade, so whatever pointed at those rows is next.
  for i in 1..8 loop
    v_changed := false;
    for fk in
      select ns.nspname cs, cl.relname cr, pn.nspname ps, pc.relname pr,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(con.conkey) with ordinality k(n, ord)
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) cols,
             (select array_agg(a.attname::text order by k.ord)
                from unnest(con.confkey) with ordinality k(n, ord)
                join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n) pcols,
             (select bool_and(not a.attnotnull)
                from unnest(con.conkey) k(n)
                join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n) nullable
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid join pg_namespace ns on ns.oid = cl.relnamespace
        join pg_class pc on pc.oid = con.confrelid join pg_namespace pn on pn.oid = pc.relnamespace
       where con.contype = 'f' and ns.nspname in ('public', 'app') and pn.nspname in ('public', 'app')
    loop
      select format('%s and not exists (select 1 from %I.%I p where %s)',
                    (select string_agg(format('c.%I is not null', c), ' and ') from unnest(fk.cols) c),
                    fk.ps, fk.pr,
                    (select string_agg(format('p.%I = c.%I', fk.pcols[o], c), ' and ')
                       from unnest(fk.cols) with ordinality u(c, o)))
        into v_where;

      if fk.nullable then
        execute format('update %I.%I c set %s where %s', fk.cs, fk.cr,
                       (select string_agg(format('%I = null', c), ', ') from unnest(fk.cols) c), v_where);
      elsif fk.cr = any (v_keep) then
        execute format('select count(*) from %I.%I c where %s', fk.cs, fk.cr, v_where) into v_n;
        if v_n > 0 then
          raise exception 'a kept record in % would lose what it needs', fk.cr using errcode = 'P0001';
        end if;
        continue;
      else
        execute format('delete from %I.%I c where %s', fk.cs, fk.cr, v_where);
      end if;

      get diagnostics v_n = row_count;
      if v_n > 0 then
        v_changed := true;
        v_rows := v_rows + v_n;
      end if;
    end loop;
    exit when not v_changed;
  end loop;

  update public.billing_subscriptions
     set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), ended_on = coalesce(ended_on, current_date)
   where farm_id = p_farm and status <> 'cancelled';

  -- An empty marker: the kept invoices need something to point at, and nothing more.
  update public.farms
     set status = 'cancelled', deleted_at = now(), settings = '{}'::jsonb, billing_email = null
   where id = p_farm;

  set local session_replication_role = origin;

  insert into public.farm_closures (farm_id, business_name, closed_by_name, closed_by_email, exported_at,
                                    retain_until, rows_removed, logins_removed, pending_files)
  values (p_farm, v_farm.name, v_closer.name, v_closer.email, v_farm.last_export_at,
          (current_date + interval '5 years')::date, v_rows, coalesce(array_length(v_leaving, 1), 0), v_files)
  returning id into v_closure;

  return jsonb_build_object('closure', v_closure, 'logins', to_jsonb(v_leaving), 'files', v_files, 'rows', v_rows);
end $$;

-- Five years on, what was kept for tax goes too. Run nightly.
create or replace function public.purge_expired_closures()
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_done integer := 0;
begin
  set local session_replication_role = replica;
  for c in select id, farm_id from public.farm_closures where retain_until < current_date loop
    delete from public.billing_invoice_lines where farm_id = c.farm_id;
    delete from public.billing_payments where farm_id = c.farm_id;
    delete from public.billing_payment_attempts where farm_id = c.farm_id;
    delete from public.billing_invoices where farm_id = c.farm_id;
    delete from public.billing_subscriptions where farm_id = c.farm_id;
    delete from public.farms where id = c.farm_id;
    delete from public.farm_closures where id = c.id;
    v_done := v_done + 1;
  end loop;
  set local session_replication_role = origin;
  return v_done;
end $$;

revoke all on function public.close_farm_permanently(uuid, uuid) from public, anon, authenticated;
revoke all on function public.purge_expired_closures() from public, anon, authenticated;
grant execute on function public.close_farm_permanently(uuid, uuid) to service_role;
grant execute on function public.purge_expired_closures() to service_role;
