-- 20261028100800_support_alerts.sql
-- Telling people about support cases: Rapid Rise when a customer asks or replies, the
-- customer when Rapid Rise answers.
--
-- Rapid Rise's alerts are filed with NO farm (notifications.farm_id is nullable since
-- 0414; the read policy is the recipient). Filed under the customer's farm they would sit
-- in that farm's activity log through the notifications audit trigger, and the payload is
-- deliberately only the case id for the same reason: the subject and the question are read
-- on the case page, behind two-step. A test case alerts nobody (20261014120000): the
-- click-through opens one on every run.
--
-- The customer's alert is filed under the case's farm and addressed to the person who
-- asked; its payload is the case id too. The app also emails them (lib/support/emails.ts).

create or replace function app.notify_rr_support(
  p_ticket uuid, p_template text, p_extra jsonb default '{}'::jsonb
) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sent integer;
begin
  if p_ticket is null or exists (select 1 from public.support_tickets t where t.id = p_ticket and t.is_test) then
    return 0;
  end if;
  insert into public.notifications (farm_id, user_id, channel, template, payload, status)
  select null, u.id, 'inapp', p_template,
         jsonb_build_object('ticket_id', p_ticket) || coalesce(p_extra, '{}'::jsonb), 'queued'
    from public.users u
   where u.role = 'rr_admin' and u.active and u.deleted_at is null and not u.is_test
     and coalesce(u.notify_inapp, true);
  get diagnostics v_sent = row_count;
  return v_sent;
end $$;

comment on function app.notify_rr_support(uuid, text, jsonb) is
  'In-app alert to every real, active Rapid Rise admin about a support case. No farm on the row '
  'and only the case id in the payload; a test case alerts nobody.';

create or replace function app.notify_support_customer(p_ticket uuid, p_template text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_sent integer;
begin
  insert into public.notifications (farm_id, user_id, channel, template, payload, status)
  select t.farm_id, t.asked_by, 'inapp', p_template, jsonb_build_object('ticket_id', t.id), 'queued'
    from public.support_tickets t
    join public.users u on u.id = t.asked_by
   where t.id = p_ticket and u.active and u.deleted_at is null
     and t.kind in ('help_request', 'privacy_request', 'export_request');
  get diagnostics v_sent = row_count;
  return v_sent;
end $$;

comment on function app.notify_support_customer(uuid, text) is
  'In-app alert to the person who asked, that Rapid Rise has answered their support case.';

revoke execute on function app.notify_rr_support(uuid, text, jsonb) from public, anon, authenticated;
revoke execute on function app.notify_support_customer(uuid, text) from public, anon, authenticated;
