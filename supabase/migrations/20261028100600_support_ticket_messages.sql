-- 20261028100600_support_ticket_messages.sql
-- The conversation on a support case.
--
-- A case used to hold one question in its evidence and nothing else: no answer the
-- customer could read, no reply box, no notes. Each message here is one turn:
--
--   author_kind  customer (the person who asked, or their owner or manager), staff (Rapid
--                Rise), or system (a status change or an assignment, written by the staff
--                function that made it, with the staff member as author)
--   visibility   public (the customer sees it) or internal (Rapid Rise only: notes, logged
--                calls, status changes). A customer's own message is always public.
--   channel      how it was said: in the app, or logged from a call, WhatsApp, an email or
--                a visit
--
-- Rapid Rise reads the table directly (RLS: app.is_rr_support()); customers never do. They
-- read their own threads through public.my_help_request(), which returns public messages
-- only, for cases they may see. Every write goes through a SECURITY DEFINER function, so the
-- table is append-only to everyone but the server (which stamps the reply email's outcome).
--
-- AUDIT: deliberately not attached to app_audit. That trigger files a row under the case's
-- farm, which farm members can read, and these rows are internal notes and other people's
-- questions. A message is its own record: who wrote it and when are columns, and nothing
-- here is ever edited or deleted by a person.

create table if not exists public.support_ticket_messages (
  id           uuid primary key default gen_random_uuid(),
  ticket_id    uuid not null references public.support_tickets(id) on delete cascade,
  author_id    uuid references public.users(id),
  author_kind  text not null check (author_kind in ('customer', 'staff', 'system')),
  visibility   text not null default 'public' check (visibility in ('public', 'internal')),
  channel      text not null default 'in_app'
               check (channel in ('in_app', 'email', 'phone', 'whatsapp', 'in_person', 'system')),
  body         text not null check (btrim(body) <> '' and char_length(body) <= 4000),
  -- The reply email to the customer (staff public replies only): sent, or why not.
  emailed_at   timestamptz,
  email_error  text check (email_error is null or char_length(email_error) <= 300),
  created_at   timestamptz not null default clock_timestamp(),
  constraint support_ticket_messages_customer_public_ck
    check (author_kind <> 'customer' or visibility = 'public')
);

comment on table public.support_ticket_messages is
  'One turn of a support conversation: customer, staff or system; public or internal. Read by '
  'Rapid Rise directly and by customers only through my_help_request() (public turns of cases '
  'they may see). Not audited under the farm: notes and other people''s questions are not the '
  'farm''s to read.';

create index if not exists support_ticket_messages_ticket_idx
  on public.support_ticket_messages (ticket_id, created_at);

alter table public.support_ticket_messages enable row level security;
alter table public.support_ticket_messages force row level security;

drop policy if exists support_ticket_messages_sel on public.support_ticket_messages;
create policy support_ticket_messages_sel on public.support_ticket_messages
  for select to authenticated using (app.is_rr_support());

revoke all on public.support_ticket_messages from anon, authenticated;
grant select on public.support_ticket_messages to authenticated;
grant select, insert, update on public.support_ticket_messages to service_role;
