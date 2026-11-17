-- B2: private staff conversations. Job/partner discussions stay in work_request_events.
-- Uses the existing readiness, account gate, notifications and upload quota hooks.
-- Never puts message text, titles or membership into the farm-wide audit log.
insert into public.feature_flags(key, note) values
  ('general_chat', 'Staff chat: disabled until manager browser and live Realtime checks pass.')
on conflict (key) do nothing;

create table public.chat_conversations (
  id uuid primary key,
  farm_id uuid not null references public.farms(id),
  kind text not null check (kind in ('direct', 'group')),
  title text not null check (char_length(title) between 1 and 120),
  created_by uuid not null references public.users(id),
  direct_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id, farm_id), unique(farm_id, direct_key),
  check ((kind = 'direct') = (direct_key is not null))
);
create table public.chat_members (
  conversation_id uuid not null,
  farm_id uuid not null,
  user_id uuid not null references public.users(id),
  is_admin boolean not null default false,
  visible_after bigint not null default 0,
  last_read bigint not null default 0,
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key(conversation_id, user_id),
  foreign key(conversation_id, farm_id) references public.chat_conversations(id, farm_id)
);
create index chat_members_person on public.chat_members(user_id, farm_id) where removed_at is null;
create trigger chat_members_fence before insert or update on public.chat_members
  for each row execute function app.fence_user_farm();

create table public.chat_messages (
  id uuid primary key,
  farm_id uuid not null,
  conversation_id uuid not null,
  sender_id uuid not null references public.users(id),
  sequence bigint generated always as identity unique,
  body text not null default '' check (char_length(body) <= 8000),
  published_at timestamptz,
  edited_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  unique(id, farm_id),
  foreign key(conversation_id, farm_id) references public.chat_conversations(id, farm_id)
);
create index chat_messages_page on public.chat_messages(conversation_id, sequence desc);
create table public.chat_attachments (
  id uuid primary key references public.upload_intents(id),
  farm_id uuid not null,
  message_id uuid not null,
  storage_path text not null unique,
  media_class text not null check (media_class in ('photo', 'pdf', 'voice')),
  mime text not null,
  bytes bigint not null,
  foreign key(message_id, farm_id) references public.chat_messages(id, farm_id)
);
create index chat_attachments_message on public.chat_attachments(message_id);
create table public.chat_events (
  id bigint generated always as identity primary key,
  farm_id uuid not null,
  conversation_id uuid not null,
  actor_id uuid not null references public.users(id),
  event text not null,
  record_id uuid,
  created_at timestamptz not null default now(),
  foreign key(conversation_id, farm_id) references public.chat_conversations(id, farm_id)
);
comment on table public.chat_events is
  'Append-only private audit evidence: actor, action, record and time, never message text. Read only by conversation members or an active audited support visit.';

create or replace function app.chat_ready(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.feature_flags f where f.key = 'general_chat'
    and (f.released or exists(select 1 from public.farm_feature_access a
                              where a.farm_id = p_farm and a.key = f.key)));
$$;
create or replace function app.chat_staff(p_user uuid, p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.users u join public.farms f on f.id=p_farm
    where u.id=p_user and u.active and u.deleted_at is null and f.deleted_at is null
      and u.is_test=f.is_test and u.role in ('owner','manager','mechanic','operator')
      and (exists(select 1 from public.user_farm_memberships m where m.user_id=u.id and m.farm_id=f.id
        and m.active and m.deleted_at is null and m.role in ('owner','manager','mechanic','operator'))
        or (u.farm_id=f.id and not exists(select 1 from public.user_farm_memberships m where m.user_id=u.id and m.farm_id=f.id))));
$$;
create or replace function app.chat_support(p_farm uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_rr_support() and exists(select 1 from public.support_visits v
    where v.farm_id = p_farm and v.admin_id = (select auth.uid()) and v.ended_at is null);
$$;
create or replace function app.chat_can_read(p_conversation uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.chat_conversations c
    where c.id = p_conversation and app.chat_ready(c.farm_id)
      and c.farm_id <> all(array(select app.stopped_farm_ids(false)))
      and (app.chat_support(c.farm_id) or
        (app.chat_staff((select auth.uid()), c.farm_id) and exists(
          select 1 from public.chat_members m where m.conversation_id = c.id
            and m.user_id = (select auth.uid()) and m.removed_at is null))));
$$;
create or replace function app.chat_message_readable(p_message uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists(select 1 from public.chat_messages x where x.id = p_message
    and app.chat_can_read(x.conversation_id)
    and ((x.published_at is null and x.sender_id = (select auth.uid())) or
      (x.published_at is not null and (app.chat_support(x.farm_id) or exists(
        select 1 from public.chat_members m where m.conversation_id = x.conversation_id
          and m.user_id = (select auth.uid()) and m.removed_at is null and x.sequence > m.visible_after)))));
$$;

-- All writes serialize on the conversation, including membership revocation.
create or replace function app.chat_lock(p_conversation uuid) returns public.chat_conversations
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.chat_conversations;
begin
  select * into c from public.chat_conversations where id = p_conversation for update;
  if not found or not app.chat_can_read(c.id) or not app.chat_staff(auth.uid(), c.farm_id)
    or not exists(select 1 from public.chat_members m where m.conversation_id = c.id
      and m.user_id = auth.uid() and m.removed_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform app.require_open_farm(c.farm_id, true);
  return c;
end $$;

do $$ declare t text; begin
  foreach t in array array['chat_conversations','chat_members','chat_messages','chat_attachments','chat_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
create policy chat_conversations_select on public.chat_conversations for select to authenticated
  using (app.chat_can_read(id));
create policy chat_members_select on public.chat_members for select to authenticated
  using (app.chat_can_read(conversation_id));
create policy chat_messages_select on public.chat_messages for select to authenticated
  using (app.chat_message_readable(id));
create policy chat_attachments_select on public.chat_attachments for select to authenticated
  using (app.chat_message_readable(message_id) and exists(select 1 from public.chat_messages x
    where x.id = message_id and x.deleted_at is null));
create policy chat_events_select on public.chat_events for select to authenticated
  using (app.chat_can_read(conversation_id));
select app.pay_gate_apply('chat_conversations');
select app.pay_gate_apply('chat_members');
select app.pay_gate_apply('chat_messages');
select app.pay_gate_apply('chat_attachments');
select app.pay_gate_apply('chat_events');

create or replace function public.chat_create(p_id uuid, p_farm uuid, p_kind text, p_title text, p_people uuid[])
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare people uuid[]; person uuid; result uuid; pair text; existing public.chat_conversations;
begin
  if not app.chat_staff(auth.uid(), p_farm) or not app.chat_ready(p_farm) then
    raise exception 'forbidden' using errcode = '42501'; end if;
  perform app.require_open_farm(p_farm, true);
  select array_agg(distinct u order by u) into people from unnest(array_append(p_people, auth.uid())) u;
  if p_id is null or p_kind not in ('direct','group') or p_kind is null
    or cardinality(people) < 2 or cardinality(people) > 100
    or (p_kind = 'direct' and cardinality(people) <> 2)
    or (p_kind = 'group' and char_length(btrim(coalesce(p_title,''))) not between 1 and 120) then
    raise exception 'chat-invalid' using errcode = '22023'; end if;
  foreach person in array people loop
    if not app.chat_staff(person, p_farm) then raise exception 'forbidden' using errcode = '42501'; end if;
  end loop;
  pair := case when p_kind = 'direct' then array_to_string(people, ':') end;
  -- Request id and direct-pair locks avoid duplicate conversations on retries or races.
  perform pg_advisory_xact_lock(hashtextextended('chat-request:' || p_id::text, 0));
  if pair is not null then perform pg_advisory_xact_lock(hashtextextended('chat-pair:' || pair || p_farm::text, 0)); end if;
  select * into existing from public.chat_conversations where id=p_id;
  if found then
    if not app.chat_can_read(existing.id) then raise exception 'forbidden' using errcode='42501'; end if;
    if existing.farm_id<>p_farm or existing.kind<>p_kind or existing.direct_key is distinct from pair
      or (p_kind='group' and (existing.title<>btrim(p_title) or people is distinct from
        (select array_agg(user_id order by user_id) from public.chat_members where conversation_id=p_id and removed_at is null))) then
      raise exception 'chat-request-changed'; end if;
    return existing.id;
  end if;
  select c.id into result from public.chat_conversations c
    where pair is not null and c.farm_id = p_farm and c.direct_key = pair;
  if result is not null then
    if not app.chat_can_read(result) then raise exception 'forbidden' using errcode = '42501'; end if;
    return result;
  end if;
  insert into public.chat_conversations(id,farm_id,kind,title,created_by,direct_key)
    values(p_id,p_farm,p_kind,case when p_kind = 'direct' then 'Direct' else btrim(p_title) end,auth.uid(),pair);
  insert into public.chat_members(conversation_id,farm_id,user_id,is_admin)
    select p_id,p_farm,u,u=auth.uid() from unnest(people) u;
  insert into public.chat_events(farm_id,conversation_id,actor_id,event)
    values(p_farm,p_id,auth.uid(),'created');
  return p_id;
end $$;

create or replace function public.chat_manage(p_conversation uuid, p_action text, p_user uuid default null, p_title text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.chat_conversations; edge bigint;
begin
  c := app.chat_lock(p_conversation);
  perform app.require_open_farm(c.farm_id,true);
  if c.kind <> 'group' or not exists(select 1 from public.chat_members m
    where m.conversation_id=c.id and m.user_id=auth.uid() and m.is_admin and m.removed_at is null) then
    raise exception 'forbidden' using errcode='42501'; end if;
  if p_action = 'rename' then
    if char_length(btrim(coalesce(p_title,''))) not between 1 and 120 then raise exception 'chat-invalid'; end if;
    update public.chat_conversations set title=btrim(p_title),updated_at=now() where id=c.id;
  elsif p_action = 'add' then
    if not app.chat_staff(p_user,c.farm_id) then raise exception 'forbidden' using errcode='42501'; end if;
    if exists(select 1 from public.chat_members where conversation_id=c.id and user_id=p_user and removed_at is null) then return; end if;
    if (select count(*) from public.chat_members where conversation_id=c.id and removed_at is null) >= 100 then raise exception 'chat-invalid'; end if;
    select coalesce(max(sequence),0) into edge from public.chat_messages where conversation_id=c.id;
    insert into public.chat_members(conversation_id,farm_id,user_id,visible_after,last_read)
      values(c.id,c.farm_id,p_user,edge,edge)
      on conflict(conversation_id,user_id) do update set removed_at=null,joined_at=now(),is_admin=false,visible_after=edge,last_read=edge;
  elsif p_action = 'remove' then
    if p_user = auth.uid() then raise exception 'chat-invalid'; end if;
    update public.chat_members set removed_at=now(),is_admin=false where conversation_id=c.id and user_id=p_user and removed_at is null;
  else raise exception 'chat-invalid';
  end if;
  update public.chat_conversations set updated_at=clock_timestamp() where id=c.id;
  insert into public.chat_events(farm_id,conversation_id,actor_id,event,record_id)
    values(c.farm_id,c.id,auth.uid(),p_action,p_user);
end $$;

create or replace function public.chat_prepare(p_conversation uuid, p_id uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations;
begin
  c:=app.chat_lock(p_conversation);
  perform app.require_open_farm(c.farm_id,true);
  if p_id is null then raise exception 'chat-invalid'; end if;
  if exists(select 1 from public.chat_messages where id=p_id and (conversation_id<>c.id or sender_id<>auth.uid())) then
    raise exception 'forbidden' using errcode='42501'; end if;
  insert into public.chat_messages(id,farm_id,conversation_id,sender_id) values(p_id,c.farm_id,c.id,auth.uid()) on conflict(id) do nothing;
  return p_id;
end $$;

create or replace function public.chat_send(p_conversation uuid,p_id uuid,p_body text) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations; msg public.chat_messages;
begin
  c:=app.chat_lock(p_conversation);
  perform app.require_open_farm(c.farm_id,true);
  if char_length(coalesce(p_body,'')) > 8000 then raise exception 'chat-invalid'; end if;
  perform public.chat_prepare(c.id,p_id);
  select * into msg from public.chat_messages where id=p_id for update;
  if msg.published_at is not null then
    if msg.body is distinct from btrim(coalesce(p_body,'')) or msg.deleted_at is not null then raise exception 'chat-request-changed'; end if;
    return msg.id;
  end if;
  if btrim(coalesce(p_body,'')) = '' and not exists(select 1 from public.chat_attachments where message_id=p_id) then
    raise exception 'chat-empty'; end if;
  -- Give publication its own sequence: a draft prepared before a person joined is not old history.
  update public.chat_messages set body=btrim(coalesce(p_body,'')),published_at=now(),sequence=default where id=p_id;
  update public.chat_conversations set updated_at=now() where id=c.id;
  insert into public.chat_events(farm_id,conversation_id,actor_id,event,record_id) values(c.farm_id,c.id,auth.uid(),'sent',p_id);
  insert into public.notifications(user_id,farm_id,channel,template,payload)
    select m.user_id,c.farm_id,'inapp','staff_chat',jsonb_build_object('href','/chat/'||c.id)
    from public.chat_members m where m.conversation_id=c.id and m.removed_at is null
      and m.user_id<>auth.uid() and app.chat_staff(m.user_id,c.farm_id);
  return p_id;
end $$;

create or replace function public.chat_edit(p_conversation uuid,p_id uuid,p_body text,p_delete boolean default false)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations; msg public.chat_messages;
begin
  c:=app.chat_lock(p_conversation);
  perform app.require_open_farm(c.farm_id,true);
  select * into msg from public.chat_messages where id=p_id and conversation_id=c.id for update;
  if not found or msg.sender_id<>auth.uid() or msg.published_at is null or msg.deleted_at is not null then
    raise exception 'forbidden' using errcode='42501'; end if;
  if not coalesce(p_delete,false) and (char_length(coalesce(p_body,''))>8000 or
    (btrim(coalesce(p_body,''))='' and not exists(select 1 from public.chat_attachments where message_id=p_id))) then
    raise exception 'chat-invalid'; end if;
  update public.chat_messages set body=case when p_delete then '' else btrim(p_body) end,
    edited_at=now(),deleted_at=case when p_delete then now() end where id=p_id;
  update public.chat_conversations set updated_at=clock_timestamp() where id=c.id;
  insert into public.chat_events(farm_id,conversation_id,actor_id,event,record_id)
    values(c.farm_id,c.id,auth.uid(),case when p_delete then 'deleted' else 'edited' end,p_id);
end $$;

create or replace function public.chat_mark_read(p_conversation uuid,p_sequence bigint) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations; edge bigint;
begin
  select * into c from public.chat_conversations where id=p_conversation;
  if not app.chat_can_read(c.id) then raise exception 'forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(c.farm_id,false);
  select coalesce(max(sequence),0) into edge from public.chat_messages where conversation_id=c.id and published_at is not null;
  update public.chat_members set last_read=greatest(last_read,least(coalesce(p_sequence,0),edge))
    where conversation_id=c.id and user_id=auth.uid() and removed_at is null;
end $$;

create or replace function public.chat_people(p_farm uuid,p_search text default '',p_offset integer default 0)
returns table(id uuid,name text) language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not app.chat_staff(auth.uid(),p_farm) or not app.chat_ready(p_farm) then raise exception 'forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(p_farm,false);
  return query select u.id,u.name from public.users u where app.chat_staff(u.id,p_farm)
    and u.id<>auth.uid() and strpos(lower(u.name),lower(left(coalesce(p_search,''),120)))>0
    order by u.name,u.id limit 50 offset greatest(0,least(coalesce(p_offset,0),100000));
end $$;

create or replace function public.chat_room(p_conversation uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.chat_conversations;
begin
  select * into c from public.chat_conversations where id=p_conversation;
  if not found or not app.chat_can_read(c.id) then raise exception 'forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(c.farm_id,false);
  return jsonb_build_object('id',c.id,'farm_id',c.farm_id,'title',c.title,'kind',c.kind,
    'can_write',app.farm_billing_gate(c.farm_id)='ok' and app.chat_staff(auth.uid(),c.farm_id),
    'members',(select coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'name',u.name,'admin',m.is_admin) order by u.name),'[]')
      from public.chat_members m join public.users u on u.id=m.user_id
      where m.conversation_id=c.id and m.removed_at is null and app.chat_staff(u.id,c.farm_id)));
end $$;

-- Private update signals only: not messages or membership. RLS is checked for each
create or replace function public.chat_list(p_farm uuid,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not (app.chat_staff(auth.uid(),p_farm) or app.chat_support(p_farm)) or not app.chat_ready(p_farm) then
    raise exception 'forbidden' using errcode='42501'; end if;
  perform app.require_open_farm(p_farm,false);
  return (select coalesce(jsonb_agg(r order by r.updated_at desc,r.id),'[]') from (
    select c.id,c.title,c.kind,c.updated_at,
      (select coalesce(jsonb_agg(u.name order by u.name),'[]') from public.chat_members cm join public.users u on u.id=cm.user_id
        where cm.conversation_id=c.id and cm.removed_at is null and cm.user_id<>auth.uid()) as people,
      (select count(*) from public.chat_messages x join public.chat_members m on m.conversation_id=x.conversation_id
        where x.conversation_id=c.id and m.user_id=auth.uid() and m.removed_at is null
          and x.sequence>greatest(m.last_read,m.visible_after) and x.published_at is not null
          and x.sender_id<>auth.uid() and x.deleted_at is null) as unread
    from public.chat_conversations c where c.farm_id=p_farm and app.chat_can_read(c.id)
    order by c.updated_at desc,c.id limit 50 offset greatest(0,least(coalesce(p_offset,0),100000))) r);
end $$;
revoke all on function public.chat_list(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.chat_list(uuid,integer) to authenticated;

-- Private update signals only: not messages or membership. RLS is checked for each
-- Postgres Changes record. No broadcast/presence payload can bypass a revoked membership.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.chat_conversations;
  end if;
end $$;

revoke all on function app.chat_ready(uuid),app.chat_staff(uuid,uuid),app.chat_support(uuid),
  app.chat_can_read(uuid),app.chat_message_readable(uuid),app.chat_lock(uuid) from public,anon,authenticated,service_role;
grant execute on function app.chat_can_read(uuid),app.chat_message_readable(uuid) to authenticated;
revoke all on function public.chat_create(uuid,uuid,text,text,uuid[]),public.chat_manage(uuid,text,uuid,text),
  public.chat_prepare(uuid,uuid),public.chat_send(uuid,uuid,text),public.chat_edit(uuid,uuid,text,boolean),
  public.chat_mark_read(uuid,bigint),public.chat_people(uuid,text,integer),public.chat_room(uuid) from public,anon,authenticated,service_role;
grant execute on function public.chat_create(uuid,uuid,text,text,uuid[]),public.chat_manage(uuid,text,uuid,text),
  public.chat_prepare(uuid,uuid),public.chat_send(uuid,uuid,text),public.chat_edit(uuid,uuid,text,boolean),
  public.chat_mark_read(uuid,bigint),public.chat_people(uuid,text,integer),public.chat_room(uuid) to authenticated;
