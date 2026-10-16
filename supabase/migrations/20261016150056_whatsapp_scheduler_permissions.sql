-- Best-effort restriction for environments whose migration role owns pg_net objects.
-- Hosted Supabase owns them as supabase_admin, whose grants postgres cannot revoke.
-- On that platform, net MUST remain outside the exposed Data API schemas. The worker
-- uses a dedicated bearer, never the broader billing/maintenance cron credential.
do $permissions$
begin
  if exists(select 1 from pg_namespace where nspname='net') then
    revoke all on schema net from public, anon, authenticated, service_role;
    revoke all on all tables in schema net from public, anon, authenticated, service_role;
    revoke all on all sequences in schema net from public, anon, authenticated, service_role;
    revoke execute on all functions in schema net from public, anon, authenticated, service_role;
  end if;
end
$permissions$;
