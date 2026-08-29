-- 0510_accounting_export_and_audit_location.sql
-- Two things the product asked for and never delivered: a way to hand the books to an
-- accounting package (FR-17.2), and WHERE an audited action happened (FR-1.4).
--
-- ═════════════════════════════════════════════════════════════════════════════
-- PART A — THE ACCOUNTING EXPORT (FR-17.2)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── What this is NOT ────────────────────────────────────────────────────────
--
-- It is NOT a live Sage/Xero integration. That needs OAuth applications registered in
-- the founder's name and would ship inert, exactly like the PayFast adapter (0435) has
-- since it was written. This is file export, which works the day it ships.
--
-- It is also NOT a "Sage CSV" or a "Xero CSV", and that is a deliberate, evidenced
-- decision rather than an omission. Both vendors' native journal-import column sets were
-- researched before this was written and NEITHER could be established from a primary
-- source: Xero Central renders its help through JavaScript and returns no readable
-- column list to a fetch, Sage's own journal-import help pages 404 across the en-us,
-- en-za and en-ca paths, and every remaining "documented" header set found belongs to a
-- THIRD-PARTY importer (SaasAnt, PostTrans, EntryRocket) whose field names are its own,
-- not the vendor's. Those three tools disagree with each other, which is itself the
-- evidence: `Narration/Manual Journal Date/Account Name/Line Amount` (SaasAnt) against
-- `THNarration/THDate/TLAccCode/TLDebit/TLCredit` (PostTrans).
--
-- Shipping a plausible guess would fail at the accountant's desk months later and look
-- like our fault. So this ships the GENERIC double-entry journal, in the shape every
-- package's import wizard can map in one sitting, and the screen says plainly that it is
-- generic and why. If somebody later obtains a current vendor template from the vendor,
-- adding a named variant is a formatting change in src/lib/accounting.ts and touches
-- none of the arithmetic below.
--
-- ── Why the arithmetic is in SQL ────────────────────────────────────────────
--
-- The same reason 0413/0431/0460 are: the screen, the CSV and any later PDF or emailed
-- copy must not be able to disagree. A figure computed in a React component exists in
-- one place only until somebody adds an export — and this IS the export, so a third
-- number would appear beside the two a partner already reads on /money and /vat.
--
-- ── It must reconcile, and that is asserted ─────────────────────────────────
--
-- The document selection below is copied deliberately from `app.partner_vat_return`
-- (0431) and `app.partner_pl` (0460): kinds invoice/credit_note/debit_note, statuses
-- sent/part_paid/paid/written_off, by `issue_date`. G33 asserts, over an identical
-- window, that
--
--     net credit to Sales          = partner_pl.revenue_ex_cents
--     net debit  to Bad debts      = partner_pl.bad_debt_ex_cents
--     net debit  to the cost accts = partner_pl.cost_cents
--     net credit to VAT output     = partner_vat_return.output_vat_cents
--     net debit  to VAT input      = partner_vat_return.input_vat_cents
--
-- and that EVERY journal entry balances on its own, not merely in total. G14 already
-- pins /money against /vat for exactly this reason; the export is the third screen the
-- same person reads in the same week.
--
-- ── The judgements this inherits, and does not re-open ──────────────────────
--
--  * A WRITTEN-OFF invoice is still revenue (G5/G6/G14, 0460). So it is journalled as a
--    normal sale, and the write-off is a SEPARATE entry — Dr Bad debts, Cr Debtors — for
--    the ex-VAT amount `partner_pl` calls bad debt. Note what is deliberately absent: no
--    VAT adjustment. Bad-debt relief is a s22 claim with its own conditions, and 0431
--    already decided this product reports it and points at it rather than quietly making
--    it. Journalling a VAT reversal here would make that claim on the partner's behalf.
--  * NON-CLAIMABLE VAT IS A COST (0460, VAT Act s17(2)). It is debited to the SAME
--    expense account as the purchase it sits on, not to VAT input — which is what makes
--    the cost reconciliation above come out and keeps SARS's ledger clean.
--  * A QUOTE IS NEVER COSTED and never journalled (F12b/0311, 0476). Neither is a draft
--    or a voided document: a draft was never a supply, and a void one should not exist.
--  * AN INVOICE ENTERS THE LEDGER EXACTLY ONCE. The farm-side journal reads
--    `cost_entries`, which is already the single no-double-count ledger (0211/0241/0311/
--    0381/0450 all funnel into it); this adds no second path and books nothing.
--
-- ── The one place the source data can disagree with itself ──────────────────
--
-- For a `built` document 0381's trigger guarantees total = (subtotal − discount) + VAT.
-- For an `uploaded` one those figures are TYPED, and nothing forces them to agree. The
-- journal follows net + VAT — because that is what /money and /vat are built from, and a
-- reconciliation that moved when somebody mistyped a total would be worthless — and puts
-- any difference on an explicit "Rounding & unallocated" line. So the debtor leg still
-- equals what the customer was actually billed, the entry still balances, and the
-- discrepancy is visible instead of absorbed.
--
-- ── The chart of accounts ───────────────────────────────────────────────────
--
-- FleetWise has no chart of accounts and should not invent one it then has to maintain.
-- The codes below are a documented DEFAULT in a conventional SA small-business range,
-- emitted alongside a stable `account_key` that the app translates for display. The
-- accountant maps them once at import; the screen shows the whole map so they can see
-- exactly what lands where before they download anything.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- PART B — WHERE, ON AN AUDIT ENTRY (FR-1.4)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `audit_log` (0008) has recorded who and when since the first week. The spec asked for
-- where and it was never built.
--
-- ── The threat model, stated plainly, because this is the dangerous shape ────
--
-- 0440 removed `public._f14_probe` from production precisely because it let a caller
-- rewrite `request.jwt.claims`, and G11 now asserts that nothing outside the test
-- harness may do so. That function was dangerous NOT because it bypassed RLS — it was
-- SECURITY INVOKER — but because every policy decides through `auth.uid()`, so moving
-- the caller to the other side of the fence made RLS answer correctly for somebody else.
--
-- This feature must not be a second one of those. Three properties keep it from being:
--
--   1. IT HAS ITS OWN NAMESPACE. `fleetwise.request_ip` / `_geo` / `_agent`. It never
--      reads, writes or falls back to `request.jwt.*`, and the values never leave the
--      five location columns added below.
--   2. `user_id` STILL COMES FROM `auth.uid()`. The trigger's attribution is untouched.
--      There is no setting that can influence it, and G33 proves it by setting a
--      plausible-looking `fleetwise.user_id` to another person's uuid and checking the
--      row still names the real actor.
--   3. NO POLICY AND NO HELPER READS THE NAMESPACE. G33 asserts this structurally, by
--      scanning `pg_policies` and every `app.*`/`public.*` function body for the string
--      — the same shape of assertion G11 uses, so the property is refused rather than
--      merely intended.
--
-- Given those three, the WORST a forged header can do is record a wrong city beside a
-- correctly-attributed action. That is the boundary, and it is the boundary on purpose:
-- an audit trail that a caller could use to become someone else is worse than no audit
-- trail, while an audit trail whose city column is occasionally wrong is still worth
-- having. It is not evidence of location; it is a signal that a human reads.
--
-- ── What is collected, and what deliberately is not ─────────────────────────
--
-- Request IP, Vercel's coarse geo headers (country / region / city) and the user agent.
-- NOT browser geolocation: this is an audit trail, not a tracker, docs/POPIA.md governs
-- what may be collected, and asking a driver's phone for GPS to log that they saved a
-- meter reading fails minimisation before it fails anything else. Latitude/longitude are
-- not stored either, though Vercel offers them, for the same reason.
--
-- ── How the value actually arrives ──────────────────────────────────────────
--
-- Two sources, in precedence order, because this product has two write paths:
--
--   1. `current_setting('fleetwise.*', true)` — an explicit per-request set_config, for
--      a caller that owns its own transaction (an RPC, a server-side job, the test
--      harness). This is the documented pattern the brief names.
--   2. PostgREST's `request.headers` bag — which is how the great majority of writes in
--      this product actually reach Postgres, since supabase-js issues one HTTP request
--      per statement and cannot hold a transaction across calls to set a GUC first.
--      `x-forwarded-for` and `user-agent` arrive on their own; Vercel's geo headers do
--      NOT (they are on the request to Vercel, not to Supabase), so the Next.js server
--      client forwards them as one `x-fleetwise-geo` header — see
--      pending/accounting/middleware.md.
--
-- Nothing here may ever break a write. A forged `X-Forwarded-For: not-an-ip` that made
-- every INSERT fail would be a denial of service delivered by an audit feature, so the
-- cast is guarded and every value is length-capped. G33 asserts that too.

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B.1 — the columns
-- ═════════════════════════════════════════════════════════════════════════════

alter table audit_log
  add column ip          inet,
  add column geo_country text,
  add column geo_region  text,
  add column geo_city    text,
  add column user_agent  text;

comment on column audit_log.ip is
  'Request IP as reported by the edge (x-forwarded-for, first hop). A SIGNAL, not '
  'evidence: it is client-supplied and can be forged. It never influences identity or '
  'visibility - see the threat model in migration 0510.';
comment on column audit_log.geo_country is
  'ISO-3166 alpha-2 country from the edge geo headers. Coarse by design (POPIA '
  'minimisation); no latitude/longitude is stored and the browser is never asked for GPS.';
comment on column audit_log.geo_region is 'Coarse region/province from the edge geo headers.';
comment on column audit_log.geo_city   is 'Coarse city from the edge geo headers.';
comment on column audit_log.user_agent is 'Request user agent, capped at 300 characters.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B.2 — resolving the context
-- ═════════════════════════════════════════════════════════════════════════════
--
-- SECURITY INVOKER and STABLE. It reads nothing but the caller's own request settings,
-- so it discloses nothing: whatever it returns, the caller sent.
--
-- Cost matters here — this runs once per audited row, and every business table is
-- audited. The early exit means a path that sets nothing (a migration, a seed, the test
-- harness) pays a handful of `current_setting` lookups and no subtransaction at all. The
-- two exception blocks only open once a value has already looked like the thing it is
-- about to be cast to, and they exist because correctness beats a microsecond: a bad
-- header must produce a null column, never a failed write.
create or replace function app.audit_context()
returns table (
  ip          inet,
  geo_country text,
  geo_region  text,
  geo_city    text,
  user_agent  text
)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare
  v_ip_txt text;
  v_geo    text;
  v_ua     text;
  v_hdr    text;
  v_json   jsonb;
  v_ip     inet;
  v_parts  text[];
begin
  -- (1) The FleetWise namespace. Its own, never `request.jwt.*`.
  v_ip_txt := nullif(btrim(coalesce(current_setting('fleetwise.request_ip',    true), '')), '');
  v_geo    := nullif(btrim(coalesce(current_setting('fleetwise.request_geo',   true), '')), '');
  v_ua     := nullif(btrim(coalesce(current_setting('fleetwise.request_agent', true), '')), '');

  -- (2) PostgREST's per-request header bag, for anything it did not cover.
  if v_ip_txt is null or v_geo is null or v_ua is null then
    v_hdr := coalesce(current_setting('request.headers', true), '');
    if left(btrim(v_hdr), 1) = '{' then
      begin
        v_json := v_hdr::jsonb;
      exception when others then
        v_json := null;
      end;
    end if;
    if v_json is not null then
      -- x-forwarded-for is a comma-separated chain; the client is the first hop.
      v_ip_txt := coalesce(v_ip_txt,
        nullif(btrim(split_part(coalesce(v_json ->> 'x-forwarded-for', ''), ',', 1)), ''));
      v_geo    := coalesce(v_geo, nullif(btrim(coalesce(v_json ->> 'x-fleetwise-geo', '')), ''));
      v_ua     := coalesce(v_ua,  nullif(btrim(coalesce(v_json ->> 'user-agent', '')), ''));
    end if;
  end if;

  -- Nothing to say. Say nothing, cheaply.
  if v_ip_txt is null and v_geo is null and v_ua is null then
    return query select null::inet, null::text, null::text, null::text, null::text;
    return;
  end if;

  -- Guarded cast. The regex rejects the obvious rubbish without opening a
  -- subtransaction; the handler catches what looks right and is not (`999.1.1.1`).
  if v_ip_txt ~ '^[0-9a-fA-F:.]{3,45}$' then
    begin
      v_ip := v_ip_txt::inet;
    exception when others then
      v_ip := null;
    end;
  end if;

  -- Geo arrives as `country/region/city`, any part possibly empty.
  v_parts := string_to_array(coalesce(v_geo, ''), '/');

  return query select
    v_ip,
    nullif(btrim(left(coalesce(v_parts[1], ''),  8)), ''),
    nullif(btrim(left(coalesce(v_parts[2], ''), 60)), ''),
    nullif(btrim(left(coalesce(v_parts[3], ''), 80)), ''),
    nullif(btrim(left(coalesce(v_ua, ''), 300)), '');
end $$;

comment on function app.audit_context() is
  'Request IP / coarse geo / user agent for an audit row, from the fleetwise.* namespace '
  'or PostgREST request.headers. Never touches identity or visibility: a forged value can '
  'only record a wrong city beside a correctly attributed action (see 0510 header, G33).';

-- G11: a function with no explicit grant defaults to EXECUTE TO PUBLIC.
revoke execute on function app.audit_context() from public, anon;
grant  execute on function app.audit_context() to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B.3 — the audit trigger now records where
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Replaces 0008's body. Everything about WHO is byte-for-byte what it was: `v_user` is
-- still `auth.uid()` and nothing else can reach it. The only change is five more columns
-- on the insert, resolved through a handler so a broken context cannot stop an audited
-- write from happening.
create or replace function app_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_user uuid;
  v_farm uuid;
  v_eid  uuid;
  v_diff jsonb;
  v_ip   inet;
  v_cty  text;
  v_reg  text;
  v_city text;
  v_ua   text;
begin
  begin v_user := auth.uid(); exception when others then v_user := null; end;

  if tg_op = 'DELETE' then
    v_farm := (to_jsonb(old) ->> 'farm_id')::uuid;
    v_eid  := (to_jsonb(old) ->> 'id')::uuid;
    v_diff := jsonb_build_object('old', to_jsonb(old));
  elsif tg_op = 'UPDATE' then
    v_farm := (to_jsonb(new) ->> 'farm_id')::uuid;
    v_eid  := (to_jsonb(new) ->> 'id')::uuid;
    v_diff := jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new));
  else
    v_farm := (to_jsonb(new) ->> 'farm_id')::uuid;
    v_eid  := (to_jsonb(new) ->> 'id')::uuid;
    v_diff := jsonb_build_object('new', to_jsonb(new));
  end if;

  begin
    select c.ip, c.geo_country, c.geo_region, c.geo_city, c.user_agent
      into v_ip, v_cty, v_reg, v_city, v_ua
      from app.audit_context() c;
  exception when others then
    v_ip := null; v_cty := null; v_reg := null; v_city := null; v_ua := null;
  end;

  insert into audit_log(farm_id, user_id, entity, entity_id, action, diff,
                        ip, geo_country, geo_region, geo_city, user_agent)
  values (v_farm, v_user, tg_table_name, v_eid, lower(tg_op), v_diff,
          v_ip, v_cty, v_reg, v_city, v_ua);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART B.4 — support access records where too
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0206's impersonate/exit rows are written by hand, not by the trigger, so without this
-- the ONE audit view in the product (admin -> farm -> support access) would render a
-- location column that is null for ever. It is also the row where "where" matters most:
-- a platform admin opening a customer's books at 02:00 from an unfamiliar city is
-- exactly the thing an audit trail exists to make visible.
--
-- Same signature, same guard, same append-only insert. SECURITY DEFINER as before.
create or replace function public.log_admin_farm_access(p_farm uuid, p_action text)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_ip   inet;
  v_cty  text;
  v_reg  text;
  v_city text;
  v_ua   text;
begin
  if not app.is_rr_admin() then
    raise exception 'only RR admin may record farm access';
  end if;

  begin
    select c.ip, c.geo_country, c.geo_region, c.geo_city, c.user_agent
      into v_ip, v_cty, v_reg, v_city, v_ua
      from app.audit_context() c;
  exception when others then
    v_ip := null; v_cty := null; v_reg := null; v_city := null; v_ua := null;
  end;

  insert into audit_log (farm_id, user_id, entity, entity_id, action, diff,
                         ip, geo_country, geo_region, geo_city, user_agent)
  values (
    p_farm, auth.uid(), 'admin_farm_access', p_farm,
    coalesce(nullif(btrim(p_action), ''), 'impersonate'),
    jsonb_build_object('admin', auth.uid(), 'at', now()),
    v_ip, v_cty, v_reg, v_city, v_ua
  );
end $$;

revoke execute on function public.log_admin_farm_access(uuid, text) from public, anon;
grant  execute on function public.log_admin_farm_access(uuid, text) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A.1 — the partner journal
-- ═════════════════════════════════════════════════════════════════════════════
--
-- SECURITY INVOKER, so RLS decides whose books these are: `partner_documents` is scoped
-- by `app.partner_doc_visible` (0381/0383), `partner_payments` follows its document and
-- `partner_expenses` is scoped to the owning workshop (0430). A partner passing a
-- rival's id gets an empty journal, not somebody else's ledger — the same shape as
-- `app.partner_pl`, and for the same reason: a check in a function body is a check
-- somebody can forget to write.
--
-- `entry_key` groups the lines of one double-entry transaction. Every group balances on
-- its own; G33 asserts that, not merely that the file balances in total, because a file
-- that balances overall while two entries are wrong in opposite directions imports
-- cleanly and is still wrong.
create or replace function app.partner_journal(
  p_workshop uuid,
  p_from     date,
  p_to       date
) returns table (
  entry_date   date,
  entry_key    text,     -- groups the lines of one transaction
  entry_ref    text,     -- what a human calls it: the document/supplier reference
  line_no      int,
  account_code text,
  account_key  text,     -- stable slug; the app renders the translated account name
  party        text,     -- customer or supplier, for the accountant's narrative
  description  text,
  debit_cents  bigint,
  credit_cents bigint,
  vat_code     text,     -- STD | ZERO | NONE | INPUT
  vat_rate_bps int,
  source_kind  text,
  source_id    uuid
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with docs as (
    select d.id,
           d.number,
           d.kind,
           d.status,
           d.issue_date,
           d.vat_rate_bps,
           coalesce(nullif(btrim(d.bill_to_name), ''), '-') as party,
           -- The sign that turns a credit note into the reversal it is.
           (case when d.kind = 'credit_note' then -1 else 1 end)
             * greatest(0, d.subtotal_cents - least(d.discount_cents, d.subtotal_cents)) as net_cents,
           (case when d.kind = 'credit_note' then -1 else 1 end) * d.vat_cents   as vat_cents,
           (case when d.kind = 'credit_note' then -1 else 1 end) * d.total_cents as total_cents
      from partner_documents d
     where d.workshop_id = p_workshop
       and d.deleted_at is null
       -- Copied from app.partner_vat_return / app.partner_pl. If these three ever
       -- diverge the export stops agreeing with the two screens beside it.
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('sent', 'part_paid', 'paid', 'written_off')
       and d.issue_date between p_from and p_to
  ),
  doc_lines as (
    -- Dr Debtors, Cr Sales, Cr VAT output. Signs flip themselves for a credit note.
    select d.issue_date, 'doc:' || d.id::text as k, d.number as ref, 1 as ln,
           '1100' as code, 'receivable' as akey, d.party, d.kind::text as descr,
           greatest(d.total_cents, 0) as dr, greatest(-d.total_cents, 0) as cr,
           'NONE' as vcode, d.vat_rate_bps, 'document' as skind, d.id as sid
      from docs d where d.total_cents <> 0
    union all
    select d.issue_date, 'doc:' || d.id::text, d.number, 2,
           '4000', 'sales', d.party, d.kind::text,
           greatest(-d.net_cents, 0), greatest(d.net_cents, 0),
           case when d.vat_rate_bps > 0 then 'STD' else 'ZERO' end, d.vat_rate_bps, 'document', d.id
      from docs d where d.net_cents <> 0
    union all
    select d.issue_date, 'doc:' || d.id::text, d.number, 3,
           '2200', 'vatOutput', d.party, d.kind::text,
           greatest(-d.vat_cents, 0), greatest(d.vat_cents, 0),
           'STD', d.vat_rate_bps, 'document', d.id
      from docs d where d.vat_cents <> 0
    union all
    -- Only ever produced when an UPLOADED document's typed total disagrees with its own
    -- net + VAT. Visible rather than absorbed: see the migration header.
    select d.issue_date, 'doc:' || d.id::text, d.number, 4,
           '9999', 'rounding', d.party, d.kind::text,
           greatest(-(d.total_cents - d.net_cents - d.vat_cents), 0),
           greatest( (d.total_cents - d.net_cents - d.vat_cents), 0),
           'NONE', d.vat_rate_bps, 'document', d.id
      from docs d where (d.total_cents - d.net_cents - d.vat_cents) <> 0
    union all
    -- The write-off, as its OWN entry. The sale above stays exactly where it was.
    -- Ex-VAT, and with no VAT reversal: s22 relief is a separate claim (0431).
    select d.issue_date, 'wo:' || d.id::text, d.number, 1,
           '6100', 'badDebt', d.party, 'written_off',
           greatest(d.net_cents, 0), greatest(-d.net_cents, 0),
           'NONE', d.vat_rate_bps, 'write_off', d.id
      from docs d where d.status = 'written_off' and d.net_cents <> 0
    union all
    select d.issue_date, 'wo:' || d.id::text, d.number, 2,
           '1100', 'receivable', d.party, 'written_off',
           greatest(-d.net_cents, 0), greatest(d.net_cents, 0),
           'NONE', d.vat_rate_bps, 'write_off', d.id
      from docs d where d.status = 'written_off' and d.net_cents <> 0
  ),
  pays as (
    select p.id, p.paid_on, p.amount_cents, d.number,
           coalesce(nullif(btrim(d.bill_to_name), ''), '-') as party
      from partner_payments p
      join partner_documents d on d.id = p.document_id
     where d.workshop_id = p_workshop
       and p.deleted_at is null
       and d.deleted_at is null
       and p.paid_on between p_from and p_to
       and p.amount_cents <> 0
  ),
  pay_lines as (
    -- Dr Bank, Cr Debtors. A refund is a negative payment (0422) and flips on its own.
    select p.paid_on, 'pay:' || p.id::text as k, p.number as ref, 1 as ln,
           '1000' as code, 'bank' as akey, p.party, 'payment' as descr,
           greatest(p.amount_cents, 0) as dr, greatest(-p.amount_cents, 0) as cr,
           'NONE' as vcode, 0 as rate, 'payment' as skind, p.id as sid
      from pays p
    union all
    select p.paid_on, 'pay:' || p.id::text, p.number, 2,
           '1100', 'receivable', p.party, 'payment',
           greatest(-p.amount_cents, 0), greatest(p.amount_cents, 0),
           'NONE', 0, 'payment', p.id
      from pays p
  ),
  exps as (
    select e.id,
           e.expense_date,
           e.paid_on,
           e.category,
           e.amount_cents,
           e.vat_cents,
           e.vat_claimable,
           e.vat_rate_bps,
           coalesce(nullif(btrim(e.reference), ''), '-')     as ref,
           coalesce(nullif(btrim(e.supplier_name), ''), '-') as party,
           coalesce(nullif(btrim(e.description), ''), e.category::text) as descr
      from partner_expenses e
     where e.workshop_id = p_workshop
       and e.deleted_at is null
  ),
  exp_lines as (
    -- Dr expense (plus any VAT that cannot be reclaimed - it is still a cost, 0460),
    -- Dr VAT input where it can be, Cr Creditors for what the supplier is owed.
    select e.expense_date, 'exp:' || e.id::text as k, e.ref, 1 as ln,
           '5000' as code, 'exp_' || e.category::text as akey, e.party, e.descr,
           (e.amount_cents + case when e.vat_claimable then 0 else e.vat_cents end)::bigint as dr,
           0::bigint as cr,
           case when e.vat_rate_bps > 0 then 'STD' else 'NONE' end as vcode,
           e.vat_rate_bps, 'expense' as skind, e.id as sid
      from exps e
     where e.expense_date between p_from and p_to
       and (e.amount_cents + case when e.vat_claimable then 0 else e.vat_cents end) <> 0
    union all
    select e.expense_date, 'exp:' || e.id::text, e.ref, 2,
           '2210', 'vatInput', e.party, e.descr,
           e.vat_cents::bigint, 0::bigint,
           'INPUT', e.vat_rate_bps, 'expense', e.id
      from exps e
     where e.expense_date between p_from and p_to
       and e.vat_claimable and e.vat_cents <> 0
    union all
    select e.expense_date, 'exp:' || e.id::text, e.ref, 3,
           '2000', 'payable', e.party, e.descr,
           0::bigint, (e.amount_cents + e.vat_cents)::bigint,
           'NONE', e.vat_rate_bps, 'expense', e.id
      from exps e
     where e.expense_date between p_from and p_to
       and (e.amount_cents + e.vat_cents) <> 0
    union all
    -- Dr Creditors, Cr Bank on the day the money actually left.
    select e.paid_on, 'expay:' || e.id::text, e.ref, 1,
           '2000', 'payable', e.party, e.descr,
           (e.amount_cents + e.vat_cents)::bigint, 0::bigint,
           'NONE', e.vat_rate_bps, 'expense_payment', e.id
      from exps e
     where e.paid_on between p_from and p_to
       and (e.amount_cents + e.vat_cents) <> 0
    union all
    select e.paid_on, 'expay:' || e.id::text, e.ref, 2,
           '1000', 'bank', e.party, e.descr,
           0::bigint, (e.amount_cents + e.vat_cents)::bigint,
           'NONE', e.vat_rate_bps, 'expense_payment', e.id
      from exps e
     where e.paid_on between p_from and p_to
       and (e.amount_cents + e.vat_cents) <> 0
  ),
  all_lines as (
    select * from doc_lines
    union all select * from pay_lines
    union all select * from exp_lines
  )
  -- A rank cannot be named in the ORDER BY of a UNION (0504 learned that the hard way),
  -- so the union is a subquery and the ordering happens out here.
  select l.issue_date, l.k, l.ref, l.ln, l.code, l.akey, l.party, l.descr,
         l.dr::bigint, l.cr::bigint, l.vcode, l.vat_rate_bps, l.skind, l.sid
    from all_lines l
   order by l.issue_date, l.k, l.ln;
$$;

comment on function app.partner_journal(uuid, date, date) is
  'A generic double-entry general journal for a partner over a period, from '
  'partner_documents / partner_payments / partner_expenses. Same document selection as '
  'app.partner_vat_return and app.partner_pl, so the export reconciles with /vat and '
  '/money - asserted in G33. SECURITY INVOKER: RLS decides whose books these are.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A.2 — the farm journal
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The farm side has one ledger, `cost_entries` (0210/0211), and no bank or payables of
-- its own — FleetWise records what a farm SPENT, not how it settled. A one-sided ledger
-- cannot be imported as a journal, so each cost is given a balancing contra to a
-- suspense account the accountant reallocates. That is stated on the screen rather than
-- implied, because a contra nobody explained looks like a mistake.
--
-- SECURITY INVOKER for the same reason `app.fleet_downtime` (0361) is: RLS on
-- `cost_entries` (and, through F16, `app.row_visible_to_role`) has to be the thing that
-- answers. Note what follows from that — a CONTRACTOR with an active link reads zero
-- cost entries since 0400, so this returns an empty journal for them without a single
-- line of code saying so.
--
-- One judgement, deliberately opposite to the rest of the product: RETIRED AND SOLD
-- MACHINES ARE INCLUDED. Every dashboard, report and alert excludes them (Scope §4.1),
-- and that is right for a fleet screen. It would be wrong here. Money spent on a tractor
-- that was later sold is still money the farm spent, and an export that quietly dropped
-- it would not equal the ledger it claims to export. G33 asserts it.
create or replace function app.farm_journal(
  p_farm uuid,
  p_from date,
  p_to   date
) returns table (
  entry_date   date,
  entry_key    text,
  entry_ref    text,
  line_no      int,
  account_code text,
  account_key  text,
  party        text,
  description  text,
  debit_cents  bigint,
  credit_cents bigint,
  vat_code     text,
  vat_rate_bps int,
  source_kind  text,
  source_id    uuid
)
language sql stable security invoker set search_path = public, pg_temp as $$
  with entries as (
    select c.id,
           c.occurred_on,
           c.type,
           c.amount_cents,
           coalesce(c.vat_rate_bps, 0) as rate,
           coalesce(nullif(btrim(m.name), ''), '-')       as machine_name,
           coalesce(nullif(btrim(c.note), ''),
                    coalesce(nullif(btrim(c.source_type), ''), c.type::text)) as descr
      from cost_entries c
      left join machines m on m.id = c.machine_id and m.farm_id = c.farm_id
     where c.farm_id = p_farm
       and c.deleted_at is null
       and c.occurred_on between p_from and p_to
       and c.amount_cents <> 0
  ),
  lines as (
    select e.occurred_on, 'cost:' || e.id::text as k,
           coalesce(nullif(btrim(e.descr), ''), e.type::text) as ref, 1 as ln,
           case e.type
             when 'purchase' then '1600'   -- plant & machinery, an asset not an expense
             when 'finance'  then '6200'
             when 'fuel'     then '6300'
             when 'parts'    then '6400'
             when 'labour'   then '6500'
             when 'invoice'  then '6600'
             else                 '6900'
           end as code,
           'cost_' || e.type::text as akey,
           e.machine_name as party, e.descr,
           e.amount_cents::bigint as dr, 0::bigint as cr,
           case when e.rate > 0 then 'STD' else 'NONE' end as vcode,
           e.rate, 'cost_entry' as skind, e.id as sid
      from entries e
    union all
    select e.occurred_on, 'cost:' || e.id::text,
           coalesce(nullif(btrim(e.descr), ''), e.type::text), 2,
           '2000', 'contra', e.machine_name, e.descr,
           0::bigint, e.amount_cents::bigint,
           'NONE', e.rate, 'cost_entry', e.id
      from entries e
  )
  select l.occurred_on, l.k, l.ref, l.ln, l.code, l.akey, l.party, l.descr,
         l.dr::bigint, l.cr::bigint, l.vcode, l.rate, l.skind, l.sid
    from lines l
   order by l.occurred_on, l.k, l.ln;
$$;

comment on function app.farm_journal(uuid, date, date) is
  'A generic double-entry general journal for a farm over a period, from the '
  'cost_entries ledger, each cost balanced by a suspense contra. Retired and sold '
  'machines are INCLUDED - this is the books, not a fleet report. SECURITY INVOKER.';

-- ═════════════════════════════════════════════════════════════════════════════
-- PART A.3 — PostgREST wrappers + least privilege (0413/0460 pattern)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The column lists are restated rather than referenced: a function's RETURNS TABLE is
-- not a named composite type, so `returns setof app.partner_journal` does not exist.

create or replace function public.partner_journal(p_workshop uuid, p_from date, p_to date)
returns table (
  entry_date date, entry_key text, entry_ref text, line_no int,
  account_code text, account_key text, party text, description text,
  debit_cents bigint, credit_cents bigint, vat_code text, vat_rate_bps int,
  source_kind text, source_id uuid
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.partner_journal(p_workshop, p_from, p_to);
$$;

create or replace function public.farm_journal(p_farm uuid, p_from date, p_to date)
returns table (
  entry_date date, entry_key text, entry_ref text, line_no int,
  account_code text, account_key text, party text, description text,
  debit_cents bigint, credit_cents bigint, vat_code text, vat_rate_bps int,
  source_kind text, source_id uuid
) language sql stable security invoker set search_path = public, pg_temp as $$
  select * from app.farm_journal(p_farm, p_from, p_to);
$$;

-- G11 again: no explicit grant means EXECUTE TO PUBLIC, which `anon` inherits.
do $do$
declare f text;
begin
  foreach f in array array[
    'app.partner_journal(uuid,date,date)',
    'app.farm_journal(uuid,date,date)',
    'public.partner_journal(uuid,date,date)',
    'public.farm_journal(uuid,date,date)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $do$;
