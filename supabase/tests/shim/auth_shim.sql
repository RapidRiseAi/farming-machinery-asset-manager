-- auth_shim.sql — LOCAL TEST ONLY. Do NOT apply against Supabase.
--
-- Recreates the minimal pieces of a Supabase database that our migrations depend on:
--   * the anon / authenticated / service_role / authenticator roles
--   * the auth schema with a users table and the auth.uid()/role()/jwt() helpers
-- On a real Supabase project these already exist and are managed by the platform.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'postgres';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Reads the JWT claims that PostgREST/Supabase would set per request.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'anon');
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;
