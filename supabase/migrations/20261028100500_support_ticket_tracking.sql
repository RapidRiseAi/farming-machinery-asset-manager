-- 20261028100500_support_ticket_tracking.sql
-- What a support case needs to be worked rather than merely stored.
--
-- Until now a help request was a row nobody was told about, with no owner, no deadline
-- that meant anything and no way to tell a test farm's question from a customer's. These
-- columns are what the support desk (/admin/support) reads and the staff functions write:
--
--   workshop_id            a contractor asking (contractors may ask too now); with farm_id
--                          when they ask about a linked farm
--   asked_by               the person who asked, so they (and only they, unless they are
--                          the farm's owner or manager) see it under "What you have asked"
--   channel                how it reached us: in the app, or logged by staff from a call,
--                          a WhatsApp, an email or a visit
--   assigned_to            who on the team has it
--   first_response_due_at  the same-day promise, from app.support_due_at
--   first_response_at      when the first answer actually went out
--   last_customer_at       the customer's latest message (who has the ball)
--   last_staff_at          ours
--   is_test                a test farm, workshop or account asked: kept out of the queue's
--                          defaults, the badge and every alert
--
-- The audit trigger on this table is not touched here (another change owns app_audit).

alter table public.support_tickets
  add column if not exists workshop_id           uuid references public.workshops(id),
  add column if not exists asked_by              uuid references public.users(id),
  add column if not exists channel               text not null default 'in_app',
  add column if not exists assigned_to           uuid references public.users(id),
  add column if not exists first_response_due_at timestamptz,
  add column if not exists first_response_at     timestamptz,
  add column if not exists last_customer_at      timestamptz,
  add column if not exists last_staff_at         timestamptz,
  add column if not exists is_test               boolean not null default false;

alter table public.support_tickets drop constraint if exists support_tickets_channel_ck;
alter table public.support_tickets add constraint support_tickets_channel_ck
  check (channel in ('in_app', 'email', 'phone', 'whatsapp', 'in_person', 'system'));

comment on column public.support_tickets.asked_by is
  'Who asked. Customers see their own requests; owners and managers see their farm''s (not privacy requests).';
comment on column public.support_tickets.is_test is
  'Asked by or about a test farm, workshop or account (20261014120000). Set by trigger; kept out of alerts.';

-- == Existing rows ===========================================================
-- A help request recorded who asked inside its evidence; disputes and refunds came from the
-- payment provider.
update public.support_tickets t
   set asked_by = u.id
  from public.users u
 where t.asked_by is null
   and t.kind = 'help_request'
   and u.id::text = t.evidence->'asked_by'->>'id';
update public.support_tickets
   set last_customer_at = opened_at
 where kind = 'help_request' and last_customer_at is null;
update public.support_tickets
   set channel = 'system'
 where kind in ('refund_request', 'dispute', 'billing_anomaly') and channel = 'in_app';

-- == The test mark follows whoever asked and whatever it is about ===============
create or replace function app.support_ticket_mark_test() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.is_test := app.farm_is_test(new.farm_id)
              or app.workshop_is_test(new.workshop_id)
              or app.user_is_test(new.asked_by);
  return new;
end $$;

revoke execute on function app.support_ticket_mark_test() from public, anon, authenticated;

drop trigger if exists support_tickets_mark_test on public.support_tickets;
create trigger support_tickets_mark_test
  before insert or update of farm_id, workshop_id, asked_by on public.support_tickets
  for each row execute function app.support_ticket_mark_test();

-- Only rows whose mark changes, so the backfill writes as few rows as it can.
update public.support_tickets t
   set is_test = true
 where not t.is_test
   and (app.farm_is_test(t.farm_id) or app.workshop_is_test(t.workshop_id) or app.user_is_test(t.asked_by));

-- A row with a farm and a workshop: test and real never mix (test_account_fence.sql checks
-- every such table carries this trigger).
drop trigger if exists support_tickets_test_fence on public.support_tickets;
create trigger support_tickets_test_fence before insert or update on public.support_tickets
  for each row execute function app.fence_farm_workshop();

create index if not exists support_tickets_asked_by_idx
  on public.support_tickets (asked_by, opened_at desc) where asked_by is not null;
create index if not exists support_tickets_workshop_idx
  on public.support_tickets (workshop_id, opened_at desc) where workshop_id is not null;
create index if not exists support_tickets_assigned_idx
  on public.support_tickets (assigned_to, status) where status in ('open', 'waiting');
