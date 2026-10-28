-- The activity log must never show a reader more than the source table would (part 3 of 5):
-- one door for every row that reaches audit_log.
--
-- app_audit() is not the only writer. Four tables have a redacting trigger of their own
-- (api_tokens, report_schedule_recipients, voice_captures, ai_interactions), a few RPCs
-- write named events by hand, and the next package to add an audit function will not have
-- read this file. So the rule is applied where all of them meet: a BEFORE INSERT trigger on
-- audit_log itself.
--
-- For a row whose `entity` is a public table:
--   1. keys for columns `authenticated` may not SELECT on that table are stripped from
--      old/new (app.audit_withhold, 20261028091000). A no-op for app_audit()'s own rows,
--      which arrive stripped; it is what covers every other writer;
--   2. the table's rule (app.audit_table_rules, 20261028090000) decides the filing. 'farm'
--      keeps the farm the writer gave. Anything else ('rapid_rise', or a table nobody has
--      classified yet) is filed with farm_id NULL, which only Rapid Rise reads, and the
--      farm it is about moves to the new `about_farm_id`.
-- A row whose entity is not a table (admin_farm_access, data_subject_*) is a named event
-- whose writer chose its farm and its few keys on purpose; it passes untouched.
--
-- Why keep the farm at all: a farm's history must stay findable and removable as one thing.
-- Closing a farm, exporting it, or keeping test farms apart (is_test) needs every row about
-- it, so a purge or lookup is `farm_id = X or about_farm_id = X`. The policy never reads
-- about_farm_id, and only Rapid Rise can see a row that has one.
--
-- Never stops a write: if filing fails, the row is kept for Rapid Rise with
-- {"redaction_failed": true} instead of its data, and a WARNING names the entity.

alter table public.audit_log add column if not exists about_farm_id uuid;

comment on column public.audit_log.about_farm_id is
  'For a row filed for Rapid Rise only (farm_id null) because its table is narrower than a '
  'farm''s log: the farm it is about. Null when farm_id already says it. Purges and exports '
  'of a farm match farm_id or about_farm_id (20261028091500).';

create index if not exists audit_log_about_farm_idx
  on public.audit_log (about_farm_id) where about_farm_id is not null;

-- The farm an audit row is about when its writer did not say: a farms row is about
-- itself; otherwise the farm_id inside the diff, when it is a well-formed uuid.
create or replace function app.audit_about_farm(p_entity text, p_entity_id uuid, p_diff jsonb)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when p_entity = 'farms' then p_entity_id
    when coalesce(p_diff -> 'new' ->> 'farm_id', p_diff -> 'old' ->> 'farm_id')
         ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then coalesce(p_diff -> 'new' ->> 'farm_id', p_diff -> 'old' ->> 'farm_id')::uuid
  end;
$$;

revoke all on function app.audit_about_farm(text, uuid, jsonb) from public, anon, authenticated;

create or replace function app.audit_log_file() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_rel    regclass;
  v_hidden text[];
  v_scope  text;
begin
  begin
    v_rel := pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(new.entity));
    if v_rel is null then
      return new;
    end if;

    v_hidden := app.audit_hidden_columns(v_rel);
    if pg_catalog.cardinality(v_hidden) > 0 then
      new.diff := app.audit_withhold(new.diff, v_hidden);
    end if;

    select r.scope into v_scope
      from app.audit_table_rules r
     where r.table_name = new.entity;

    if v_scope is distinct from 'farm' then
      new.about_farm_id := coalesce(new.about_farm_id, new.farm_id,
                                    app.audit_about_farm(new.entity, new.entity_id, new.diff));
      new.farm_id := null;
    end if;
  exception when others then
    raise warning 'audit_log: could not file a % row (%), kept for Rapid Rise without its data',
      new.entity, sqlerrm;
    new.about_farm_id := coalesce(new.about_farm_id, new.farm_id);
    new.farm_id := null;
    new.diff := pg_catalog.jsonb_build_object('redaction_failed', true);
  end;
  return new;
end $$;

comment on function app.audit_log_file() is
  'BEFORE INSERT on audit_log: strips columns authenticated may not select and files rows of '
  'tables narrower than a farm''s log for Rapid Rise only, per app.audit_table_rules. '
  '20261028091500.';

revoke all on function app.audit_log_file() from public, anon, authenticated;

drop trigger if exists audit_log_file on public.audit_log;
create trigger audit_log_file
  before insert on public.audit_log
  for each row execute function app.audit_log_file();
