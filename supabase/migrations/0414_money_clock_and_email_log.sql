-- 0414_money_clock_and_email_log.sql
-- G2d — Something has to notice that a quote went stale and an invoice went unpaid.
--
-- `expired` has been in `partner_doc_status` since 0381 and no code path has ever set it:
-- a quote sails past its validity date and stays `sent` for ever. The nightly cron runs
-- eight jobs and none of them looks at `partner_documents`; the F13 reminders that DO
-- chase quotes and invoices read `work_requests`, the model from before documents
-- existed. So a partner's cash flow depends on somebody remembering.
--
-- The engine for this already exists and is paid for — `app.enqueue_*`, quiet hours,
-- weekly dedupe read from the queue itself, the nightly route, in-app delivery and Web
-- Push. This is one more enqueue function in the 0205/0330 pattern, plus the two things
-- those did not need: a way to notify the PARTNER (their money, not a farm's), and a
-- record of what we emailed.

-- ── A notification with no farm ──────────────────────────────────────────────
-- A partner chasing their own client-book customer is not an event on any farm, and
-- `notifications.farm_id` was `not null`. Relaxed rather than inventing a farm to hang it
-- on. Safe under 0403/0404: the read policy is `user_id = auth.uid()` and the write
-- policy is `has_farm_access(farm_id)`, which a null simply fails — these rows are
-- written by SECURITY DEFINER engines, never by a user.
alter table notifications alter column farm_id drop not null;

comment on column notifications.farm_id is
  'The farm the alert is about, or null when it is about the partner''s own customer. '
  'Recipient is `user_id`, which is what the read policy keys on.';

-- ── Telling a partner ────────────────────────────────────────────────────────
create or replace function app.notify_workshop(
  p_workshop uuid, p_farm uuid, p_template text, p_payload jsonb, p_deliver_after timestamptz
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notifications (farm_id, user_id, channel, template, payload, status, deliver_after)
  select p_farm, u.id, 'inapp', p_template, p_payload, 'queued',
         app.user_deliver_after(u.quiet_hours_start, u.quiet_hours_end, p_deliver_after)
  from users u
  where u.workshop_id = p_workshop and u.active and u.deleted_at is null
    and coalesce(u.notify_inapp, true);
end $$;

revoke execute on function app.notify_workshop(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant  execute on function app.notify_workshop(uuid, uuid, text, jsonb, timestamptz) to service_role;

-- Callable from the customer's public link route, which runs as the service role after
-- resolving an unguessable token — the same shape as the public QR flow. Explicitly NOT
-- granted to anon or authenticated: nobody gets to post an alert into a partner's feed by
-- calling this directly.
create or replace function public.notify_workshop_document(
  p_workshop uuid, p_farm uuid, p_template text, p_payload jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.notify_workshop(p_workshop, p_farm, p_template, p_payload, now());
end $$;

revoke execute on function public.notify_workshop_document(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant  execute on function public.notify_workshop_document(uuid, uuid, text, jsonb) to service_role;

-- ── Quotes expire ────────────────────────────────────────────────────────────
-- A quote past its validity date is not an open offer, and leaving it `sent` overstates a
-- partner's pipeline as surely as a missing payment understates their cash.
create or replace function app.expire_partner_quotes() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update partner_documents
     set status = 'expired', updated_at = now()
   where kind = 'quote'
     and status = 'sent'
     and due_date is not null
     and due_date < current_date
     and deleted_at is null;
end $$;

revoke execute on function app.expire_partner_quotes() from public, anon, authenticated;
grant  execute on function app.expire_partner_quotes() to service_role;

-- ── The chase ────────────────────────────────────────────────────────────────
--
-- Three things get chased, each to whoever can act on it:
--
--   quote_expiring    a quote is within its last 3 days. The CUSTOMER decides, so the
--                     farm hears about it; the partner hears too, because a nudge on the
--                     phone is what actually closes it.
--   invoice_due_soon  an invoice falls due within 3 days. The customer hears.
--   invoice_overdue   past due. Both hear — the customer so they can pay, the partner so
--                     they know to ask.
--
-- Weekly dedupe read from the queue, exactly as 0330 does it, so no new column is needed
-- and a reminder that was already sent this week does not fire again.
create or replace function app.enqueue_document_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r               record;
  v_template      text;
  v_deliver_after timestamptz;
  v_owed          bigint;
begin
  for r in
    select d.id, d.farm_id, d.workshop_id, d.kind, d.status, d.number, d.due_date,
           d.total_cents, d.amount_paid_cents, d.bill_to_name,
           w.name as workshop_name, f.settings
      from partner_documents d
      join workshops w on w.id = d.workshop_id
      left join farms f on f.id = d.farm_id
     where d.deleted_at is null
       and d.status in ('sent', 'part_paid')
       and d.due_date is not null
       -- A farm that has left is not chased; a client-book customer has no farm to check.
       and (d.farm_id is null or (f.deleted_at is null and f.status in ('trial', 'active')))
  loop
    if r.kind = 'quote' then
      continue when r.due_date > current_date + 3 or r.due_date < current_date;
      v_template := 'quote_expiring';
    elsif r.kind = 'invoice' then
      v_owed := greatest(coalesce(r.total_cents, 0) - coalesce(r.amount_paid_cents, 0), 0);
      continue when v_owed <= 0;
      if r.due_date < current_date then
        v_template := 'invoice_overdue';
      elsif r.due_date <= current_date + 3 then
        v_template := 'invoice_due_soon';
      else
        continue;
      end if;
    else
      continue;                          -- a credit note is nobody's outstanding item
    end if;

    -- Weekly dedupe, keyed on the DOCUMENT rather than one template. A document with no
    -- farm only ever emits the `_partner` variant, so checking the base template alone
    -- would find nothing and re-fire the partner's reminder every single night — which is
    -- how a useful nudge becomes noise somebody switches off.
    if exists (
      select 1 from notifications n
       where n.template in (v_template, v_template || '_partner')
         and n.payload->>'document_id' = r.id::text
         and n.created_at > now() - interval '7 days'
    ) then
      continue;
    end if;

    v_deliver_after := app.quiet_deliver_after(coalesce(r.settings, '{}'::jsonb));

    if r.farm_id is not null then
      perform app.notify_farm(r.farm_id, v_template, jsonb_build_object(
        'document_id', r.id,
        'number',      r.number,
        'kind',        r.kind,
        'due_date',    r.due_date,
        'amount',      coalesce(v_owed, r.total_cents),
        'workshop',    r.workshop_name
      ), v_deliver_after);
    end if;

    -- The partner hears about an overdue invoice and an expiring quote — the two moments
    -- where picking up the phone is the whole job.
    if v_template in ('invoice_overdue', 'quote_expiring') then
      perform app.notify_workshop(r.workshop_id, r.farm_id, v_template || '_partner', jsonb_build_object(
        'document_id', r.id,
        'number',      r.number,
        'kind',        r.kind,
        'due_date',    r.due_date,
        'amount',      coalesce(v_owed, r.total_cents),
        'customer',    r.bill_to_name
      ), v_deliver_after);
    end if;
  end loop;
end $$;

revoke execute on function app.enqueue_document_reminders() from public, anon, authenticated;
grant  execute on function app.enqueue_document_reminders() to service_role;

create or replace function public.cron_enqueue_document_reminders() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform app.expire_partner_quotes();
  perform app.enqueue_document_reminders();
end $$;

revoke execute on function public.cron_enqueue_document_reminders() from public, anon, authenticated;
grant  execute on function public.cron_enqueue_document_reminders() to service_role;

-- ── What we actually sent ────────────────────────────────────────────────────
--
-- "Send" has meant "set a status and write an in-app alert" — the customer had to log in
-- to discover they had been invoiced. With real email behind it, the question a partner
-- asks next is "did it go, and where", and that needs a record rather than a provider
-- dashboard they do not have a login for.
--
-- One row per attempt, including failures: a bounce is the most useful thing on this
-- table and the easiest to lose.
create table document_emails (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references partner_documents(id) on delete cascade,
  workshop_id  uuid not null references workshops(id),
  farm_id      uuid,                       -- mirrors the document; null for a client-book customer
  to_email     text not null,
  cc_email     text,
  subject      text not null,
  status       text not null default 'sent' check (status in ('sent', 'failed')),
  provider     text,                       -- 'resend'
  provider_id  text,                       -- the provider's message id, for support
  error        text,
  sent_by      uuid references users(id),
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  deleted_by   uuid
);
create index document_emails_doc_idx  on document_emails(document_id, created_at desc);
create index document_emails_shop_idx on document_emails(workshop_id, created_at desc);

alter table document_emails enable row level security;
alter table document_emails force  row level security;

-- Visibility follows the document exactly — including the draft rule — so a farmer sees
-- that a document was emailed to them and never sees a partner's other correspondence.
create policy document_emails_sel on document_emails for select to authenticated
  using (deleted_at is null and app.partner_doc_visible_by_id(document_id));

-- Written by the send route under the service role; no user inserts directly.
grant select on document_emails to authenticated;
grant all    on document_emails to service_role;

-- ── The public link a customer can open ──────────────────────────────────────
--
-- Emailing a PDF is half of it; the other half is a page the customer can open without an
-- account, to read the document and accept or decline it. Same property as the QR flow:
-- an unguessable token, ZERO anon database access, every read through a service-role
-- route that validates the token first.
alter table partner_documents
  add column public_token uuid not null default gen_random_uuid(),
  add column viewed_at    timestamptz,
  add column accepted_by_name text,          -- who accepted, as they typed it
  add column accepted_via     text check (accepted_via in ('app', 'link'));

create unique index partner_documents_token_uq on partner_documents(public_token);

comment on column partner_documents.public_token is
  'Unguessable per-document token behind the customer''s view/accept link. Never exposed '
  'to anon SQL — a service-role route validates it and does the read, exactly as the '
  'public QR flow does.';
comment on column partner_documents.accepted_by_name is
  'Who accepted the quote, in their own words. Before this, acceptance was a status '
  'column and nothing else — thinner evidence than the paper book it replaced.';
