-- scripts/schema_fingerprint.sql
--
-- Prints one short line per schema object, so that two databases can be compared with
-- `diff` instead of by reading two dumps. Run it against a database built from
-- supabase/migrations, run it against the live project, diff the two files.
-- See docs/SCHEMA_DRIFT.md for the exact commands.
--
-- Why this exists: `db:test` builds a database FROM the migrations, so it can only ever
-- prove that the REPO is sound. An object created directly on the live project — by
-- hand, in the SQL editor, during a debugging session — is invisible to it. That is not
-- hypothetical: public._f14_probe(uuid) lived on production for a whole session with
-- every test green, and let any signed-in user read another tenant's document counts.
-- Migration 0440 removed it; this script is how it was found.
--
-- Three normalisations, each earned the hard way comparing a Windows checkout against a
-- Linux-hosted project. Without them the output is full of differences that are not
-- differences:
--
--   1. Carriage returns are stripped. Postgres stores a function body verbatim, so a
--      CRLF checkout puts a \r on every line of every function body. It is whitespace to
--      the parser and invisible in psql, but it changes the hash of all 111 functions.
--   2. SQL line comments are stripped. Migrations applied by pasting into the SQL editor
--      can arrive with comments removed, which changes nothing about behaviour.
--   3. Ordering is forced to the C collation. The default collation differs between a
--      local cluster and the hosted one, and `_` and `.` sort differently under each, so
--      identical object sets can aggregate to different hashes.
--
-- What it does NOT normalise: anything semantic. If two function bodies differ in a
-- single operator, they hash differently and show up.

-- Pure SQL, no psql meta-commands, so it can also be pasted into the Supabase SQL
-- editor when there is no direct database connection to hand. From psql use -tA to get
-- clean, diffable lines.

with cols as (
  select 'column' as kind, c.table_schema||'.'||c.table_name as obj,
         string_agg(c.column_name||'|'||c.data_type||'|'||coalesce(c.character_maximum_length::text,'')
                    ||'|'||c.is_nullable||'|'||coalesce(c.column_default,''), ',' order by c.column_name collate "C") as sig
  from information_schema.columns c
  join pg_class pc on pc.relname = c.table_name
  join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
  where c.table_schema in ('public','app')
    and pc.relkind in ('r','p','v')
    and not exists (select 1 from pg_depend d where d.objid = pc.oid and d.deptype = 'e')
  group by 1,2
),
pol as (
  select 'policy', schemaname||'.'||tablename,
         string_agg(policyname||'|'||coalesce(cmd,'')||'|'||coalesce(roles::text,'')
                    ||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), ',' order by policyname collate "C")
  from pg_policies where schemaname in ('public','app') group by 1,2
),
fn as (
  select 'function', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         -- CR stripped, line comments stripped, whitespace collapsed: see header.
         regexp_replace(
           regexp_replace(replace(pg_get_functiondef(p.oid), chr(13), ''), '--[^\n]*', '', 'g'),
           '\s+', ' ', 'g')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','app') and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
),
-- Function EXECUTE grants are tracked separately: they are not part of a function's
-- definition, so a body-only comparison would miss a helper left executable by anon.
fnacl as (
  select 'function-grant', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         concat_ws(',',
           case when has_function_privilege('anon',          p.oid, 'EXECUTE') then 'anon'          end,
           case when has_function_privilege('authenticated', p.oid, 'EXECUTE') then 'authenticated' end,
           case when has_function_privilege('service_role',  p.oid, 'EXECUTE') then 'service_role'  end)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','app') and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
),
trg as (
  select 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, pg_get_triggerdef(t.oid)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','app') and not t.tgisinternal
),
con as (
  select 'constraint', n.nspname||'.'||c.relname||'.'||con.conname, pg_get_constraintdef(con.oid)
  from pg_constraint con join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','app')
),
idx as (
  select 'index', schemaname||'.'||tablename||'.'||indexname, indexdef
  from pg_indexes where schemaname in ('public','app')
),
enm as (
  select 'enum', n.nspname||'.'||t.typname, string_agg(e.enumlabel, ',' order by e.enumsortorder)
  from pg_type t join pg_namespace n on n.oid = t.typnamespace
  join pg_enum e on e.enumtypid = t.oid
  where n.nspname in ('public','app') group by 1,2
),
tblgrant as (
  select 'table-grant', table_schema||'.'||table_name,
         string_agg(grantee||':'||privilege_type, ',' order by grantee collate "C", privilege_type collate "C")
  from information_schema.role_table_grants
  where table_schema in ('public','app') and grantee in ('anon','authenticated','service_role')
  group by 1,2
),
rls as (
  select 'rls', n.nspname||'.'||c.relname, c.relrowsecurity::text||'|'||c.relforcerowsecurity::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','app') and c.relkind = 'r'
    and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')
)
select kind || '  ' || obj || '  ' || md5(sig)
from (
  select * from cols
  union all select * from pol
  union all select * from fn
  union all select * from fnacl
  union all select * from trg
  union all select * from con
  union all select * from idx
  union all select * from enm
  union all select * from tblgrant
  union all select * from rls
) all_objects(kind, obj, sig)
order by kind collate "C", obj collate "C";
