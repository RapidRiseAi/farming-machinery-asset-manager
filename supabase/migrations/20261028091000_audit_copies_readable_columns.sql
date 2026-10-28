-- The activity log must never show a reader more than the source table would (part 2 of 5):
-- app_audit() copies only the columns a signed-in reader may select on the table.
--
-- Before this, 0510's body wrote `to_jsonb(old)` / `to_jsonb(new)` whole, so a column the
-- grant withholds from `authenticated` (a card's Paystack authorization code, a vehicle's
-- purchase price, a job card's totals) was handed to everyone who could read the farm's log.
-- The column grant is the decision about who may see a column; the log now honours it.
--
-- What changes, and what does not:
--   * WHO is unchanged: `user_id` is still `auth.uid()` and nothing else; the location
--     columns come from app.audit_context() exactly as in 0510.
--   * A column `authenticated` may not SELECT is left out of `old` and `new`. When an
--     update changed one, its NAME (never its value) is listed under `withheld`, so a
--     finance-only edit still shows as an edit (src/lib/audit-context.ts reads it).
--   * The values of withheld columns are no longer kept anywhere in the log, for Rapid Rise
--     either. The tables keep their own history (cost_entries for money; the job card lock
--     for approved cards); a second copy of a charge credential is not an audit trail.
--   * Where the row is filed is decided by the next migration (20261028091500), at the one
--     door every audit row goes through. This trigger still passes the row's farm.
--   * Fast: one has_table_privilege check per row; only the twelve tables with column-level
--     grants then read their own pg_attribute rows. Nothing is cached, so a grant changed by
--     a later migration takes effect on the next row, never after a refresh someone forgot.
--   * A failure here never stops the write: the row is audited with
--     {"redaction_failed": true} instead of the data, and a WARNING names the table.

-- The columns of a table that the signed-in role may not select. Empty when the table grant
-- covers every column, which is the case for all but a dozen tables.
create or replace function app.audit_hidden_columns(p_table regclass)
returns text[]
language sql
stable
set search_path = ''
as $$
  select case
    when pg_catalog.has_table_privilege('authenticated', p_table, 'SELECT') then '{}'::text[]
    else coalesce(
      (select pg_catalog.array_agg(a.attname::text order by a.attnum)
         from pg_catalog.pg_attribute a
        where a.attrelid = p_table
          and a.attnum > 0
          and not a.attisdropped
          and not pg_catalog.has_column_privilege('authenticated', p_table, a.attnum, 'SELECT')),
      '{}'::text[])
  end;
$$;

comment on function app.audit_hidden_columns(regclass) is
  'Columns of the table that authenticated may not SELECT (empty when the table grant covers '
  'all). The audit log never holds them (20261028091000).';

-- Take the hidden keys out of an audit diff ({old, new}). For an update, the names of hidden
-- columns whose value changed are listed under "withheld" (merged with any already there),
-- so the event stays visible without its value. Idempotent: a second pass finds nothing.
create or replace function app.audit_withhold(p_diff jsonb, p_hidden text[])
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_old     jsonb;
  v_new     jsonb;
  v_changed text[];
  v_out     jsonb := p_diff;
begin
  if p_diff is null
     or pg_catalog.jsonb_typeof(p_diff) <> 'object'
     or coalesce(pg_catalog.cardinality(p_hidden), 0) = 0 then
    return p_diff;
  end if;

  v_old := p_diff -> 'old';
  v_new := p_diff -> 'new';

  if pg_catalog.jsonb_typeof(v_old) = 'object' and pg_catalog.jsonb_typeof(v_new) = 'object' then
    select pg_catalog.array_agg(k order by k)
      into v_changed
      from pg_catalog.unnest(p_hidden) as k
     where (v_old -> k) is distinct from (v_new -> k);
  end if;

  if pg_catalog.jsonb_typeof(v_old) = 'object' then
    v_out := pg_catalog.jsonb_set(v_out, '{old}', v_old - p_hidden);
  end if;
  if pg_catalog.jsonb_typeof(v_new) = 'object' then
    v_out := pg_catalog.jsonb_set(v_out, '{new}', v_new - p_hidden);
  end if;

  if v_changed is not null then
    v_out := v_out || pg_catalog.jsonb_build_object('withheld', (
      select pg_catalog.jsonb_agg(w order by w)
        from (
          select pg_catalog.jsonb_array_elements_text(
                   case when pg_catalog.jsonb_typeof(p_diff -> 'withheld') = 'array'
                        then p_diff -> 'withheld' else '[]'::jsonb end) as w
          union
          select pg_catalog.unnest(v_changed)
        ) s));
  end if;

  return v_out;
end;
$$;

comment on function app.audit_withhold(jsonb, text[]) is
  'Strips the given keys from an audit diff''s old/new; names changed ones under "withheld". '
  '20261028091000.';

-- G11: no PUBLIC or anon execute on an app helper. Only the definer triggers call these.
revoke all on function app.audit_hidden_columns(regclass) from public, anon, authenticated;
revoke all on function app.audit_withhold(jsonb, text[]) from public, anon, authenticated;

-- The trigger, 0510's body with the copy narrowed. Same name, same signature, same triggers.
create or replace function public.app_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
  v_old  jsonb;
  v_new  jsonb;
  v_row  jsonb;
  v_diff jsonb;
  v_ip   inet;
  v_cty  text;
  v_reg  text;
  v_city text;
  v_ua   text;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  if tg_op = 'DELETE' then
    v_diff := jsonb_build_object('old', v_old);
  elsif tg_op = 'UPDATE' then
    v_diff := jsonb_build_object('old', v_old, 'new', v_new);
  else
    v_diff := jsonb_build_object('new', v_new);
  end if;

  -- Only what a signed-in reader may select on this table.
  begin
    v_diff := app.audit_withhold(v_diff, app.audit_hidden_columns(tg_relid));
  exception when others then
    raise warning 'app_audit: could not redact a % row (%), audited without its data', tg_table_name, sqlerrm;
    v_diff := jsonb_build_object('redaction_failed', true);
  end;

  begin
    select c.ip, c.geo_country, c.geo_region, c.geo_city, c.user_agent
      into v_ip, v_cty, v_reg, v_city, v_ua
      from app.audit_context() c;
  exception when others then
    v_ip := null; v_cty := null; v_reg := null; v_city := null; v_ua := null;
  end;

  insert into audit_log(farm_id, user_id, entity, entity_id, action, diff,
                        ip, geo_country, geo_region, geo_city, user_agent)
  values ((v_row ->> 'farm_id')::uuid, v_user, tg_table_name, (v_row ->> 'id')::uuid,
          lower(tg_op), v_diff, v_ip, v_cty, v_reg, v_city, v_ua);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;
