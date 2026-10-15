-- WhatsApp is a transport for an existing person, never an alternative role system.
-- Private delivery/challenge rows are service-only. Browser mutations use narrow RPCs.
create table public.whatsapp_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  farm_id uuid not null references public.farms(id),
  phone text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  notifications_enabled boolean not null default false,
  assistant_enabled boolean not null default false,
  consent_version text not null default '2026-10-06',
  linked_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  assistant_until timestamptz not null default now() + interval '12 hours',
  revoked_at timestamptz,
  conversation jsonb,
  conversation_at timestamptz,
  conversation_authority_tag text,
  lease_id uuid,
  lease_until timestamptz
);
create unique index whatsapp_phone_active on public.whatsapp_links(phone) where revoked_at is null;
create unique index whatsapp_user_active on public.whatsapp_links(user_id) where revoked_at is null;

create table public.whatsapp_link_challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  farm_id uuid not null references public.farms(id),
  phone text not null check (phone ~ '^[1-9][0-9]{7,14}$'),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  notifications_enabled boolean not null,
  assistant_enabled boolean not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  verified_at timestamptz,
  consumed_at timestamptz
);
create index whatsapp_challenge_user on public.whatsapp_link_challenges(user_id, created_at);

-- Keep the existing test-account boundary on this new person/farm relationship too.
create trigger whatsapp_links_test_fence before insert or update on public.whatsapp_links
  for each row execute function app.fence_user_farm();
create trigger whatsapp_challenges_test_fence before insert or update on public.whatsapp_link_challenges
  for each row execute function app.fence_user_farm();

create table public.whatsapp_inbox (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null unique,
  link_id uuid not null references public.whatsapp_links(id),
  message_text text not null check (length(message_text) <= 2000),
  message_at timestamptz not null,
  created_at timestamptz not null default now(),
  state text not null default 'queued' check (state in ('queued','processing','ready','sending','sent','failed','cancelled')),
  lease_id uuid,
  reply text,
  provider_reply_id text,
  delivery_status text,
  error_code text
);
create index whatsapp_inbox_queue on public.whatsapp_inbox(created_at) where state in ('queued','processing','ready');

create table public.whatsapp_notification_delivery (
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  link_id uuid not null references public.whatsapp_links(id),
  state text not null default 'queued' check (state in ('queued','sending','sent','failed','cancelled')),
  provider_id text,
  delivery_status text,
  error_code text,
  created_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['whatsapp_links','whatsapp_link_challenges','whatsapp_inbox','whatsapp_notification_delivery'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;

-- No primary-farm fallback after an explicit membership has been revoked.
create function app.whatsapp_member(p_user uuid, p_farm uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.users u join public.farms f on f.id = p_farm
    where u.id=p_user and u.active and u.deleted_at is null
      and u.role in ('owner','manager','mechanic','operator')
      and f.deleted_at is null and f.status in ('active','trial')
      and u.is_test = f.is_test
      and app.has_entitlement(p_farm, 'whatsapp')
      and (exists(select 1 from public.user_farm_memberships m where m.user_id=u.id
             and m.farm_id=p_farm and m.active and m.deleted_at is null)
        or (u.farm_id=p_farm and not exists(select 1 from public.user_farm_memberships m
             where m.user_id=u.id and m.farm_id=p_farm)))
  );
$$;
revoke all on function app.whatsapp_member(uuid,uuid) from public, anon, authenticated;
grant execute on function app.whatsapp_member(uuid,uuid) to service_role;

-- The custom JWT is a short-lived user credential, narrowed further by a live link.
-- Normal app tokens are unaffected. Revocation is checked inside DB reads and writes.
create function app.whatsapp_scope(p_farm uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when auth.jwt()->>'fw_channel' is distinct from 'whatsapp' then true else
    exists(select 1 from public.whatsapp_links l
      where l.id::text=auth.jwt()->>'fw_link_id' and l.user_id=auth.uid()
        and l.farm_id=p_farm and l.farm_id::text=auth.jwt()->>'fw_farm_id'
        and l.revoked_at is null and l.expires_at>now()
        and l.assistant_enabled and l.assistant_until>now()
        and app.whatsapp_member(l.user_id,l.farm_id)) end;
$$;
revoke all on function app.whatsapp_scope(uuid) from public, anon;
grant execute on function app.whatsapp_scope(uuid) to authenticated, service_role;

-- Legacy masked views use this helper under their owner's privileges. Apply the
-- same narrowing there as on the underlying tables, without changing web access.
create or replace function app.has_farm_access(fid uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.whatsapp_scope(fid) and (
    app.is_rr_admin()
    or exists(select 1 from public.users u where u.id=auth.uid() and u.active and u.deleted_at is null and u.farm_id=fid)
    or exists(select 1 from public.user_farm_memberships m
      join public.users u on u.id=auth.uid() and u.active and u.deleted_at is null
      where m.user_id=auth.uid() and m.farm_id=fid and m.active and m.deleted_at is null)
    or exists(select 1 from public.workshop_links wl
      join public.users u on u.id=auth.uid() and u.active and u.deleted_at is null
      where wl.farm_id=fid and wl.workshop_id=u.workshop_id and wl.status='active' and wl.deleted_at is null)
  );
$$;

-- Defense in depth for every existing farm-bearing table, including AI proposals.
-- A restrictive policy can narrow an existing permissive policy, never grant access.
do $$ declare t record; v_command text; begin
  for t in select c.table_name from information_schema.columns c
    join pg_tables p on p.schemaname=c.table_schema and p.tablename=c.table_name
    where c.table_schema='public' and c.column_name='farm_id' and p.rowsecurity and c.table_name<>'users'
  loop
    execute format('create policy whatsapp_scope_sel on public.%I as restrictive for select to authenticated using (app.whatsapp_scope(farm_id))',t.table_name);
    -- Do not introduce even restrictive write policies on read-only engine tables.
    foreach v_command in array array['INSERT','UPDATE','DELETE'] loop
      if exists(select 1 from pg_policies p where p.schemaname='public' and p.tablename=t.table_name
        and p.permissive='PERMISSIVE' and p.cmd in ('ALL',v_command)
        and (p.roles && array['public','authenticated']::name[])) then
        execute format('create policy %I on public.%I as restrictive for %s to authenticated %s %s',
          'whatsapp_scope_'||lower(v_command),t.table_name,v_command,
          case when v_command<>'INSERT' then 'using(app.whatsapp_scope(farm_id))' else '' end,
          case when v_command<>'DELETE' then 'with check(app.whatsapp_scope(farm_id))' else '' end);
      end if;
    end loop;
  end loop;
end $$;
create policy whatsapp_scope on public.farms as restrictive for all to authenticated
  using(app.whatsapp_scope(id)) with check(app.whatsapp_scope(id));
create policy whatsapp_scope on public.users as restrictive for all to authenticated
  using(auth.jwt()->>'fw_channel' is distinct from 'whatsapp'
    or (id=auth.uid() and app.whatsapp_scope((auth.jwt()->>'fw_farm_id')::uuid)))
  with check(auth.jwt()->>'fw_channel' is distinct from 'whatsapp');

create function public.whatsapp_begin_link(p_farm uuid,p_phone text,p_hash text,p_notifications boolean,p_assistant boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.jwt()->>'fw_channel'='whatsapp' or not app.whatsapp_member(auth.uid(),p_farm)
    or not (p_notifications or p_assistant) then raise exception 'Forbidden' using errcode='42501'; end if;
  -- Serializes rate limits and challenge replacement for this person.
  perform 1 from public.users where id=auth.uid() for update;
  if (select count(*) from public.whatsapp_link_challenges where user_id=auth.uid()
       and created_at>now()-interval '1 hour') >= 5 then
    raise exception 'Link rate limit' using errcode='P0001';
  end if;
  update public.whatsapp_link_challenges set consumed_at=now() where user_id=auth.uid() and consumed_at is null;
  insert into public.whatsapp_link_challenges(user_id,farm_id,phone,token_hash,notifications_enabled,assistant_enabled)
    values(auth.uid(),p_farm,p_phone,p_hash,p_notifications,p_assistant) returning id into v_id;
  return v_id;
end $$;

create function public.whatsapp_verify_link(p_hash text,p_phone text) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  update public.whatsapp_link_challenges set verified_at=coalesce(verified_at,now())
    where token_hash=p_hash and phone=p_phone and expires_at>now() and consumed_at is null;
  return found;
end $$;

create function public.whatsapp_finish_link(p_challenge uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare c public.whatsapp_link_challenges%rowtype; v_id uuid;
begin
  if auth.jwt()->>'fw_channel'='whatsapp' then raise exception 'Forbidden' using errcode='42501'; end if;
  perform 1 from public.users where id=auth.uid() for update;
  select * into c from public.whatsapp_link_challenges where id=p_challenge and user_id=auth.uid() for update;
  if not found or c.consumed_at is not null or c.expires_at<=now() or c.verified_at is null
     or not app.whatsapp_member(auth.uid(),c.farm_id) then
    raise exception 'Link not verified or expired' using errcode='42501';
  end if;
  -- A number cannot be silently stolen from another account, even after expiry.
  if exists(select 1 from public.whatsapp_links where phone=c.phone and user_id<>auth.uid() and revoked_at is null) then
    raise exception 'Number unavailable' using errcode='23505';
  end if;
  update public.whatsapp_links set revoked_at=now(),conversation=null where user_id=auth.uid() and revoked_at is null;
  insert into public.whatsapp_links(user_id,farm_id,phone,notifications_enabled,assistant_enabled)
    values(c.user_id,c.farm_id,c.phone,c.notifications_enabled,c.assistant_enabled) returning id into v_id;
  update public.whatsapp_link_challenges set consumed_at=now() where id=c.id;
  return v_id;
end $$;

create function public.whatsapp_manage_link(p_action text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.jwt()->>'fw_channel'='whatsapp' or auth.uid() is null then
    raise exception 'Forbidden' using errcode='42501'; end if;
  if p_action='disconnect' then
    update public.whatsapp_links set revoked_at=now(),conversation=null where user_id=auth.uid() and revoked_at is null;
    update public.whatsapp_link_challenges set consumed_at=now() where user_id=auth.uid() and consumed_at is null;
  elsif p_action='authorize' then
    update public.whatsapp_links set assistant_until=now()+interval '12 hours',conversation=null
      where user_id=auth.uid() and revoked_at is null and expires_at>now() and assistant_enabled
        and app.whatsapp_member(user_id,farm_id);
    if not found then raise exception 'Connection expired or unavailable' using errcode='42501'; end if;
  else raise exception 'Invalid action' using errcode='22023'; end if;
end $$;

create function public.whatsapp_link_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',l.id,'farmId',l.farm_id,'farmName',(select name from public.farms where id=l.farm_id),'phone',l.phone,
    'notifications',l.notifications_enabled,'assistant',l.assistant_enabled,
    'expiresAt',l.expires_at,'assistantUntil',l.assistant_until)
  from public.whatsapp_links l where user_id=auth.uid() and revoked_at is null
    and auth.jwt()->>'fw_channel' is distinct from 'whatsapp';
$$;

-- Receives only data from a verified Meta signature. No caller-supplied account IDs.
create function public.whatsapp_receive(p_provider_id text,p_phone text,p_text text,p_at timestamptz)
returns void language plpgsql security invoker set search_path = '' as $$
declare l public.whatsapp_links%rowtype;
begin
  select * into l from public.whatsapp_links where phone=p_phone and revoked_at is null for update;
  if not found then return; end if;
  if upper(trim(p_text)) in ('STOP','UNSUBSCRIBE','CANCEL','STOP ALL') then
    update public.whatsapp_links set revoked_at=now(),conversation=null where id=l.id;
    return;
  end if;
  if l.expires_at<=now() or not app.whatsapp_member(l.user_id,l.farm_id)
     or p_at<l.linked_at or p_at<now()-interval '24 hours' or p_at>now()+interval '5 minutes' then return; end if;
  if (select count(*) from public.whatsapp_inbox where link_id=l.id and created_at>now()-interval '1 minute')>=12 then return; end if;
  insert into public.whatsapp_inbox(provider_id,link_id,message_text,message_at)
    values(p_provider_id,l.id,p_text,p_at) on conflict(provider_id) do nothing;
end $$;

-- One worker per linked conversation; message content is durable before HTTP 200.
create function public.whatsapp_claim(p_lease uuid) returns setof public.whatsapp_inbox
language plpgsql security invoker set search_path = '' as $$
declare l public.whatsapp_links%rowtype; v_id uuid;
begin
  select x.* into l from public.whatsapp_links x where x.revoked_at is null
    and (x.lease_until is null or x.lease_until<now())
    and exists(select 1 from public.whatsapp_inbox i where i.link_id=x.id and i.state in ('queued','processing','ready'))
    order by x.linked_at for update skip locked limit 1;
  if not found then return; end if;
  select id into v_id from public.whatsapp_inbox where link_id=l.id and state in ('queued','processing','ready')
    order by message_at,created_at,id limit 1 for update;
  update public.whatsapp_links set lease_id=p_lease,lease_until=now()+interval '5 minutes' where id=l.id;
  return query update public.whatsapp_inbox set lease_id=p_lease,
    state=case when reply is null then 'processing' else 'ready' end where id=v_id returning *;
end $$;

create function public.whatsapp_save_reply(p_id uuid,p_lease uuid,p_reply text,p_conversation jsonb,p_authority_tag text) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare v_link uuid;
begin
  update public.whatsapp_inbox i set reply=p_reply,state='ready'
    where i.id=p_id and i.lease_id=p_lease and i.state='processing'
      and exists(select 1 from public.whatsapp_links l where l.id=i.link_id and l.lease_id=p_lease
        and l.lease_until>now() and l.revoked_at is null)
    returning link_id into v_link;
  if not found then return false; end if;
  update public.whatsapp_links set conversation=p_conversation,conversation_at=now(),
    conversation_authority_tag=p_authority_tag where id=v_link;
  return true;
end $$;

-- Generic notifications deliberately contain no farm names, record data or costs.
-- Only events created after consent are eligible; no historical notification blast.
create function public.whatsapp_enqueue_notifications() returns void
language sql security invoker set search_path = '' as $$
  insert into public.whatsapp_notification_delivery(notification_id,link_id)
  select n.id,l.id from public.notifications n join public.whatsapp_links l
    on l.user_id=n.user_id and l.farm_id=n.farm_id
  join public.users u on u.id=l.user_id join public.farms f on f.id=l.farm_id
  where l.revoked_at is null and l.notifications_enabled and l.expires_at>now()
    and app.whatsapp_member(l.user_id,l.farm_id)
    and n.created_at>=l.linked_at and n.created_at>now()-interval '1 day'
    and n.deleted_at is null and (n.deliver_after is null or n.deliver_after<=now())
    and (app.user_deliver_after(u.quiet_hours_start,u.quiet_hours_end,app.quiet_deliver_after(f.settings)) is null
      or app.user_deliver_after(u.quiet_hours_start,u.quiet_hours_end,app.quiet_deliver_after(f.settings))<=now())
    and n.channel='inapp'
    and not exists(select 1 from public.whatsapp_notification_delivery d where d.notification_id=n.id)
  order by n.created_at limit 100
  on conflict(notification_id) do nothing;
$$;

-- Employee task assignment in the current product is a job card's mechanic assignment.
create function app.whatsapp_job_assigned() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.mechanic_user_id is null or new.deleted_at is not null then return new; end if;
  if TG_OP='UPDATE' and new.mechanic_user_id is not distinct from old.mechanic_user_id then return new; end if;
  if exists(select 1 from public.users where id=new.mechanic_user_id and active and deleted_at is null) then
    insert into public.notifications(farm_id,user_id,channel,template,payload)
      values(new.farm_id,new.mechanic_user_id,'inapp','job_assigned',
        jsonb_build_object('job_card_id',new.id,'machine_id',new.machine_id));
  end if;
  return new;
end $$;
create trigger whatsapp_job_assignment after insert or update of mechanic_user_id on public.job_cards
  for each row execute function app.whatsapp_job_assigned();
revoke all on function app.whatsapp_job_assigned() from public,anon,authenticated;

create function app.whatsapp_fault_assigned() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.assigned_to is null or new.deleted_at is not null then return new; end if;
  if TG_OP='UPDATE' and new.assigned_to is not distinct from old.assigned_to then return new; end if;
  if exists(select 1 from public.users where id=new.assigned_to and active and deleted_at is null) then
    insert into public.notifications(farm_id,user_id,channel,template,payload)
      values(new.farm_id,new.assigned_to,'inapp','fault_assigned',
        jsonb_build_object('fault_id',new.id,'machine_id',new.machine_id));
  end if;
  return new;
end $$;
create trigger whatsapp_fault_assignment after insert or update of assigned_to on public.faults
  for each row execute function app.whatsapp_fault_assigned();
revoke all on function app.whatsapp_fault_assigned() from public,anon,authenticated;

-- WhatsApp opt-in does not depend on the in-app toggle. Preserve existing recipients.
create or replace function app.notify_farm(p_farm uuid,p_template text,p_payload jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.notifications(farm_id,user_id,channel,template,payload,status)
  select p_farm,u.id,'inapp',p_template,p_payload,'queued' from public.users u
  where u.farm_id=p_farm and u.role in ('owner','manager') and u.active and u.deleted_at is null
    and (u.notify_inapp or exists(select 1 from public.whatsapp_links l where l.user_id=u.id
      and l.farm_id=p_farm and l.notifications_enabled and l.revoked_at is null and l.expires_at>now()));
end $$;
create or replace function app.notify_farm(p_farm uuid,p_template text,p_payload jsonb,p_deliver_after timestamptz) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.notifications(farm_id,user_id,channel,template,payload,status,deliver_after)
  select p_farm,u.id,'inapp',p_template,p_payload,'queued',app.user_deliver_after(u.quiet_hours_start,u.quiet_hours_end,p_deliver_after)
  from public.users u where u.farm_id=p_farm and u.role in ('owner','manager') and u.active and u.deleted_at is null
    and (u.notify_inapp or exists(select 1 from public.whatsapp_links l where l.user_id=u.id
      and l.farm_id=p_farm and l.notifications_enabled and l.revoked_at is null and l.expires_at>now()));
end $$;

-- Fail closed for privileged confirmation RPCs too (SECURITY DEFINER bypasses RLS).
-- The existing function already checks effective_farm_role on every proposal.
create or replace function app.effective_farm_role(p_user uuid,p_farm uuid) returns public.user_role
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_user public.users%rowtype; v_role public.user_role;
begin
  if p_user is null or p_farm is null or auth.uid() is distinct from p_user
     or not app.whatsapp_scope(p_farm) then return null; end if;
  select * into v_user from public.users where id=p_user and active and deleted_at is null;
  if not found then return null; end if;
  if v_user.role='rr_admin' then
    return case when app.rr_admin_unlocked() then 'rr_admin'::public.user_role end;
  end if;
  if v_user.role='workshop' then return null; end if;
  select m.role into v_role from public.user_farm_memberships m where m.user_id=p_user
    and m.farm_id=p_farm and m.active and m.deleted_at is null;
  if v_role is not null then return v_role; end if;
  if v_user.farm_id=p_farm and v_user.role in ('owner','manager','mechanic','operator') then return v_user.role; end if;
  return null;
end $$;

create function public.whatsapp_delivery_target(p_link uuid) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select to_jsonb(l) || jsonb_build_object('authority_tag',md5(jsonb_build_object(
    'user',jsonb_build_array(u.role,u.active,u.deleted_at,u.ai_processing_opt_in,u.ai_processing_withdrawn_at),
    'farm',jsonb_build_array(f.plan,f.status,f.settings,f.deleted_at),
    'assistant',l.assistant_enabled and l.assistant_until>now(),
    'memberships',(select jsonb_agg(to_jsonb(m) order by m.id) from public.user_farm_memberships m where m.user_id=l.user_id and m.farm_id=l.farm_id),
    'grants',(select jsonb_agg(to_jsonb(g) order by g.id) from public.user_permission_grants g where g.user_id=l.user_id and g.farm_id=l.farm_id),
    'machines',(select jsonb_agg(jsonb_build_array(m.id,m.assigned_operator_id,m.deleted_at) order by m.id) from public.machines m where m.farm_id=l.farm_id)
  )::text)) from public.whatsapp_links l
    join public.users u on u.id=l.user_id join public.farms f on f.id=l.farm_id
  where l.id=p_link and l.revoked_at is null and l.expires_at>now() and app.whatsapp_member(l.user_id,l.farm_id);
$$;

-- Check the live WhatsApp grant BEFORE the existing idempotent replay can return
-- a previously saved result. Keep the web signature and result contract intact.
create or replace function public.apply_assistant_proposal(p_proposal_id uuid,p_action text,p_expected_farm uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, app, pg_temp as $$
declare v_user uuid:=auth.uid(); v_proposal_farm uuid;
begin
  if v_user is null then raise exception 'Authentication is required.' using errcode='42501'; end if;
  if p_proposal_id is null or p_action is null or p_expected_farm is null or p_action not in ('confirm','reject') then
    return jsonb_build_object('ok',false,'code','bad_request','message','A proposal ID, selected farm, and confirm/reject action are required.');
  end if;
  if auth.jwt()->>'fw_channel'='whatsapp' then
    perform 1 from public.whatsapp_links where id::text=auth.jwt()->>'fw_link_id' and user_id=v_user for update;
    if not found or not app.whatsapp_scope(p_expected_farm) then
      raise exception 'WhatsApp authorization expired.' using errcode='42501';
    end if;
  end if;
  select i.farm_id into v_proposal_farm from public.ai_interactions i
    where i.id=p_proposal_id and i.user_id=v_user and i.deleted_at is null for update;
  if not found then raise exception 'Proposal not found.' using errcode='42501'; end if;
  if v_proposal_farm is distinct from p_expected_farm then
    return jsonb_build_object('ok',false,'code','farm_context_changed','message','The selected farm changed after this proposal was prepared.');
  end if;
  return public.apply_assistant_proposal_internal(p_proposal_id,p_action);
end $$;

-- Transport text is short-lived. Operational records and the existing AI ledger retain
-- their own established retention; deduplication markers remain without message text.
create function public.whatsapp_prune() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.whatsapp_inbox set message_text='',reply=null
    where created_at<now()-interval '30 days' and (message_text<>'' or reply is not null);
  update public.whatsapp_links set conversation=null,conversation_at=null
    where conversation_at<now()-interval '15 minutes' or revoked_at is not null;
  delete from public.whatsapp_link_challenges where created_at<now()-interval '1 day';
end $$;

create function public.whatsapp_assistant_role(p_farm uuid) returns public.user_role
language sql stable security invoker set search_path = '' as $$
  select app.effective_farm_role(auth.uid(),p_farm)
  where auth.jwt()->>'fw_channel'='whatsapp' and app.whatsapp_scope(p_farm)
    and app.has_entitlement(p_farm,'voice_ai');
$$;

-- Explicit grants: PostgreSQL grants EXECUTE to PUBLIC by default.
do $$ declare p record; begin
  for p in select proc.oid::regprocedure as signature,proc.proname from pg_proc proc
    join pg_namespace n on n.oid=proc.pronamespace where n.nspname='public' and proc.proname like 'whatsapp_%'
  loop
    execute format('revoke all on function %s from public,anon,authenticated',p.signature);
    if p.proname in ('whatsapp_begin_link','whatsapp_finish_link','whatsapp_manage_link','whatsapp_link_status','whatsapp_assistant_role') then
      execute format('grant execute on function %s to authenticated',p.signature);
    else execute format('grant execute on function %s to service_role',p.signature);
    end if;
  end loop;
end $$;
