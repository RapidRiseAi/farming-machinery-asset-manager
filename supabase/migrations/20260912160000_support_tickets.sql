-- 20260912160000_support_tickets.sql
-- A refund request is a conversation, and until now it had nowhere to live.
--
-- FOUNDER DECISION, 12 September 2026
-- ─────────────────────────────────────────────────────────────────────────────
-- Money only ever goes back by a HUMAN deciding, one case at a time. The two ordinary
-- ways a farm pays less are already built and neither involves a refund:
--
--   * a DOWNGRADE mid-cycle keeps the plan they paid for until the period ends, then
--     charges the smaller amount (`pending_plan` / `apply_pending_plan_changes`);
--   * a CANCELLATION keeps access to the end of the period and simply does not charge
--     again (`cancel_at_period_end`, true by default).
--
-- What is left is the genuinely individual case: "I do not recognise this deduction", "you
-- charged me after I cancelled", "somebody used my card". Those are not policy, they are
-- support — and each needs a person looking at the actual facts.
--
-- So this migration does not decide anything about money. It makes sure that when one of
-- those arrives, EVERY fact the person deciding needs is already gathered, attached, and
-- time-stamped, instead of being reassembled by hand out of Paystack's dashboard and six
-- of our own tables while a 48-business-hour dispute clock runs.
--
-- WHY A TABLE HERE RATHER THAN ONLY A WEBHOOK TO THE SUPPORT DASHBOARD
-- ─────────────────────────────────────────────────────────────────────────────
-- Tickets are read in RapidRise OS, not here, and `20260912170000` posts them there. But
-- the record is written HERE first and unconditionally, because the outbound post can fail,
-- the endpoint can be unset, and a dispute that arrived while the integration was down is
-- exactly the one that matters. The same reasoning as receipts: claim, then send, and never
-- let "we told somebody" depend on a network call nobody watched.
--
-- WHAT IT MUST NEVER CONTAIN
-- ─────────────────────────────────────────────────────────────────────────────
-- `billing_payment_methods.authorization_code` is a Paystack CHARGING CREDENTIAL and is not
-- granted to `authenticated` at the column level (20260903160100). Evidence is assembled by
-- a SECURITY DEFINER function, which would happily read it — so the column list below is
-- explicit and the credential is absent by construction, not by the author remembering.
-- Last4 and brand are what a human needs to recognise a card; the code is what charges it.

-- ── The shapes ──────────────────────────────────────────────────────────────

do $$ begin
  if not exists (select 1 from pg_type where typname = 'support_ticket_kind') then
    create type support_ticket_kind as enum (
      'refund_request',   -- a customer asked for money back
      'dispute',          -- the bank asked for it back on their behalf; there is a deadline
      'billing_anomaly',  -- we charged something that looks wrong
      'manual'            -- opened by a person
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'support_ticket_status') then
    create type support_ticket_status as enum ('open', 'waiting', 'resolved', 'closed');
  end if;
end $$;

create table if not exists public.support_tickets (
  id            uuid primary key default gen_random_uuid(),
  kind          support_ticket_kind   not null,
  status        support_ticket_status not null default 'open',

  -- Which farm it concerns. NULLABLE: a dispute can arrive naming a transaction we cannot
  -- match to a farm, and a ticket nobody can file is still a ticket that has to exist.
  farm_id       uuid references public.farms(id),
  invoice_id    uuid references public.billing_invoices(id),
  payment_id    uuid references public.billing_payments(id),

  -- The provider's own reference for the thing that caused this — a dispute id, a refund
  -- reference. The unique index below makes auto-creation idempotent against it, so a
  -- redelivered webhook updates one ticket rather than opening a second.
  external_ref  text,
  source_event  uuid references public.billing_webhook_events(id),

  subject       text not null,
  -- Everything the person deciding needs, gathered at open time: the farm, the plan, the
  -- invoice, the payment, the card's last four, the attempt history, the contact. Frozen
  -- rather than joined, so a ticket read next year shows what was true when it was raised.
  evidence      jsonb not null default '{}'::jsonb,

  -- When the answer is late. For a dispute this is the real deadline: South Africa gives
  -- roughly 48 business hours before Paystack accepts it on our behalf and takes the money
  -- out of a payout.
  due_at        timestamptz,
  escalated_at  timestamptz,

  opened_at     timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references public.users(id),
  resolution    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint support_tickets_subject_ck check (btrim(subject) <> ''),
  -- A resolved ticket has a time and a reason. Half a resolution is worse than none: it
  -- reads as handled and says nothing about how.
  constraint support_tickets_resolved_ck check (
    (status in ('resolved','closed')) = (resolved_at is not null)
  )
);

comment on table public.support_tickets is
  'One support case, with the evidence already gathered. Written here first and posted to '
  'the RapidRise OS support dashboard by the outbound hook — because the post can fail and '
  'the dispute that arrives while the integration is down is the one that matters.';

-- Idempotent auto-creation. A provider redelivers webhooks; without this a dispute
-- reminder would open a second ticket for the same dispute every time it arrived.
create unique index if not exists support_tickets_external_uq
  on public.support_tickets (kind, external_ref) where external_ref is not null;

create index if not exists support_tickets_open_idx
  on public.support_tickets (status, due_at) where status in ('open', 'waiting');
create index if not exists support_tickets_farm_idx
  on public.support_tickets (farm_id, opened_at desc);

-- ── Who may read it ─────────────────────────────────────────────────────────
-- Rapid Rise only. A ticket carries another farm's billing detail and, for a dispute, the
-- bank's claim about a person — none of which belongs to the farm being discussed, let
-- alone to any other.

alter table public.support_tickets enable row level security;
alter table public.support_tickets force row level security;

drop policy if exists support_tickets_sel on public.support_tickets;
create policy support_tickets_sel on public.support_tickets
  for select to authenticated
  using (app.is_rr_admin());

-- Explicit revoke BEFORE the grant: `0102_grants.sql` sets ALTER DEFAULT PRIVILEGES for
-- `authenticated`, so a new table arrives already granted and a migration that merely says
-- "we do not grant this" is true of itself and false of the database. SECURITY.md §2b.
revoke all on public.support_tickets from anon, authenticated;
grant select on public.support_tickets to authenticated;
grant select, insert, update on public.support_tickets to service_role;

drop trigger if exists support_tickets_audit on public.support_tickets;
create trigger support_tickets_audit
  after insert or update or delete on public.support_tickets
  for each row execute function app_audit();

-- ── The evidence ────────────────────────────────────────────────────────────
-- Assembled once, at open time. The point of the whole feature: whoever picks this up
-- should not have to reassemble the case from Paystack's dashboard and six of our tables.

create or replace function app.support_ticket_evidence(
  p_farm uuid, p_invoice uuid, p_payment uuid
) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'gathered_at', now(),

    'farm', (
      select jsonb_build_object(
        'id', f.id, 'name', f.name, 'status', f.status,
        'plan', f.plan, 'billing_period', f.billing_period,
        'billing_email', f.billing_email)
        from public.farms f where f.id = p_farm
    ),

    -- Who to talk to. The owner is the person who signed up and holds the card.
    'owner', (
      select jsonb_build_object('name', u.name, 'email', u.email, 'phone', u.phone)
        from public.users u
       where u.farm_id = p_farm and u.role = 'owner' and u.deleted_at is null
       order by u.created_at limit 1
    ),

    'subscription', (
      select jsonb_build_object(
        'id', s.id, 'plan', s.plan, 'billing_period', s.billing_period,
        'status', s.status, 'asset_quota', s.asset_quota,
        'current_period_start', s.current_period_start,
        'current_period_end', s.current_period_end,
        'next_billing_on', s.next_billing_on,
        'cancel_at_period_end', s.cancel_at_period_end,
        'ended_on', s.ended_on,
        'failed_attempt_count', s.failed_attempt_count)
        from public.billing_subscriptions s
       where s.farm_id = p_farm and s.deleted_at is null limit 1
    ),

    'invoice', (
      select jsonb_build_object(
        'id', i.id, 'ref', i.invoice_ref, 'status', i.status,
        'period_start', i.period_start, 'period_end', i.period_end,
        'plan', i.plan, 'asset_count', i.asset_count,
        'unit_price_incl_cents', i.unit_price_incl_cents,
        'months_charged', i.months_charged,
        'total_incl_cents', i.total_incl_cents,
        'amount_paid_cents', i.amount_paid_cents,
        'issued_on', i.issued_on, 'due_on', i.due_on)
        from public.billing_invoices i where i.id = p_invoice
    ),

    -- Every payment on that invoice, refunds included. A refund is a NEGATIVE row
    -- (20260911210000), so this is also how "have we already given some back?" is answered
    -- — the single most common question on a refund request.
    'payments', (
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'amount_incl_cents', p.amount_incl_cents,
        'paid_at', p.paid_at, 'channel', p.channel,
        'provider_reference', p.provider_reference,
        'provider_transaction_id', p.provider_transaction_id,
        'is_refund', p.amount_incl_cents < 0) order by p.paid_at)
        from public.billing_payments p
       where p.invoice_id = p_invoice and p.deleted_at is null
    ),

    -- The card, as a human recognises it. NEVER `authorization_code`: that is the
    -- credential that charges it, and this object travels to another system.
    --
    -- Found by running it, twice. First: a dispute webhook names a TRANSACTION, not one of
    -- our payment rows, so `p_payment` is null on the path that matters most. Then: the
    -- attempt behind that payment had `payment_method_id` NULL anyway, because a first
    -- payment goes through HOSTED CHECKOUT, where the card is captured during the
    -- transaction rather than charged from one we already hold.
    --
    -- "Is this the card they say they do not recognise?" is the first question asked on a
    -- dispute, so it falls back to the card on file for the farm. But it SAYS WHICH IT IS:
    -- `source` is 'charged' only when the card is genuinely the one that attempt used, and
    -- 'farm_default' when it is merely the card we hold. Presenting the second as the first
    -- would be handing somebody an identification they did not make, in a case that may end
    -- with a person being told their card was used without permission.
    'card', coalesce(
      (
        select jsonb_build_object(
          'source', 'charged',
          'brand', m.card_brand, 'last4', m.last4,
          'exp_month', m.exp_month, 'exp_year', m.exp_year,
          'bank', m.bank, 'country_code', m.country_code)
          from public.billing_payment_methods m
          join public.billing_payment_attempts a on a.payment_method_id = m.id
          join public.billing_payments pay on pay.attempt_id = a.id
         where pay.id = coalesce(
                 p_payment,
                 (select p2.id from public.billing_payments p2
                   where p2.invoice_id = p_invoice and p2.deleted_at is null
                     -- A refund is a NEGATIVE row (20260911210000); the card is on the charge.
                     and p2.amount_incl_cents > 0
                   order by p2.paid_at desc limit 1))
         limit 1
      ),
      (
        select jsonb_build_object(
          'source', 'farm_default',
          'brand', m.card_brand, 'last4', m.last4,
          'exp_month', m.exp_month, 'exp_year', m.exp_year,
          'bank', m.bank, 'country_code', m.country_code)
          from public.billing_payment_methods m
         where m.farm_id = p_farm and m.deleted_at is null and m.status = 'active'
         order by m.is_default desc, m.created_at desc
         limit 1
      )
    ),

    'attempts', (
      select jsonb_agg(jsonb_build_object(
        'attempt_ref', a.attempt_ref, 'kind', a.kind, 'status', a.status,
        'amount_incl_cents', a.amount_incl_cents,
        'gateway_response', a.gateway_response,
        'failure_reason', a.failure_reason,
        'requested_at', a.requested_at, 'resolved_at', a.resolved_at)
        order by a.requested_at)
        from public.billing_payment_attempts a where a.invoice_id = p_invoice
    ),

    -- How many vehicles they were being billed for, which is what "what am I paying for?"
    -- actually means on this product.
    'vehicles_billed', (
      select count(*) from public.machines m
       where m.farm_id = p_farm and m.deleted_at is null
         and m.status not in ('retired', 'sold')
    )
  ));
$$;

comment on function app.support_ticket_evidence(uuid, uuid, uuid) is
  'Every fact a person needs to decide a refund, gathered at open time. Deliberately '
  'excludes billing_payment_methods.authorization_code — the charging credential — because '
  'this object leaves the building.';

-- ── Opening one ─────────────────────────────────────────────────────────────

create or replace function app.open_support_ticket(
  p_kind         support_ticket_kind,
  p_subject      text,
  p_farm         uuid default null,
  p_invoice      uuid default null,
  p_payment      uuid default null,
  p_external_ref text default null,
  p_source_event uuid default null,
  p_due_at       timestamptz default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if p_subject is null or btrim(p_subject) = '' then
    raise exception 'open_support_ticket: a subject is required';
  end if;

  insert into public.support_tickets (
    kind, subject, farm_id, invoice_id, payment_id, external_ref, source_event, due_at,
    evidence
  )
  values (
    p_kind, btrim(p_subject), p_farm, p_invoice, p_payment, p_external_ref, p_source_event,
    p_due_at, app.support_ticket_evidence(p_farm, p_invoice, p_payment)
  )
  -- A redelivered webhook must not open a second ticket. It refreshes the deadline and the
  -- link to the newest event, and deliberately does NOT touch `evidence`: the first
  -- gathering is the one contemporaneous with the complaint, and overwriting it would
  -- quietly rewrite the record the decision gets made on.
  on conflict (kind, external_ref) where external_ref is not null
  do update set
    due_at       = coalesce(excluded.due_at, public.support_tickets.due_at),
    source_event = coalesce(excluded.source_event, public.support_tickets.source_event),
    updated_at   = now()
  returning id into v_id;

  return v_id;
end $$;

comment on function app.open_support_ticket(support_ticket_kind, text, uuid, uuid, uuid, text, uuid, timestamptz) is
  'Open a ticket with its evidence already gathered. Idempotent on (kind, external_ref), so '
  'a redelivered webhook refreshes one ticket rather than opening another — and never '
  'rewrites the evidence, which is contemporaneous with the complaint.';

-- ── What is overdue ─────────────────────────────────────────────────────────
-- The nightly chase. A dispute answered late is a dispute lost by default, and the only
-- thing standing between that and a single 3am alert was somebody remembering.

create or replace function app.due_support_escalations(p_within interval default interval '12 hours')
returns table (
  id uuid, kind support_ticket_kind, subject text, farm_id uuid,
  due_at timestamptz, hours_left numeric, escalated_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp as $$
  select t.id, t.kind, t.subject, t.farm_id, t.due_at,
         round(extract(epoch from (t.due_at - now())) / 3600.0, 1),
         t.escalated_at
    from public.support_tickets t
   where t.status in ('open', 'waiting')
     and t.due_at is not null
     and t.due_at <= now() + greatest(p_within, interval '0')
     -- Chased at most once a day. A deadline that shouts every hour gets muted, and a
     -- muted alarm is worse than none.
     and (t.escalated_at is null or t.escalated_at < now() - interval '20 hours')
   order by t.due_at;
$$;

create or replace function app.escalate_support_tickets(p_within interval default interval '12 hours')
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; v_n integer := 0;
begin
  for r in select * from app.due_support_escalations(p_within) loop
    -- Rapid Rise, and only Rapid Rise. The farm does not need to hear about our deadline,
    -- and for a dispute the farm may be the party that raised it.
    perform app.notify_rr_billing(
      r.farm_id,
      'support_ticket_due',
      jsonb_build_object(
        'ticket_id', r.id,
        'kind', r.kind::text,
        'subject', r.subject,
        'due_at', r.due_at,
        'hours_left', r.hours_left)
    );
    update public.support_tickets set escalated_at = now(), updated_at = now() where id = r.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

comment on function app.escalate_support_tickets(interval) is
  'Chase tickets whose deadline is near, at most once a day each. A dispute answered late '
  'is a dispute lost by default.';

-- ── The wrappers PostgREST can reach ────────────────────────────────────────
-- Engines live in `app`, which PostgREST does not expose, so each needs a thin public
-- wrapper or the call resolves to no function at all — the failure that silently broke the
-- entire charging path (suite section (m)).

create or replace function public.open_support_ticket(
  p_kind support_ticket_kind, p_subject text, p_farm uuid default null,
  p_invoice uuid default null, p_payment uuid default null,
  p_external_ref text default null, p_source_event uuid default null,
  p_due_at timestamptz default null
) returns uuid
language sql security definer set search_path = public, pg_temp as $$
  select app.open_support_ticket(p_kind, p_subject, p_farm, p_invoice, p_payment,
                                 p_external_ref, p_source_event, p_due_at);
$$;

create or replace function public.cron_escalate_support_tickets() returns integer
language sql security definer set search_path = public, pg_temp as $$
  select app.escalate_support_tickets(interval '12 hours');
$$;

-- The engines grant to NOBODY; only the public wrappers grant, and only to `service_role`.
-- A browser able to open a ticket could forge a refund request against another farm and
-- attach its billing detail to something a person will read and act on.
revoke execute on function app.support_ticket_evidence(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke execute on function app.open_support_ticket(support_ticket_kind, text, uuid, uuid, uuid, text, uuid, timestamptz) from public, anon, authenticated, service_role;
revoke execute on function app.due_support_escalations(interval) from public, anon, authenticated, service_role;
revoke execute on function app.escalate_support_tickets(interval) from public, anon, authenticated, service_role;

revoke execute on function public.open_support_ticket(support_ticket_kind, text, uuid, uuid, uuid, text, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.cron_escalate_support_tickets() from public, anon, authenticated;
grant  execute on function public.open_support_ticket(support_ticket_kind, text, uuid, uuid, uuid, text, uuid, timestamptz) to service_role;
grant  execute on function public.cron_escalate_support_tickets() to service_role;
