-- 0102_grants.sql
-- Table/sequence privileges. RLS filters access for `authenticated`; `service_role`
-- has full access (and bypasses RLS); `anon` has ZERO access — the public QR flow
-- goes through service-role server routes, never the anon Postgres role.

-- authenticated: DML on all tables, RLS then decides row visibility.
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant usage, select on sequences to authenticated;

-- audit_log is append-only: clients may read (per policy) but never write it.
revoke insert, update, delete on audit_log from authenticated;

-- service_role: full access (used by trusted server routes; bypasses RLS).
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- anon: no table/sequence access whatsoever (the public QR flow uses service_role
-- server routes, never the anon role). We deliberately do NOT grant anon any table
-- privileges and define no anon policies, so every anon query is denied.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
