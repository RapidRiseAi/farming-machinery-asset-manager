-- The file is uploaded first; its receipt and optional supplier cost commit together.
-- Reusing a capture ID after a lost response cannot create a second invoice cost.
create or replace function public.record_job_card_media(
  p_job uuid, p_capture uuid, p_kind text, p_storage_path text,
  p_amount bigint default null, p_note text default null
) returns uuid language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_farm uuid; v_machine uuid; v_workshop uuid; v_mode text; v_status job_card_status;
  v_locked boolean; v_bps integer; v_date date; v_role user_role;
  v_linked boolean;
  v_existing attachments%rowtype; v_cost cost_entries%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in to attach work records.' using errcode = '42501'; end if;
  select farm_id,machine_id,workshop_id,work_mode,status,locked,vat_rate_bps,date_out
    into v_farm,v_machine,v_workshop,v_mode,v_status,v_locked,v_bps,v_date
    from public.job_cards where id = p_job and deleted_at is null for update;
  if not found then raise exception 'Job card not found.' using errcode = 'P0002'; end if;
  v_role := app.effective_farm_role(auth.uid(),v_farm);
  if p_capture is null or p_kind not in ('photo','quote','invoice') or p_kind is null
    or p_storage_path is null or p_storage_path not like v_farm::text || '/' || p_job::text || '/' || p_kind || '-' || p_capture::text || '.%'
    or p_storage_path ~ '\.\.' then
    raise exception 'Invalid attachment.' using errcode = '22023';
  end if;
  if p_amount is not null and (p_kind <> 'invoice' or p_amount < 0) then
    raise exception 'Invalid invoice amount.' using errcode = '22023';
  end if;
  if v_mode = 'internal' and p_kind <> 'photo' then
    raise exception 'Internal work records costs, not supplier invoices.' using errcode = '23514';
  end if;
  if not app.job_card_worker(auth.uid(),p_job)
    and not (p_kind in ('invoice','quote') and v_mode = 'external' and v_role in ('owner','manager')) then
    raise exception 'Only the assigned team or receiving farm may attach these records.' using errcode = '42501';
  end if;
  if p_kind <> 'invoice' and (v_locked or v_status in ('completed','approved')) then
    raise exception 'The work record is complete.' using errcode = '23514';
  end if;
  if p_kind = 'invoice' and v_status not in ('completed','approved') then
    raise exception 'Complete the work before recording its supplier invoice.' using errcode = '23514';
  end if;
  if p_kind = 'invoice' then
    select exists(select 1 from public.work_requests where job_card_id=p_job and deleted_at is null) into v_linked;
    if not v_linked and p_amount is null and (v_workshop is null
      or (app.current_app_role()='workshop' and app.user_workshop_id()=v_workshop)) then
      raise exception 'Enter the supplier invoice amount, including zero for no-charge work.' using errcode='23514';
    end if;
  end if;
  if p_amount is not null then
    if v_workshop is not null and not (app.current_app_role() = 'workshop' and app.user_workshop_id() = v_workshop) then
      raise exception 'The assigned supplier records the invoice amount.' using errcode = '42501';
    end if;
    if v_linked then
      raise exception 'Record the invoice on the linked work request.' using errcode = '23514';
    end if;
  end if;

  select * into v_existing from public.attachments where id = p_capture;
  if found then
    if v_existing.parent_type <> 'job_card' or v_existing.parent_id <> p_job
      or v_existing.created_by is distinct from auth.uid() or v_existing.storage_path is distinct from p_storage_path
      or v_existing.deleted_at is not null
      or v_existing.kind::text <> (case when p_kind = 'quote' then 'doc' else p_kind end) then
      raise exception 'Capture ID already used.' using errcode = '23514';
    end if;
    if p_kind = 'invoice' then
      select * into v_cost from public.cost_entries where id = p_capture;
      if (p_amount is null and found) or (p_amount is not null and
        (not found or v_cost.amount_cents is distinct from p_amount or v_cost.note is distinct from nullif(btrim(p_note),''))) then
        raise exception 'Capture ID already used for different invoice details.' using errcode = '23514';
      end if;
    end if;
    return p_capture;
  end if;

  insert into public.attachments(id,farm_id,parent_type,parent_id,kind,storage_path,created_by)
    values(p_capture,v_farm,'job_card',p_job,
      (case when p_kind = 'quote' then 'doc' else p_kind end)::attachment_kind,p_storage_path,auth.uid());
  if p_amount is not null then
    insert into public.cost_entries(id,farm_id,machine_id,type,amount_cents,vat_rate_bps,source_type,source_id,occurred_on,note,created_by)
      values(p_capture,v_farm,v_machine,'invoice',p_amount,v_bps,'job_card',p_job,
        coalesce(v_date,current_date),nullif(btrim(p_note),''),auth.uid());
  end if;
  return p_capture;
end $$;
revoke execute on function public.record_job_card_media(uuid,uuid,text,text,bigint,text) from public,anon;
grant execute on function public.record_job_card_media(uuid,uuid,text,text,bigint,text) to authenticated;
