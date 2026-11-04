-- WhatsApp voice notes and photos (20261104210000).
--
-- The text pilot (20261015175415) stored every non-text message as "[unsupported message]".
-- Voice notes and photos now reach the worker as a Meta media id, never as bytes: the
-- webhook stays small and signature-checked, and the worker fetches the file only once it
-- knows the sender is a live, authorised link.
--
-- * A VOICE NOTE is transcribed with the in-app speech models (src/lib/whatsapp/voice.ts),
--   held and settled in the AI ledger like any other hearing, and answered as if typed.
--   Nothing about the audio is kept: not the file, not the transcript beyond the inbox's
--   own 30-day text retention.
-- * A PHOTO is staged in the farm's own folder of the fault-photos bucket and recorded
--   here. The assistant asks what it is for; it is attached to a fault (new or already
--   logged) only after the person confirms, using their own delegated permissions, and
--   is deleted when they discard it or the conversation lapses.

alter table public.whatsapp_inbox
  add column if not exists media_kind text,
  add column if not exists media_id text,
  add column if not exists media_mime text;
alter table public.whatsapp_inbox
  add constraint whatsapp_inbox_media_kind_ck check (media_kind is null or media_kind in ('audio','image')),
  add constraint whatsapp_inbox_media_id_ck check (media_id is null or length(media_id) between 1 and 300),
  add constraint whatsapp_inbox_media_mime_ck check (media_mime is null or length(media_mime) <= 100),
  add constraint whatsapp_inbox_media_pair_ck check ((media_kind is null) = (media_id is null));

-- A staged photo: one per inbox message (a replayed webhook stages nothing twice).
create table public.whatsapp_media (
  id uuid primary key default gen_random_uuid(),
  inbox_id uuid not null unique references public.whatsapp_inbox(id),
  link_id uuid not null references public.whatsapp_links(id),
  farm_id uuid not null references public.farms(id),
  user_id uuid not null references public.users(id),
  kind text not null check (kind = 'image'),
  bucket text not null check (bucket = 'fault-photos'),
  storage_path text not null unique check (length(storage_path) <= 300),
  mime text not null check (mime in ('image/jpeg','image/png','image/webp')),
  bytes integer not null check (bytes between 1 and 6291456),
  state text not null default 'staged' check (state in ('staged','attached','discarded','expired')),
  attachment_id uuid references public.attachments(id),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint whatsapp_media_attached_ck check ((state = 'attached') = (attachment_id is not null)),
  -- The object lives in the farm's own folder, which is what the storage policies read.
  constraint whatsapp_media_path_ck check (storage_path like farm_id::text || '/whatsapp/%')
);
create index whatsapp_media_staged on public.whatsapp_media(created_at) where state = 'staged';
alter table public.whatsapp_media enable row level security;
revoke all on public.whatsapp_media from public, anon, authenticated;
grant all on public.whatsapp_media to service_role;
create trigger whatsapp_media_test_fence before insert or update on public.whatsapp_media
  for each row execute function app.fence_user_farm();

-- Receives only data from a verified Meta signature. No caller-supplied account IDs.
-- The media arguments default to null, so a webhook still on the four-argument call keeps
-- working through a deploy.
drop function if exists public.whatsapp_receive(text,text,text,timestamptz);
create function public.whatsapp_receive(p_provider_id text,p_phone text,p_text text,p_at timestamptz,
  p_media_kind text default null,p_media_id text default null,p_media_mime text default null)
returns void language plpgsql security invoker set search_path = '' as $$
declare l public.whatsapp_links%rowtype;
begin
  select * into l from public.whatsapp_links where phone=p_phone and revoked_at is null for update;
  if not found then return; end if;
  if p_media_kind is null and upper(trim(p_text)) in ('STOP','UNSUBSCRIBE','CANCEL','STOP ALL') then
    update public.whatsapp_links set revoked_at=now(),conversation=null where id=l.id;
    return;
  end if;
  if l.expires_at<=now() or not app.whatsapp_member(l.user_id,l.farm_id)
     or p_at<l.linked_at or p_at<now()-interval '24 hours' or p_at>now()+interval '5 minutes' then return; end if;
  if (select count(*) from public.whatsapp_inbox where link_id=l.id and created_at>now()-interval '1 minute')>=12 then return; end if;
  if p_media_kind is not null and (p_media_kind not in ('audio','image') or coalesce(p_media_id,'')='') then return; end if;
  insert into public.whatsapp_inbox(provider_id,link_id,message_text,message_at,media_kind,media_id,media_mime)
    values(p_provider_id,l.id,coalesce(p_text,''),p_at,p_media_kind,nullif(p_media_id,''),left(p_media_mime,100))
    on conflict(provider_id) do nothing;
end $$;
revoke all on function public.whatsapp_receive(text,text,text,timestamptz,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_receive(text,text,text,timestamptz,text,text,text) to service_role;

-- Transport text is short-lived, and so is the provider's media reference.
create or replace function public.whatsapp_prune() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  update public.whatsapp_inbox set message_text='',reply=null,media_id=null,media_mime=null,media_kind=null
    where created_at<now()-interval '30 days' and (message_text<>'' or reply is not null or media_id is not null);
  update public.whatsapp_links set conversation=null,conversation_at=null
    where conversation_at<now()-interval '15 minutes' or revoked_at is not null;
  delete from public.whatsapp_link_challenges where created_at<now()-interval '1 day';
end $$;
revoke all on function public.whatsapp_prune() from public,anon,authenticated;
grant execute on function public.whatsapp_prune() to service_role;
