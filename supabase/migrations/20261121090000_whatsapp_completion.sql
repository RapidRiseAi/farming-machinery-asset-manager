-- 20261121090000_whatsapp_completion.sql
-- Task B4: WhatsApp completion (BRIEF section 13; decisions 19, 21, 24; scenarios 33 and 36).
--
-- Additive and safe on live data:
--   1. Capability flags per path. Text and alerts were proven on a real phone on 17 and
--      18 October 2026 (docs/WHATSAPP.md), so they start released and nothing that works
--      today stops. Photos and voice notes were built on 4 November and never tested on a
--      phone: they start in testing (off unless Rapid Rise opens them to a business).
--   2. Delivery statuses that only move forward. Meta's status webhooks can arrive late,
--      twice or out of order; a late "sent" must not undo a "read". A "failed" is kept only
--      over "sent" (Meta reports failures after a send it accepted), never over a delivery.
--      Whether Meta said the message was chargeable is kept beside it (A3 settles the money).
--   3. One answer per message. An inbound message whose answer was started and never saved
--      (the process died after the model was paid) is not answered by the model again.

-- == 1. Capability flags ======================================================================
insert into public.feature_flags (key, note, released) values
  ('whatsapp_text',   'WhatsApp text questions and confirmations. Real-phone verified 17 Oct 2026.', true),
  ('whatsapp_alerts', 'WhatsApp assignment and notification templates. Real-phone verified 18 Oct 2026.', true),
  ('whatsapp_photos', 'WhatsApp photos into faults. In testing until the real-phone photo journey passes.', false),
  ('whatsapp_voice',  'WhatsApp voice notes heard and answered. In testing until the real-phone voice journey passes.', false)
on conflict (key) do nothing;

-- The worker runs as the service role; this answers for one business, failing closed.
create or replace function app.whatsapp_capability(p_farm uuid, p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_key in ('whatsapp_text', 'whatsapp_alerts', 'whatsapp_photos', 'whatsapp_voice')
     and exists (select 1 from public.feature_flags f
                  where f.key = p_key
                    and (f.released or exists (select 1 from public.farm_feature_access a
                                                where a.farm_id = p_farm and a.key = f.key)));
$$;
revoke all on function app.whatsapp_capability(uuid, text) from public, anon, authenticated;
grant execute on function app.whatsapp_capability(uuid, text) to service_role;

create or replace function public.whatsapp_capability(p_farm uuid, p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.whatsapp_capability(p_farm, p_key);
$$;
revoke all on function public.whatsapp_capability(uuid, text) from public, anon, authenticated;
grant execute on function public.whatsapp_capability(uuid, text) to service_role;

-- == 2. Delivery statuses that only move forward ==============================================
alter table public.whatsapp_inbox add column if not exists delivery_status_at timestamptz;
alter table public.whatsapp_inbox add column if not exists delivery_chargeable boolean;
alter table public.whatsapp_notification_delivery add column if not exists delivery_status_at timestamptz;
alter table public.whatsapp_notification_delivery add column if not exists delivery_chargeable boolean;

-- sent 1, delivered 2, read 3; failed 1.5: above sent, below any delivery.
create or replace function app.whatsapp_status_rank(p_status text) returns numeric
language sql immutable set search_path = public, pg_temp as $$
  select case p_status when 'sent' then 1 when 'failed' then 1.5 when 'delivered' then 2 when 'read' then 3 else 0 end;
$$;
revoke all on function app.whatsapp_status_rank(text) from public, anon, authenticated;

-- One status from Meta's webhook, for whichever message it names. Returns how many rows moved.
create or replace function public.whatsapp_record_status(p_provider_id text, p_status text, p_billable boolean default null)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_moved integer := 0;
  v_n integer;
begin
  if p_provider_id is null or length(p_provider_id) > 200 or app.whatsapp_status_rank(p_status) = 0 then
    raise exception 'whatsapp-status-invalid' using errcode = '22023';
  end if;
  update public.whatsapp_inbox
     set delivery_status = p_status, delivery_status_at = now(),
         delivery_chargeable = coalesce(p_billable, delivery_chargeable)
   where provider_reply_id = p_provider_id
     and app.whatsapp_status_rank(p_status) > app.whatsapp_status_rank(coalesce(delivery_status, ''));
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  -- A repeated or late status still records Meta's chargeable answer if it was missing.
  update public.whatsapp_inbox set delivery_chargeable = p_billable
   where provider_reply_id = p_provider_id and p_billable is not null and delivery_chargeable is null;
  update public.whatsapp_notification_delivery
     set delivery_status = p_status, delivery_status_at = now(),
         delivery_chargeable = coalesce(p_billable, delivery_chargeable)
   where provider_id = p_provider_id
     and app.whatsapp_status_rank(p_status) > app.whatsapp_status_rank(coalesce(delivery_status, ''));
  get diagnostics v_n = row_count; v_moved := v_moved + v_n;
  update public.whatsapp_notification_delivery set delivery_chargeable = p_billable
   where provider_id = p_provider_id and p_billable is not null and delivery_chargeable is null;
  return v_moved;
end $$;
revoke all on function public.whatsapp_record_status(text, text, boolean) from public, anon, authenticated;
grant execute on function public.whatsapp_record_status(text, text, boolean) to service_role;

-- == 3. One answer per message ================================================================
alter table public.whatsapp_inbox add column if not exists answer_started_at timestamptz;

-- The worker calls this, under its lease, just before it asks the model. True: this attempt
-- may answer. False: an earlier attempt already started (and may have been paid for), so the
-- person is asked to send the message again instead of the model being asked twice.
create or replace function public.whatsapp_start_answer(p_id uuid, p_lease uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_ok boolean;
begin
  update public.whatsapp_inbox set answer_started_at = now()
   where id = p_id and lease_id = p_lease and answer_started_at is null and reply is null
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;
revoke all on function public.whatsapp_start_answer(uuid, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_start_answer(uuid, uuid) to service_role;

-- == 4. Photos through the upload pipeline and the storage pool ===============================
-- Before: a WhatsApp photo went straight into fault-photos with the service key, so a full pool
-- (A3, 20261118120000) never stopped it and nothing counted it until the nightly measurement.
-- Now staging reserves the bytes on the customer's pool under its lock, refuses with
-- upload:storage_full when it is full, and records an upload intent so the pool counts the
-- photo at once (and the nightly orphan measurement leaves it alone). Discarding or expiring a
-- photo marks the intent removed, which frees the bytes.
alter table public.upload_intents drop constraint upload_intents_target_kind_check;
alter table public.upload_intents add constraint upload_intents_target_kind_check check (target_kind in (
  'machine', 'fault', 'checklist_instance', 'job_card', 'work_request', 'trip_job', 'finance_agreement',
  'asset_contract', 'partner_document', 'partner_expense', 'billing_payment', 'assistant_command',
  'chat_message', 'whatsapp_media')) not valid;
alter table public.upload_intents validate constraint upload_intents_target_kind_check;

create or replace function public.whatsapp_stage_photo(
  p_inbox uuid, p_link uuid, p_farm uuid, p_user uuid, p_path text, p_mime text, p_bytes bigint
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  m public.whatsapp_media;
begin
  -- A replay of the same message answers with the same staged photo.
  select * into m from public.whatsapp_media where inbox_id = p_inbox;
  if found then
    return jsonb_build_object('id', m.id, 'storage_path', m.storage_path, 'farm_id', m.farm_id, 'state', m.state);
  end if;
  -- The link must still be this person's, on this business, and live.
  if not exists (select 1 from public.whatsapp_links l
                  where l.id = p_link and l.farm_id = p_farm and l.user_id = p_user and l.revoked_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_bytes is null or p_bytes <= 0 or p_mime not in ('image/jpeg', 'image/png', 'image/webp')
     or p_path is null or p_path not like p_farm::text || '/whatsapp/%' then
    raise exception 'whatsapp-photo-invalid' using errcode = '22023';
  end if;
  -- The customer's pool, under its lock to the end of this transaction (raises upload:storage_full).
  perform app.storage_pool_reserve(p_farm, p_bytes);
  insert into public.whatsapp_media (inbox_id, link_id, farm_id, user_id, kind, bucket, storage_path, mime, bytes)
  values (p_inbox, p_link, p_farm, p_user, 'image', 'fault-photos', p_path, p_mime, p_bytes)
  returning * into m;
  insert into public.upload_intents (
    farm_id, user_id, target_kind, target_id, label, bucket, object_path, media_class, purpose,
    declared_mime, declared_bytes, reserved_bytes, counts_against_quota, actual_mime, actual_bytes,
    status, request_id, record_id, expires_at, verified_at, finalised_at)
  values (
    p_farm, p_user, 'whatsapp_media', m.id, 'whatsapp', 'fault-photos', p_path, 'photo', 'attachment',
    p_mime, p_bytes, p_bytes, true, p_mime, p_bytes,
    'finalised', p_inbox, m.id, now() + interval '1 day', now(), now());
  return jsonb_build_object('id', m.id, 'storage_path', m.storage_path, 'farm_id', m.farm_id, 'state', m.state);
end $$;
revoke all on function public.whatsapp_stage_photo(uuid, uuid, uuid, uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.whatsapp_stage_photo(uuid, uuid, uuid, uuid, text, text, bigint) to service_role;

-- The staged photo's object is gone (discarded, expired, or its upload failed): its bytes leave
-- the pool. An attached photo keeps counting as the fault photo it became.
create or replace function public.whatsapp_photo_removed(p_media uuid) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.upload_intents set object_removed_at = now()
   where target_kind = 'whatsapp_media' and target_id = p_media and object_removed_at is null
     and not exists (select 1 from public.whatsapp_media m where m.id = p_media and m.state = 'attached');
$$;
revoke all on function public.whatsapp_photo_removed(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_photo_removed(uuid) to service_role;
-- == 5. App upload links for files WhatsApp cannot carry ======================================
-- A photo past Meta's limit, a document, or a path not released yet: the reply carries a link
-- to the app. The link is never write access by itself. It works only for the same signed-in
-- person, on the same business, while they are still a member, for 30 minutes; it opens the
-- app's own upload (B1's pipeline and the normal row security). Only the token's hash is kept.
create table if not exists public.whatsapp_upload_links (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  link_id     uuid not null references public.whatsapp_links(id),
  farm_id     uuid not null references public.farms(id),
  user_id     uuid not null references public.users(id),
  purpose     text not null check (purpose in ('fault_photo', 'document', 'voice')),
  target_kind text check (target_kind in ('fault')),
  target_id   uuid,
  expires_at  timestamptz not null,
  opened_at   timestamptz,
  created_at  timestamptz not null default now(),
  constraint whatsapp_upload_links_target_ck check ((target_kind is null) = (target_id is null))
);
create index if not exists whatsapp_upload_links_expiry on public.whatsapp_upload_links (expires_at);
alter table public.whatsapp_upload_links enable row level security;
alter table public.whatsapp_upload_links force row level security;
revoke all on public.whatsapp_upload_links from public, anon, authenticated;
grant all on public.whatsapp_upload_links to service_role;
select app.pay_gate_apply('whatsapp_upload_links');

-- The worker: one link for one person, business and (optional) fault.
create or replace function public.whatsapp_upload_link_create(
  p_token_hash text, p_link uuid, p_purpose text, p_target_kind text default null, p_target uuid default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  l public.whatsapp_links;
  v_id uuid;
begin
  select * into l from public.whatsapp_links where id = p_link and revoked_at is null;
  if not found then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_target_kind = 'fault' and not exists (
       select 1 from public.faults f where f.id = p_target and f.farm_id = l.farm_id and f.deleted_at is null) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.whatsapp_upload_links (token_hash, link_id, farm_id, user_id, purpose, target_kind, target_id, expires_at)
  values (p_token_hash, l.id, l.farm_id, l.user_id, p_purpose, p_target_kind, p_target, now() + interval '30 minutes')
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.whatsapp_upload_link_create(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_upload_link_create(text, uuid, text, text, uuid) to service_role;

-- The signed-in person opening it. Fixed refusal codes; nothing about another person's link.
create or replace function public.whatsapp_upload_link_open(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  u public.whatsapp_upload_links;
begin
  if auth.uid() is null then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into u from public.whatsapp_upload_links where token_hash = p_token_hash;
  -- Another person's link answers exactly as an unknown one.
  if not found or u.user_id <> auth.uid() then return jsonb_build_object('ok', false, 'reason', 'unknown'); end if;
  if u.expires_at <= now() then return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if app.effective_farm_role(auth.uid(), u.farm_id) is null then
    return jsonb_build_object('ok', false, 'reason', 'not_member');
  end if;
  perform app.require_open_farm(u.farm_id, true);
  update public.whatsapp_upload_links set opened_at = coalesce(opened_at, now()) where id = u.id;
  return jsonb_build_object('ok', true, 'farm_id', u.farm_id, 'purpose', u.purpose,
    'target_kind', u.target_kind, 'target_id', u.target_id);
end $$;
revoke all on function public.whatsapp_upload_link_open(text) from public, anon;
grant execute on function public.whatsapp_upload_link_open(text) to authenticated;