-- 0380_partner_business_profile.sql
-- F14a — Partner business profile & branding (the AutoVault `workshop_branding_settings`
-- + `workshop_accounts` billing columns, folded onto FleetWise's existing `workshops`
-- spine rather than a parallel table).
--
-- WHY ON `workshops` AND NOT A NEW TABLE. AutoVault split branding into its own row
-- because its `workshop_accounts` predates it. Here a workshop already IS the partner
-- account (0002/0300/0320) and every one of these columns is 1:1 with it, so a second
-- table would buy nothing but a join and a "which row is authoritative" question. RLS,
-- audit (0008 workshops_audit) and grants therefore come along for free.
--
-- WHAT IT UNLOCKS. Documents a partner sends to a farmer (0381) are rendered in the
-- partner's own colours, wordmark and business details — not ours. A partner using their
-- own accounting package still gets value: they upload their existing PDF and the same
-- fields drive how it is presented and reconciled.
--
-- THE ONE POLICY CHANGE. Until now `workshops` was rr_admin-write-only (0101). A partner
-- must be able to maintain its own letterhead, so this adds a self-update policy —
-- deliberately NARROW: a workshop may update only its OWN row, and a guard trigger
-- rejects any attempt to change `plan` (the paid tier) or `id` from that path. Only
-- rr_admin still sets the plan, so there is no self-upgrade. Insert/delete stay
-- rr_admin-only.

-- ── Business identity, banking, letterhead, document defaults ─────
alter table workshops
  -- Identity as it must appear on a document (falls back to `name` when blank).
  add column trading_name        text,
  add column reg_number          text,   -- company / CK registration
  add column vat_number          text,   -- SARS VAT number; blank = not VAT registered
  add column address             text,   -- multi-line postal/physical address
  add column website             text,
  -- Banking, for the "how to pay us" block on an invoice.
  add column bank_name           text,
  add column bank_account_name   text,
  add column bank_account_number  text,
  add column bank_branch_code    text,
  add column bank_account_type   text,
  -- Letterhead. Colours are stored as CSS hex so the same value drives the on-screen
  -- preview, the print stylesheet and the PDF (parsed to RGB server-side).
  add column logo_path           text,   -- object key in the `partner-branding` bucket
  add column brand_primary       text not null default '#166534',
  add column brand_secondary     text not null default '#1f2937',
  add column show_powered_by     boolean not null default true,
  -- Document defaults.
  add column doc_prefix_quote    text not null default 'QTE',
  add column doc_prefix_invoice  text not null default 'INV',
  add column next_quote_no       int  not null default 1,
  add column next_invoice_no     int  not null default 1,
  add column quote_validity_days   int not null default 14,
  add column invoice_terms_days    int not null default 30,
  add column default_vat_rate_bps  int not null default 1500,  -- SA standard rate
  add column doc_terms           text,   -- standing terms printed on every document
  add column doc_footer          text;   -- one-line footer (e.g. "E&OE")

alter table workshops
  add constraint workshops_brand_primary_ck   check (brand_primary   ~ '^#[0-9a-fA-F]{6}$'),
  add constraint workshops_brand_secondary_ck check (brand_secondary ~ '^#[0-9a-fA-F]{6}$'),
  add constraint workshops_vat_rate_ck        check (default_vat_rate_bps between 0 and 10000),
  add constraint workshops_doc_days_ck        check (quote_validity_days >= 0 and invoice_terms_days >= 0);

comment on column workshops.trading_name is
  'Name printed on quotes/invoices. Falls back to workshops.name when blank.';
comment on column workshops.brand_primary is
  'CSS hex; drives the partner''s document header on screen, in print and in the PDF.';
comment on column workshops.next_invoice_no is
  'Next sequence number for this partner''s invoices. Allocated atomically by '
  'app.next_document_number() so two staff issuing at once cannot collide.';

-- ── Atomic per-partner document numbering ────────────────────────
-- A partner's numbering must be theirs (INV-0001 for each, not a global sequence), must
-- never repeat, and must survive two people pressing "issue" at the same second. A
-- counter column plus an UPDATE ... RETURNING under a row lock gives exactly that
-- without a sequence per workshop.
create or replace function app.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_no     int;
  v_prefix text;
begin
  if p_kind = 'quote' then
    update workshops set next_quote_no = next_quote_no + 1
      where id = p_workshop
      returning next_quote_no - 1, doc_prefix_quote into v_no, v_prefix;
  else
    update workshops set next_invoice_no = next_invoice_no + 1
      where id = p_workshop
      returning next_invoice_no - 1, doc_prefix_invoice into v_no, v_prefix;
  end if;

  if v_no is null then
    raise exception 'unknown workshop %', p_workshop;
  end if;
  return coalesce(nullif(v_prefix, ''), 'DOC') || '-' || lpad(v_no::text, 4, '0');
end $$;

revoke execute on function app.next_document_number(uuid, text) from public, anon;
grant  execute on function app.next_document_number(uuid, text) to authenticated, service_role;

-- PostgREST only exposes `public`, so the app reaches the allocator through a wrapper —
-- which is also where the "only your own numbering" check lives. Without it a signed-in
-- partner could burn another partner's sequence; the counter is not secret, but it is
-- theirs.
create or replace function public.next_document_number(p_workshop uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not (app.is_rr_admin() or p_workshop = app.user_workshop_id()) then
    raise exception 'not your numbering sequence';
  end if;
  if p_kind not in ('quote', 'invoice') then
    raise exception 'unknown document kind %', p_kind;
  end if;
  return app.next_document_number(p_workshop, p_kind);
end $$;

revoke execute on function public.next_document_number(uuid, text) from public, anon;
grant  execute on function public.next_document_number(uuid, text) to authenticated, service_role;

-- ── A partner may maintain its own letterhead — and nothing else ──
create policy workshops_upd_self on workshops for update to authenticated
  using  (id = app.user_workshop_id())
  with check (id = app.user_workshop_id());

-- The policy cannot express "every column except `plan`", so a guard trigger does. It
-- fires for everyone and lets rr_admin through, which keeps the RR console working.
create or replace function app_workshop_guard_plan() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.plan is distinct from old.plan and not app.is_rr_admin() then
    raise exception 'the partner plan is set by Rapid Rise, not by the partner';
  end if;
  return new;
end $$;

create trigger workshops_guard_plan
  before update on workshops
  for each row execute function app_workshop_guard_plan();

revoke execute on function app_workshop_guard_plan() from anon, authenticated, public;
