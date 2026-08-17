-- 0500_credit_limit_is_honoured.sql
-- A credit limit that the product actually uses.
--
-- `partner_clients.credit_limit_cents` has existed since 0410. It is asked for on the client
-- form, stored, and read back into that form — and then nothing has ever compared a
-- customer's outstanding balance against it. Only a sanity constraint (>= 0) touched it.
--
-- That is the third time this audit has found the same shape: a setting the product asks
-- for and then disregards (0490 was VAT-claimable on the purchase side, 0491 was supplier
-- payment terms). It is the worst of the three possible states — an absent setting is
-- obvious and a wrong one is visible, but a setting that is captured and ignored buys trust
-- the output has not earned. Somebody types "R50 000" against a customer, believes the
-- system is watching it, and it never was.
--
-- ── Warn, never block ────────────────────────────────────────────────────────
--
-- Deliberate, and the same call 0430 made for missing receipts. Refusing to raise an
-- invoice because a customer is over their limit stops legitimate work: the limit is a
-- credit-control guideline, not a legally enforceable ceiling, and the partner standing in
-- front of the customer is better placed to judge one job than a trigger is. So the
-- exposure is computed here and surfaced everywhere the decision is actually made, and
-- nothing is refused. A DB guard would also be the wrong place: it would fire on the
-- document totals trigger, long after the person chose to do the work.
--
-- ── Why outstanding must be defined ONCE ─────────────────────────────────────
--
-- This reuses `app.partner_debtors`' definition of "owed" exactly — issued invoices only
-- (never a draft, void, cancelled or written-off one), less payments received and credit
-- notes raised, floored at zero. If this function invented its own arithmetic, the client
-- page and the debtors list on /money would disagree about the same customer in the same
-- week, and both would then be useless. That is the lesson G14 pinned for the P&L and the
-- VAT return, applied here before it can go wrong.
--
-- SECURITY INVOKER on purpose: passing another workshop's id is answered by RLS on
-- partner_documents and partner_clients, not by a check somebody has to remember to write.

-- ── Exposure for one client ──────────────────────────────────────────────────
-- Attribution covers both recipient kinds: a document addressed directly to this client
-- record, and one addressed to the FleetWise farm that this client record is linked to
-- (F15 sets `partner_clients.farm_id` when a customer is also a farm on the platform).
-- Without the second arm, a partner who invoices a linked farm would show zero exposure
-- against a limit they had set on that same customer.
create or replace function app.partner_client_exposure(
  p_workshop uuid,
  p_client   uuid,
  p_as_at    date default current_date
)
returns table (
  has_limit        boolean,
  limit_cents      bigint,
  outstanding_cents bigint,
  over_cents       bigint,
  pct_used         numeric
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with client as (
    select c.id, c.farm_id, c.credit_limit_cents
      from partner_clients c
     where c.id = p_client
       and c.workshop_id = p_workshop
       and c.deleted_at is null
  ),
  invoices as (
    select d.id,
           d.total_cents,
           coalesce((select sum(p.amount_cents) from partner_payments p
                      where p.document_id = d.id and p.deleted_at is null
                        and p.paid_on <= p_as_at), 0)
         + coalesce((select sum(cn.total_cents) from partner_documents cn
                      where cn.corrects_document_id = d.id and cn.kind = 'credit_note'
                        and cn.deleted_at is null
                        and cn.status not in ('draft', 'void', 'cancelled')
                        and cn.issue_date <= p_as_at), 0) as settled
      from partner_documents d
      join client c on true
     where d.workshop_id = p_workshop
       and d.kind = 'invoice'
       and d.deleted_at is null
       -- Same exclusions as app.partner_debtors. A written-off invoice left the ageing on
       -- purpose (G5), so it must not sit against a live credit limit either.
       and d.status not in ('draft', 'void', 'cancelled', 'written_off')
       and d.issue_date <= p_as_at
       and (
         d.partner_client_id = c.id
         or (c.farm_id is not null and d.farm_id = c.farm_id)
       )
  ),
  owed as (
    select coalesce(sum(greatest(total_cents - settled, 0)), 0)::bigint as total
      from invoices
  )
  select (c.credit_limit_cents is not null)                                as has_limit,
         coalesce(c.credit_limit_cents, 0)::bigint                        as limit_cents,
         o.total                                                          as outstanding_cents,
         case when c.credit_limit_cents is null then 0::bigint
              else greatest(o.total - c.credit_limit_cents, 0)::bigint end as over_cents,
         case when coalesce(c.credit_limit_cents, 0) = 0 then null
              else round((o.total::numeric / c.credit_limit_cents) * 100, 1) end as pct_used
    from client c cross join owed o;
$$;

comment on function app.partner_client_exposure(uuid, uuid, date) is
  'What this customer currently owes against the credit limit filed on their client record '
  '(0410, honoured from 0500). "Owed" is app.partner_debtors'' definition exactly, so the '
  'client page and /money cannot disagree. Attributes documents addressed to the client AND '
  'to its linked farm. ADVISORY: nothing is blocked - see the migration header.';

-- ── Every client at or over their limit, for the money screens ───────────────
-- Built FROM the per-client function rather than repeating its query, so a figure on the
-- list can never disagree with the same figure on the client's own page.
create or replace function app.partner_over_limit(
  p_workshop uuid,
  p_as_at    date default current_date
)
returns table (
  client_id        uuid,
  client_name      text,
  limit_cents      bigint,
  outstanding_cents bigint,
  over_cents       bigint,
  pct_used         numeric
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select c.id,
         coalesce(nullif(btrim(c.name), ''), '—'),
         e.limit_cents,
         e.outstanding_cents,
         e.over_cents,
         e.pct_used
    from partner_clients c
    cross join lateral app.partner_client_exposure(p_workshop, c.id, p_as_at) e
   where c.workshop_id = p_workshop
     and c.deleted_at is null
     and e.has_limit
     and e.outstanding_cents > 0
   order by e.over_cents desc, e.outstanding_cents desc;
$$;

comment on function app.partner_over_limit(uuid, date) is
  'Clients with a filed credit limit and something outstanding, worst overrun first. Built '
  'from app.partner_client_exposure so a total here cannot differ from the client page.';

-- ── PostgREST wrappers (the app calls these) ─────────────────────────────────
create or replace function public.partner_client_exposure(
  p_workshop uuid, p_client uuid, p_as_at date default current_date
) returns table (
  has_limit boolean, limit_cents bigint, outstanding_cents bigint,
  over_cents bigint, pct_used numeric
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_client_exposure(p_workshop, p_client, p_as_at);
$$;

create or replace function public.partner_over_limit(
  p_workshop uuid, p_as_at date default current_date
) returns table (
  client_id uuid, client_name text, limit_cents bigint,
  outstanding_cents bigint, over_cents bigint, pct_used numeric
)
language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_over_limit(p_workshop, p_as_at);
$$;

revoke execute on function app.partner_client_exposure(uuid, uuid, date) from public, anon;
revoke execute on function app.partner_over_limit(uuid, date)            from public, anon;
revoke execute on function public.partner_client_exposure(uuid, uuid, date) from public, anon;
revoke execute on function public.partner_over_limit(uuid, date)            from public, anon;

grant execute on function app.partner_client_exposure(uuid, uuid, date) to authenticated, service_role;
grant execute on function app.partner_over_limit(uuid, date)            to authenticated, service_role;
grant execute on function public.partner_client_exposure(uuid, uuid, date) to authenticated, service_role;
grant execute on function public.partner_over_limit(uuid, date)            to authenticated, service_role;
