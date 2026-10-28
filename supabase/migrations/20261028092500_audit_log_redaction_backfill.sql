-- The activity log must never show a reader more than the source table would (part 5 of 5):
-- the rows already written.
--
-- Everything app_audit() wrote before 20261028091000 still holds whole rows, filed under
-- their farm: every card authorization code ever saved, every dispute's billing dossier,
-- every notification. Precedent: 20260820165542 stripped report recipients' addresses from
-- legacy diffs the same way.
--
-- app.audit_redact_existing() applies to stored rows exactly what the door
-- (20261028091500) applies to new ones, for every entity that is a public table:
--   1. keys for columns `authenticated` may not SELECT are taken out of old/new, and an
--      update that changed one names it under "withheld" (app.audit_withhold);
--   2. rows of a table whose rule is not 'farm' are refiled for Rapid Rise: farm_id null,
--      the farm kept in about_farm_id;
--   3. older Rapid Rise-only rows of those tables (a farms row, say) get about_farm_id too,
--      so a farm's history is one lookup.
-- Named events that are not tables (admin_farm_access, data_subject_*) are left alone.
--
-- It is a function, not a one-off block, so it can be run again: after a later migration
-- withholds another column, or classifies a table differently, `select * from
-- app.audit_redact_existing();` brings the stored rows into line. It is idempotent (a
-- second run changes nothing) and records what each run changed in
-- app.audit_redaction_runs, which is how this backfill's effect on production is read.
--
-- Nothing is deleted: every event keeps its entity, id, action, time, actor and location.
-- Values of withheld columns are gone for good, which is the point.

create table if not exists app.audit_redaction_runs (
  id            bigint generated always as identity primary key,
  ran_at        timestamptz not null default now(),
  entity        text not null,
  rows_stripped bigint not null default 0,
  rows_refiled  bigint not null default 0,
  rows_linked   bigint not null default 0
);

comment on table app.audit_redaction_runs is
  'One row per entity a run of app.audit_redact_existing() changed: rows whose withheld keys '
  'were stripped, rows refiled for Rapid Rise, older Rapid Rise rows linked to their farm. '
  '20261028092500.';

revoke all on table app.audit_redaction_runs from public, anon, authenticated, service_role;

create or replace function app.audit_redact_existing()
returns table (entity text, rows_stripped bigint, rows_refiled bigint, rows_linked bigint)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  r        record;
  v_hidden text[];
  v_scope  text;
  v_strip  bigint;
  v_refile bigint;
  v_link   bigint;
begin
  for r in
    select distinct a.entity as name, pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(a.entity)) as rel
      from public.audit_log a
  loop
    continue when r.rel is null;
    v_strip := 0; v_refile := 0; v_link := 0;

    v_hidden := app.audit_hidden_columns(r.rel);
    if pg_catalog.cardinality(v_hidden) > 0 then
      update public.audit_log a
         set diff = app.audit_withhold(a.diff, v_hidden)
       where a.entity = r.name
         and (coalesce(a.diff -> 'old', '{}'::jsonb) ?| v_hidden
              or coalesce(a.diff -> 'new', '{}'::jsonb) ?| v_hidden);
      get diagnostics v_strip = row_count;
    end if;

    select x.scope into v_scope from app.audit_table_rules x where x.table_name = r.name;
    if v_scope is distinct from 'farm' then
      update public.audit_log a
         set about_farm_id = coalesce(a.about_farm_id, a.farm_id),
             farm_id = null
       where a.entity = r.name
         and a.farm_id is not null;
      get diagnostics v_refile = row_count;

      update public.audit_log a
         set about_farm_id = app.audit_about_farm(a.entity, a.entity_id, a.diff)
       where a.entity = r.name
         and a.farm_id is null
         and a.about_farm_id is null
         and app.audit_about_farm(a.entity, a.entity_id, a.diff) is not null;
      get diagnostics v_link = row_count;
    end if;

    if v_strip + v_refile + v_link > 0 then
      insert into app.audit_redaction_runs (entity, rows_stripped, rows_refiled, rows_linked)
      values (r.name, v_strip, v_refile, v_link);
      entity := r.name; rows_stripped := v_strip; rows_refiled := v_refile; rows_linked := v_link;
      return next;
    end if;
  end loop;
end;
$$;

comment on function app.audit_redact_existing() is
  'Brings stored audit_log rows into line with the door (20261028091500): strips withheld '
  'columns, refiles narrower tables for Rapid Rise. Idempotent; logs to '
  'app.audit_redaction_runs. 20261028092500.';

revoke all on function app.audit_redact_existing() from public, anon, authenticated, service_role;

select * from app.audit_redact_existing();
