-- Managed Supabase infrastructure. Plain PostgreSQL/PGlite test environments do not
-- ship these optional extensions; the delivery route itself remains independently tested.
-- Provision the two named Vault secrets separately, then activate after the HTTP check.
do $install$
begin
  if not exists(select 1 from pg_available_extensions where name='pg_cron')
     or not exists(select 1 from pg_available_extensions where name='pg_net')
     or not exists(select 1 from pg_extension where extname='supabase_vault') then
    raise notice 'WhatsApp scheduler requires hosted pg_cron, pg_net and Vault; skipped';
    return;
  end if;

  create extension if not exists pg_cron;
  create extension if not exists pg_net;
  -- Only the database scheduler needs outbound HTTP or scheduling privileges.
  revoke all on schema cron, net from public, anon, authenticated, service_role;
  revoke execute on all functions in schema cron, net from public, anon, authenticated, service_role;

  perform cron.schedule('fleetwise-whatsapp-minute', '* * * * *', $job$
    select net.http_get(
      url := (select decrypted_secret from vault.decrypted_secrets where name='fleetwise_whatsapp_worker_url'),
      headers := jsonb_build_object('Authorization', 'Bearer ' ||
        (select decrypted_secret from vault.decrypted_secrets where name='fleetwise_whatsapp_worker_secret')),
      timeout_milliseconds := 65000
    ) where exists(select 1 from vault.decrypted_secrets where name='fleetwise_whatsapp_worker_secret')
      and exists(select 1 from vault.decrypted_secrets where name='fleetwise_whatsapp_worker_url');
  $job$);
  perform cron.alter_job((select jobid from cron.job where jobname='fleetwise-whatsapp-minute'), active := false);

  perform cron.schedule('fleetwise-whatsapp-cron-history', '15 2 * * *', $job$
    delete from cron.job_run_details where end_time < now()-interval '7 days'
      and jobid in (select jobid from cron.job where jobname in
        ('fleetwise-whatsapp-minute','fleetwise-whatsapp-cron-history'));
  $job$);
end
$install$;
