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
