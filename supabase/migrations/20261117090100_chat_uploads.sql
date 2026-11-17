-- B2 extends B1's reservation and validation pipeline; no second quota ledger.
alter table public.upload_intents drop constraint upload_intents_target_kind_check;
alter table public.upload_intents add constraint upload_intents_target_kind_check check(target_kind in (
 'machine','fault','checklist_instance','job_card','work_request','trip_job','finance_agreement','asset_contract',
 'partner_document','partner_expense','billing_payment','assistant_command','chat_message'));
do $storage$ begin
if to_regclass('storage.buckets') is not null then
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
select id,id,false,bytes,mimes from (values
 ('chat-files',50000000::bigint, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf','audio/webm','audio/ogg','audio/mp4'])
) as spec(id,bytes,mimes)
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
end if;
end $storage$;
create or replace function app.upload_bucket_for(p_kind text, p_class text)
returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_kind = 'chat_message' and p_class in ('photo','pdf','voice') then 'chat-files'
    when p_kind = 'machine' and p_class = 'photo' then 'machine-photos'
    when p_kind = 'machine' and p_class = 'pdf' then 'machine-docs'
    when p_kind = 'fault' and p_class = 'photo' then 'fault-photos'
    when p_kind = 'fault' and p_class = 'voice' then 'fault-voice'
    when p_kind = 'checklist_instance' and p_class = 'photo' then 'checklist-photos'
    when p_kind in ('job_card', 'work_request') and p_class in ('photo', 'pdf') then 'jobcard-photos'
    when p_kind = 'trip_job' and p_class = 'photo' then 'jobcard-photos'
    when p_kind in ('finance_agreement', 'asset_contract') and p_class in ('photo', 'pdf') then 'finance-docs'
    when p_kind = 'partner_document' and p_class in ('photo', 'pdf') then 'partner-docs'
    when p_kind = 'partner_expense' and p_class in ('photo', 'pdf') then 'partner-receipts'
    when p_kind = 'billing_payment' and p_class in ('photo', 'pdf') then 'billing-proofs'
    when p_kind = 'assistant_command' and p_class = 'command_audio' then 'command-audio'
  end;
$$;

create or replace function app.upload_target_problem(
  p_kind text, p_target uuid, p_farm uuid, p_workshop uuid, p_pending_ok boolean
) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_farm uuid;
  v_found boolean := false;
begin
  if p_target is null then return 'target'; end if;
  case p_kind
    when 'machine' then
      select m.farm_id, true into v_farm, v_found from public.machines m where m.id = p_target and m.deleted_at is null;
    when 'fault' then
      select f.farm_id, true into v_farm, v_found from public.faults f where f.id = p_target and f.deleted_at is null;
    when 'checklist_instance' then
      select c.farm_id, true into v_farm, v_found from public.checklist_instances c where c.id = p_target;
    when 'chat_message' then
      if exists(select 1 from public.chat_messages m where m.id=p_target and m.farm_id=p_farm
        and m.sender_id=auth.uid() and m.published_at is null and app.chat_can_read(m.conversation_id)) then return null; end if;
      return 'target';
    when 'job_card' then
      select j.farm_id, true into v_farm, v_found from public.job_cards j where j.id = p_target and j.deleted_at is null;
    when 'work_request' then
      select w.farm_id, true into v_farm, v_found from public.work_requests w where w.id = p_target and w.deleted_at is null;
    when 'trip_job' then
      select t.farm_id, true into v_farm, v_found from public.trip_jobs t where t.id = p_target;
    when 'finance_agreement', 'asset_contract' then
      -- Owners and managers only (the finance-docs rule), before a byte is reserved.
      if not app.can_view_farm_finance(p_farm) or not app.finance_parent_ok(p_kind, p_target, p_farm) then
        return 'target';
      end if;
      return null;
    when 'partner_document' then
      select d.farm_id, true into v_farm, v_found from public.partner_documents d where d.id = p_target;
    when 'partner_expense' then
      if exists (select 1 from public.partner_expenses e where e.id = p_target and e.workshop_id is distinct from p_workshop) then
        return 'target';
      end if;
      return null;  -- a receipt may be chosen before its expense is saved
    when 'billing_payment' then
      return null;  -- Rapid Rise only (checked by the caller); the invoice is checked by the action
    when 'assistant_command' then
      return null;  -- the command's job is created when its audio is committed
    else
      return 'target';
  end case;
  if v_found then
    return case when v_farm = p_farm then null else 'target' end;
  end if;
  if p_pending_ok and p_kind in ('machine', 'checklist_instance', 'partner_document') then
    -- Not created yet: the id must not be in use anywhere, deleted rows included.
    if p_kind = 'machine' and exists (select 1 from public.machines m where m.id = p_target) then return 'target'; end if;
    return null;
  end if;
  return 'target';
end $$;

create or replace function public.upload_commit(p_intent uuid, p_attachment_kind text default null, p_record uuid default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  i public.upload_intents;
  v_kind text;
  v_parent text;
begin
  if auth.uid() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into i from public.upload_intents where id = p_intent for update;
  if not found or i.user_id <> auth.uid() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if i.status = 'finalised' then
    return jsonb_build_object('status', 'finalised', 'record_id', i.record_id, 'reused', true);
  end if;
  if i.status <> 'uploaded' then
    raise exception 'upload:%', case i.status when 'failed' then coalesce(i.failure, 'failed') when 'expired' then 'expired' else 'not_uploaded' end
      using errcode = 'P0001';
  end if;

  if i.farm_id is not null then
    if not app.has_farm_access(i.farm_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    perform app.require_open_farm(i.farm_id, true);
  elsif app.user_workshop_id() is distinct from i.workshop_id then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if i.target_kind = 'billing_payment' and not app.is_rr_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if app.upload_target_problem(i.target_kind, i.target_id, i.farm_id, i.workshop_id,
       i.target_kind in ('partner_expense', 'partner_document', 'billing_payment', 'assistant_command')) is not null then
    raise exception 'upload:target' using errcode = 'P0001';
  end if;

  if i.target_kind = 'chat_message' then
    perform app.chat_lock((select conversation_id from public.chat_messages where id=i.target_id));
    if exists(select 1 from public.chat_messages where id=i.target_id and published_at is not null) then
      raise exception 'upload:target'; end if;
    if (select count(*) from public.chat_attachments where message_id=i.target_id) >= 10 then raise exception 'upload:too_many'; end if;
    insert into public.chat_attachments(id,farm_id,message_id,storage_path,media_class,mime,bytes)
      values(i.id,i.farm_id,i.target_id,i.object_path,i.media_class,i.actual_mime,i.actual_bytes)
      on conflict(id) do nothing;
    p_record := i.id;
  end if;
  -- Records whose file is an ordinary attachment are written here, with the intent's id.
  if i.target_kind in ('machine', 'fault', 'checklist_instance', 'work_request', 'finance_agreement', 'asset_contract') then
    -- The same per-record rule Storage applies to reads (app.storage_object_visible: a
    -- contractor reaches only the files of records shared with them), judged on the
    -- intent's own record rather than by parsing the path, and the finance rule.
    if not app.upload_record_visible(i.target_kind, i.target_id, i.farm_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if i.target_kind in ('finance_agreement', 'asset_contract') and not app.can_view_farm_finance(i.farm_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    v_kind := coalesce(p_attachment_kind, case i.media_class when 'photo' then 'photo' when 'voice' then 'voice' else 'doc' end);
    if v_kind not in ('photo', 'voice', 'doc', 'invoice')
       or (i.media_class = 'voice') <> (v_kind = 'voice')
       or (i.media_class = 'pdf' and v_kind = 'photo') then
      raise exception 'upload:target' using errcode = 'P0001';
    end if;
    v_parent := i.target_kind;
    insert into public.attachments (id, farm_id, parent_type, parent_id, kind, storage_path, created_by)
    values (i.id, i.farm_id, v_parent, i.target_id, v_kind::attachment_kind, i.object_path, i.user_id)
    on conflict (id) do nothing;
    p_record := i.id;
  end if;

  update public.upload_intents
     set status = 'finalised', finalised_at = now(), record_id = coalesce(p_record, record_id)
   where id = i.id;
  return jsonb_build_object('status', 'finalised', 'record_id', coalesce(p_record, i.record_id), 'reused', false);
end $$;
create or replace function app.chat_file_readable(p_path text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
  select exists(select 1 from public.chat_attachments a join public.chat_messages m on m.id=a.message_id
    where a.storage_path=p_path and m.deleted_at is null and app.chat_message_readable(m.id));
$$;
revoke all on function app.chat_file_readable(text) from public,anon,authenticated,service_role;
grant execute on function app.chat_file_readable(text) to authenticated;
-- Restrictive as well as permissive: no existing general Storage policy may widen chat access.
do $storage$ begin
if to_regclass('storage.objects') is null then return; end if;
create policy chat_files_select on storage.objects for select to authenticated
  using(bucket_id='chat-files' and app.chat_file_readable(name));
create policy chat_files_private on storage.objects as restrictive for select to authenticated
  using(bucket_id<>'chat-files' or app.chat_file_readable(name));
create policy chat_files_no_insert on storage.objects as restrictive for insert to authenticated with check(bucket_id<>'chat-files');
create policy chat_files_no_update on storage.objects as restrictive for update to authenticated
  using(bucket_id<>'chat-files') with check(bucket_id<>'chat-files');
create policy chat_files_no_delete on storage.objects as restrictive for delete to authenticated using(bucket_id<>'chat-files');
end $storage$;
