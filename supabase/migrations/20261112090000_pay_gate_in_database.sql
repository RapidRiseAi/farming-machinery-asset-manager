-- 20261112090000_pay_gate_in_database.sql
-- The database itself refuses a stopped business's working data, not only the app.
--
-- == The rule ==================================================================
-- A business whose gate (app.farm_billing_gate) is not 'ok' cannot add, change or delete
-- its working data through a member's own session. A 'suspended' or 'closed' business can
-- still READ its working data, because "pay and download only" (decided 26 and 27 October
-- 2026) and the closed screen's download both read it through that session
-- (/api/farm/export); a 'pending' business, which has never paid, can neither read nor
-- write it. Paying, the account, memberships, notifications, help, closing the account,
-- handing it over and a contractor's own books stay open in every state
-- (app.pay_gate_rules below), a row with no farm (farm_id is null: the shared libraries)
-- is never stopped, and Rapid Rise is never stopped.
--
-- == Why =======================================================================
-- An audit on 12 November 2026 found the gate only in the app: (app)/layout.tsx and the
-- role helpers in src/lib/auth.ts. No row-security policy considered payment, so a member of
-- a pending, suspended or closed business could call the REST API with their own session
-- and read or write that business's rows. They could not reach anybody else's.
--
-- == How =======================================================================
-- One restrictive policy per command, FOR authenticated, on every public table that has a
-- farm_id column and row security, generated below and by app.pay_gate_apply for tables
-- added later (supabase/tests/pay_gate.sql fails until a new one is gated or listed).
-- A restrictive policy only narrows what the permissive ones already allow, so nothing
-- anybody may do today on a paid business moves.
--
--   farm_id is null or farm_id <> all (array(select app.stopped_farm_ids(<writing>)))
--
-- app.stopped_farm_ids(p_writing) answers, once per statement (the uncorrelated
-- array(select ...) is an InitPlan, the 20261111150000 pattern), which of the caller's own
-- businesses are stopped: for reading, the pending ones; for writing, every one whose gate
-- is not 'ok'. It asks app.farm_billing_gate itself for each business the caller reaches
-- (app.accessible_farm_ids: home, active memberships, active contractor links), so it
-- cannot drift from the gate the app shows, and the gate's cost is paid per business per
-- statement, never per row. Rapid Rise gets an empty set.
--
-- A business the caller does not reach is not in the set, so the policy adds nothing
-- there; the permissive policies already decide those rows.
--
-- == Who owns what, and why the gate cannot block itself =======================
-- SECURITY DEFINER functions run as their owner. Every function and table here is owned by
-- `postgres`, which has BYPASSRLS on Supabase (0008, 0100) and is the superuser locally, and
-- FORCE ROW LEVEL SECURITY binds only a table owner WITHOUT that attribute. The live
-- database proves it: audit_log is forced and has no INSERT policy for anybody, yet the
-- definer audit trigger writes it on every change. So these policies never apply inside a
-- definer function: app.stopped_farm_ids and app.farm_billing_gate read the billing tables
-- without recursing, and the billing RPCs, the closure and the handover are not blocked.
-- The same fact means a definer RPC that writes a business's rows as its owner is NOT
-- covered here and must check the gate itself (apply_offline_capture and the QR capture
-- already do). The block below refuses to run as a role that cannot bypass row security,
-- because the helper would then be judged by the policies it serves.
--
-- The *_visible views are owned by fleetwise_cost_reader, a member of authenticated without
-- BYPASSRLS (20260908112728), so these policies apply through them as on the base tables.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles
                  where rolname = current_user and (rolsuper or rolbypassrls)) then
    raise exception 'pay gate: % cannot bypass row security; apply this as the owner of the '
      'schema (postgres) so the gate helper is not judged by its own policies', current_user;
  end if;
end
$$;

-- == What stays open ===========================================================
-- A table listed 'open' is never stopped. 'contractor_open' is stopped like any other,
-- except for the contractor whose workshop the row names: a contractor's quotes, invoices
-- and client list are its own books and stay its own to keep whatever its customer owes
-- Rapid Rise (documents/actions.ts and banking/actions.ts authorise a contractor with
-- requireRole(['workshop']), never the customer's gate). Every other table with a farm_id
-- gets the full gate. Service only, like the other app bookkeeping tables.
create table if not exists app.pay_gate_rules (
  table_name text primary key,
  rule       text not null check (rule in ('open', 'contractor_open')),
  reason     text not null check (length(reason) between 1 and 300)
);
alter table app.pay_gate_rules enable row level security;
alter table app.pay_gate_rules force row level security;
revoke all on app.pay_gate_rules from public, anon, authenticated, service_role;
comment on table app.pay_gate_rules is
  'Tables a stopped business may still use (open), or that stay open to the contractor whose '
  'books they are (contractor_open). Every other public table with farm_id is gated by '
  'app.stopped_farm_ids (20261112090000).';

insert into app.pay_gate_rules (table_name, rule, reason) values
  ('billing_subscriptions',    'open', 'paying: /activate, /suspended and /closed read the subscription'),
  ('billing_invoices',         'open', 'paying: the invoice the Pay button charges, receipts and downloads'),
  ('billing_invoice_lines',    'open', 'paying: what an invoice is for'),
  ('billing_payments',         'open', 'paying: what has been paid, and refunds'),
  ('billing_payment_attempts', 'open', 'paying: a payment in flight'),
  ('billing_payment_methods',  'open', 'paying: the card on file'),
  ('billing_asset_snapshots',  'open', 'paying: what a period was billed for'),
  ('billing_webhook_events',   'open', 'paying: the payment provider''s notices (service only)'),
  ('done_for_you_quotes',      'open', 'paying: a price agreed with Rapid Rise'),
  ('users',                    'open', 'the person''s own account; farm_id is the home site, not ownership'),
  ('user_farm_memberships',    'open', 'who belongs where: every stopped screen asks it who may pay, and the site switch'),
  ('notifications',            'open', 'the person''s inbox, billing notices included; delivery already skips stopped farms'),
  ('push_subscriptions',       'open', 'the person''s devices, which carry the billing notices too'),
  ('support_tickets',          'open', 'a stopped business can still ask Rapid Rise for help'),
  ('support_visits',           'open', 'what Rapid Rise did on the account'),
  ('farm_closures',            'open', 'closing the account must never depend on paying first'),
  ('farm_closure_requests',    'open', 'closing the account (service only)'),
  ('farm_ownership_transfers', 'open', 'handing the business over'),
  ('partner_document_lines',   'open', 'a contractor''s own books: the lines of its quotes and invoices'),
  ('partner_payments',         'open', 'a contractor''s own books: money received; a farmer saying it paid is never gated'),
  ('partner_documents',          'contractor_open', 'a contractor''s quotes and invoices; the customer''s answers to them are gated'),
  ('partner_document_revisions', 'contractor_open', 'a contractor''s corrections to its documents'),
  ('document_emails',            'contractor_open', 'a contractor''s sent documents'),
  ('partner_clients',            'contractor_open', 'a contractor''s client list'),
  ('recurring_invoices',         'contractor_open', 'a contractor''s repeating invoices')
on conflict (table_name) do update set rule = excluded.rule, reason = excluded.reason;

-- == Which of the caller's businesses are stopped ===============================
-- p_writing false: the ones that may not even be read (pending). true: every one whose gate
-- is not 'ok' (pending, suspended, closed). Empty for Rapid Rise and for a session with no
-- user. Not reachable over REST (schema app); takes no business id, so it is no oracle.
create or replace function app.stopped_farm_ids(p_writing boolean)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or app.is_rr_admin() then
    return;
  end if;
  return query
    select a.farm_id
      from app.accessible_farm_ids() as a(farm_id)
     where a.farm_id is not null
       and app.farm_billing_gate(a.farm_id) = any (
             case when p_writing then array['pending', 'suspended', 'closed']
                  else array['pending'] end);
end
$$;
revoke all on function app.stopped_farm_ids(boolean) from public, anon;
grant execute on function app.stopped_farm_ids(boolean) to authenticated;
comment on function app.stopped_farm_ids(boolean) is
  'The caller''s businesses the pay gate stops: for reading (false) the pending ones, for '
  'writing (true) every one whose app.farm_billing_gate is not ok. Empty for Rapid Rise. '
  'Called once per statement by the pay_gate_* policies (20261112090000).';

-- == Gating one table ==========================================================
-- Drops and recreates the pay_gate_* policies of one public table from its rule, so it can
-- be run again. A command gets a policy only when a permissive policy lets authenticated do
-- it at all (the whatsapp_scope pattern, 20261015175415): a service-only table stays a table
-- with no policies. A migration that adds a table with farm_id calls this, or lists the
-- table in app.pay_gate_rules first.
create or replace function app.pay_gate_apply(p_table text)
returns integer
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_rel  regclass := to_regclass(format('public.%I', p_table));
  v_rule text;
  v_cmd  text;
  v_test text;
  v_made integer := 0;
begin
  if v_rel is null
     or not exists (select 1 from pg_class c where c.oid = v_rel and c.relkind in ('r', 'p') and c.relrowsecurity)
     or not exists (select 1 from pg_attribute a where a.attrelid = v_rel and a.attname = 'farm_id' and not a.attisdropped) then
    raise exception 'pay gate: public.% is not a table with row security and a farm_id', p_table
      using errcode = '22023';
  end if;

  foreach v_cmd in array array['select', 'insert', 'update', 'delete'] loop
    execute format('drop policy if exists %I on public.%I', 'pay_gate_' || v_cmd, p_table);
  end loop;

  select r.rule into v_rule from app.pay_gate_rules r where r.table_name = p_table;
  if v_rule = 'open' then
    return 0;
  end if;
  if v_rule = 'contractor_open'
     and not exists (select 1 from pg_attribute a where a.attrelid = v_rel and a.attname = 'workshop_id' and not a.attisdropped) then
    raise exception 'pay gate: public.% is contractor_open but has no workshop_id', p_table
      using errcode = '22023';
  end if;

  foreach v_cmd in array array['select', 'insert', 'update', 'delete'] loop
    if not exists (
      select 1 from pg_policies p
       where p.schemaname = 'public' and p.tablename = p_table and p.permissive = 'PERMISSIVE'
         and p.cmd in ('ALL', upper(v_cmd))
         and p.roles && array['public', 'authenticated']::name[]
    ) then
      continue;
    end if;
    v_test := format('(farm_id is null%s or farm_id <> all (array(select app.stopped_farm_ids(%s))))',
      case when v_rule = 'contractor_open' then ' or workshop_id = (select app.user_workshop_id())' else '' end,
      case when v_cmd = 'select' then 'false' else 'true' end);
    execute format('create policy %I on public.%I as restrictive for %s to authenticated %s %s',
      'pay_gate_' || v_cmd, p_table, v_cmd,
      case when v_cmd <> 'insert' then 'using ' || v_test else '' end,
      case when v_cmd in ('insert', 'update') then 'with check ' || v_test else '' end);
    v_made := v_made + 1;
  end loop;
  return v_made;
end
$fn$;
revoke all on function app.pay_gate_apply(text) from public, anon, authenticated, service_role;
comment on function app.pay_gate_apply(text) is
  'Creates (again) the restrictive pay_gate_* policies of one public table with farm_id, from '
  'app.pay_gate_rules. Run by migrations only (20261112090000).';

-- == Every table with a farm_id, now ==========================================
do $$
declare
  t record;
  v_total integer := 0;
  v_tables integer := 0;
  v_made integer;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tb
        on tb.table_schema = c.table_schema and tb.table_name = c.table_name
       and tb.table_type = 'BASE TABLE'
      join pg_class pc on pc.oid = to_regclass(format('public.%I', c.table_name))
     where c.table_schema = 'public' and c.column_name = 'farm_id' and pc.relrowsecurity
     order by c.table_name
  loop
    v_made := app.pay_gate_apply(t.table_name);
    v_total := v_total + v_made;
    if v_made > 0 then v_tables := v_tables + 1; end if;
  end loop;
  raise notice 'pay gate: % policies on % tables', v_total, v_tables;
end
$$;
