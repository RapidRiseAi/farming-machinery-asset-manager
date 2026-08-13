-- 0476_quote_conversion.sql
-- How many of the quotes I send actually turn into work.
--
-- A partner prices jobs all week and has no idea what proportion of that effort becomes
-- money. It is the one number that tells them whether to price differently, chase harder,
-- or quote less and do more — and every ingredient for it has been sitting in
-- `partner_documents` since 0381. This adds no tables and no columns.
--
-- ── Why SQL, again ──────────────────────────────────────────────────────────
--
-- Same reason as 0460, and now with a second caller: the /money card, the money CSV and
-- the money PDF all report this figure, and a conversion rate that reads 41% on screen
-- and 38% in the export is worse than no conversion rate at all. The definition below is
-- the only place it is decided.
--
-- ── WHAT "CONVERTED" MEANS, AND WHY IT IS NOT JUST THE STATUS ───────────────
--
-- The obvious implementation is `status = 'accepted'`, and it is wrong in practice. That
-- status is set by a human pressing a button on a screen; what actually happens is the
-- customer phones, says yes, and the partner goes straight to raising the invoice. The
-- quote sits at 'sent' for ever. A conversion report built on the status alone would tell
-- one of those partners they convert nothing, which is both false and the fastest way to
-- get the whole screen ignored.
--
-- So a quote counts as CONVERTED when either is true:
--
--   * an invoice has been ISSUED against it (`partner_documents.quote_id`, the link
--     progress billing already relies on — see `app.quote_billing`, 0432). You do not bill
--     a customer for work they did not agree to, so an invoice is the strongest evidence
--     of acceptance there is. Drafts do not count: a draft has not left the building, and
--     0432 makes exactly the same judgement about what has been billed.
--   * or its status says so — 'accepted', or the part_paid/paid a quote should never
--     reach but would be beyond argument if it did.
--
-- It is an OR, not an AND, in both directions: a quote marked accepted that has not been
-- invoiced yet is still converted (the customer said yes; the paperwork is behind), and a
-- quote marked declined or expired that was later invoiced against is converted too,
-- because money asked for outranks a status nobody went back to fix.
--
-- ── AND WHY "EXPIRED" IS NOT JUST THE STATUS EITHER ─────────────────────────
--
-- `app.expire_partner_quotes` (0414) moves a stale quote to 'expired', and it runs on the
-- nightly cron — which, per the handover, has never fired in production. A quote whose
-- validity date passed last March is not an open offer whether or not a scheduled job has
-- caught up with it, so the classification treats a still-'sent' quote past its `due_date`
-- as expired. Reading the pipeline as bigger than it is, is precisely the failure 0414 was
-- written to prevent.
--
-- ── THE TWO RATES ───────────────────────────────────────────────────────────
--
-- `rate_bps` divides by everything sent, which for the current month includes quotes the
-- customer has not answered yet and so reads low all month. `decided_rate_bps` divides by
-- the ones that actually got an answer (converted + declined + expired). Both are
-- reported because neither is honest alone: the first understates a young period, the
-- second flatters a partner sitting on a pile of quotes nobody ever replied to.
--
-- Basis points, integer, computed with numeric arithmetic — the house rule about floats
-- is about money, but a rate that renders as 33.329999 is its own kind of wrong.
--
-- ── VALUE IS EX-VAT ─────────────────────────────────────────────────────────
--
-- The rand figures use the same expression as `app.partner_pl`'s revenue —
-- subtotal less document discount, ex-VAT — so "R48 000 of quotes accepted" on this card
-- is directly comparable with "work invoiced" on the P&L above it. Using the VAT-inclusive
-- `total_cents` would have made the two cards on one screen quietly incomparable.

create or replace function app.partner_quote_conversion(p_workshop uuid, p_from date, p_to date)
returns table (
  sent_count       int,      -- quotes that left the building in the period
  sent_cents       bigint,   -- ex-VAT value of those
  converted_count  int,      -- accepted, or invoiced against
  converted_cents  bigint,
  declined_count   int,      -- the customer said no
  declined_cents   bigint,
  expired_count    int,      -- ran out of validity without an answer
  expired_cents    bigint,
  open_count       int,      -- still live: sent, still valid, no decision
  open_cents       bigint,
  withdrawn_count  int,      -- cancelled or voided by the partner: not a lost sale
  withdrawn_cents  bigint,
  rate_bps         int,      -- converted / sent
  decided_rate_bps int       -- converted / (converted + declined + expired)
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with quotes as (
    -- Cohort = quotes ISSUED in the window. Counting by the date a quote was accepted
    -- instead would put the numerator and the denominator in different periods, which is
    -- how a conversion rate ends up over 100%.
    select d.id, d.status, d.due_date,
           greatest(0, d.subtotal_cents - least(d.discount_cents, d.subtotal_cents)) as net_cents,
           exists (
             select 1
               from partner_documents i
              where i.quote_id = d.id
                and i.kind = 'invoice'
                and i.deleted_at is null
                and i.status not in ('draft', 'void', 'cancelled')
           ) as invoiced
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       and d.kind = 'quote'
       -- A draft was never put in front of anybody, so it is not part of the pipeline.
       and d.status <> 'draft'
       and d.issue_date between p_from and p_to
  ),
  classified as (
    -- One outcome per quote, first match wins, so the four buckets partition `sent`
    -- exactly and the parts always add back up to the whole.
    select net_cents,
           case
             when invoiced or status in ('accepted', 'part_paid', 'paid')            then 'converted'
             when status in ('void', 'cancelled')                                    then 'withdrawn'
             when status = 'declined'                                                then 'declined'
             when status = 'expired'                                                 then 'expired'
             when status = 'sent' and due_date is not null and due_date < current_date then 'expired'
             else 'open'
           end as outcome
      from quotes
  ),
  n as (
    select
      count(*) filter (where outcome <> 'withdrawn')::int                                as sent_n,
      coalesce(sum(net_cents) filter (where outcome <> 'withdrawn'), 0)::bigint          as sent_c,
      count(*) filter (where outcome = 'converted')::int                                 as conv_n,
      coalesce(sum(net_cents) filter (where outcome = 'converted'), 0)::bigint           as conv_c,
      count(*) filter (where outcome = 'declined')::int                                  as dec_n,
      coalesce(sum(net_cents) filter (where outcome = 'declined'), 0)::bigint            as dec_c,
      count(*) filter (where outcome = 'expired')::int                                   as exp_n,
      coalesce(sum(net_cents) filter (where outcome = 'expired'), 0)::bigint             as exp_c,
      count(*) filter (where outcome = 'open')::int                                      as open_n,
      coalesce(sum(net_cents) filter (where outcome = 'open'), 0)::bigint                as open_c,
      count(*) filter (where outcome = 'withdrawn')::int                                 as wd_n,
      coalesce(sum(net_cents) filter (where outcome = 'withdrawn'), 0)::bigint           as wd_c
    from classified
  )
  select
    sent_n, sent_c, conv_n, conv_c, dec_n, dec_c, exp_n, exp_c, open_n, open_c, wd_n, wd_c,
    case when sent_n = 0 then 0
         else round(conv_n::numeric * 10000 / sent_n)::int end,
    case when (conv_n + dec_n + exp_n) = 0 then 0
         else round(conv_n::numeric * 10000 / (conv_n + dec_n + exp_n))::int end
  from n;
$$;

comment on function app.partner_quote_conversion(uuid, date, date) is
  'Quote pipeline for a period: sent, converted, declined, expired, still open, withdrawn, '
  'with an ex-VAT value for each and two conversion rates in basis points. A quote counts '
  'as converted when an invoice has been issued against it OR its status says accepted — '
  'billing somebody is stronger evidence of a yes than a status field nobody updated.';

-- ── PostgREST wrapper + least privilege (0460 pattern) ──────────────────────
-- The column list is restated rather than referenced: a RETURNS TABLE is not a named
-- composite type, so `returns setof app.partner_quote_conversion` does not exist.
create or replace function public.partner_quote_conversion(p_workshop uuid, p_from date, p_to date)
returns table (
  sent_count int, sent_cents bigint, converted_count int, converted_cents bigint,
  declined_count int, declined_cents bigint, expired_count int, expired_cents bigint,
  open_count int, open_cents bigint, withdrawn_count int, withdrawn_cents bigint,
  rate_bps int, decided_rate_bps int
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_quote_conversion(p_workshop, p_from, p_to);
$$;

-- app.* is helper-only; the public wrapper is the API. SECURITY INVOKER, so passing
-- another partner's workshop id is answered by RLS on `partner_documents` — which since
-- 0381 narrows the workshop role to its OWN documents — and returns zeros rather than a
-- rival's pipeline. There is no workshop check in the body on purpose: a check written
-- here would be a second, weaker copy of a rule the database already enforces.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.partner_quote_conversion(uuid,date,date)',
    'public.partner_quote_conversion(uuid,date,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
