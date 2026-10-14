-- 20261013140000_storage_limits_and_trigger_grants.sql
-- Storage that refuses what the app never stores, and trigger functions anon cannot hold.
--
-- Every bucket was unlimited in size and type. Each upload path checks its own file (6 to
-- 8 MB; images, PDFs, voice), but the job card and work request routes took the file's type
-- from the browser and stored anything else as ".bin", and a signed-in session can upload to
-- the farm buckets directly under their policy. Each bucket now refuses a file larger than
-- the app's own limit (with some room) or of a type the app never stores. Objects already
-- stored are untouched. `menu-media` is left as it is: nothing in this repository writes it.
--
-- "farmgear objects update" had no WITH CHECK. Postgres then checks the updated row against
-- its USING expression, so this changes nothing; it is written out so the next reader does
-- not have to know that.
--
-- Nine trigger functions in `public` kept the default EXECUTE for PUBLIC, so anon held it.
-- A trigger function cannot be called directly and the privilege is checked only when a
-- trigger is created, so it was never reachable; it is revoked to keep anon's surface to what
-- is meant to be there (the same sweep as 20260921160000).
--
-- The storage part is a no-op on a local test Postgres, which has no `storage` schema.

do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    -- Photos: the app caps them at 6 MB after compressing in the browser.
    update storage.buckets
       set file_size_limit = 8388608, allowed_mime_types = array['image/*']
     where id in ('checklist-photos', 'fault-photos', 'machine-photos');
    -- A fault's voice note: 8 MB; some browsers record audio as video/webm.
    update storage.buckets
       set file_size_limit = 10485760, allowed_mime_types = array['audio/*', 'video/webm']
     where id = 'fault-voice';
    -- Job card and work request photos, quotes and invoices; partner documents and
    -- receipts; machine documents: 8 MB, images or PDF.
    update storage.buckets
       set file_size_limit = 10485760, allowed_mime_types = array['image/*', 'application/pdf']
     where id in ('jobcard-photos', 'partner-docs', 'partner-receipts', 'machine-docs');
    -- A partner's logo: the settings form refuses more than 2 000 000 bytes.
    update storage.buckets
       set file_size_limit = 2097152,
           allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
     where id = 'partner-branding';

    execute $p$
      alter policy "farmgear objects update" on storage.objects
        with check (
          (bucket_id = any (array['machine-photos', 'machine-docs', 'fault-photos', 'fault-voice',
                                  'jobcard-photos', 'checklist-photos', 'partner-docs']))
          and app.storage_object_visible(bucket_id, name)
        )
    $p$;
  end if;
end $$;

revoke execute on function public.app_cost_from_stock_movement()          from public, anon;
revoke execute on function public.app_expense_vat_claimable_guard()       from public, anon;
revoke execute on function public.app_purchase_order_rollup()             from public, anon;
revoke execute on function public.app_purchase_order_status()             from public, anon;
revoke execute on function public.app_purchase_order_status_from_lines()  from public, anon;
revoke execute on function public.app_purchase_order_totals()             from public, anon;
revoke execute on function public.app_resolve_supplier()                  from public, anon;
revoke execute on function public.app_stock_rollup()                      from public, anon;
revoke execute on function public.app_workshops_check_layout()            from public, anon;
