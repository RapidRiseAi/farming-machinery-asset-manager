-- 0480_suppliers.sql
-- The people a workshop buys from, as records rather than as typing.
--
-- `partner_expenses.supplier_name` (0430) is free text, and `purchase_orders.supplier_name`
-- (0473) inherited the same shape. That was the right call while the only thing either
-- column had to do was print back what was typed, and it stopped being right the moment
-- 0460 built a payables ageing on top of it. `app.partner_creditors` groups by
-- `btrim(supplier_name)`, so today:
--
--   * "Agri Diesel" and "Agri Diesel Depot" are TWO creditors on the same screen, and the
--     partner reading it has to add them up in their head to find out what they owe one
--     business. That is the exact failure the report exists to prevent.
--   * every typo mints a phantom creditor that will sit on the ageing for ever, because
--     nothing will ever be captured against that spelling again.
--   * nothing about a supplier can be reused. The account number, the payment terms, the
--     VAT number needed on a claim over R5 000 (VAT Act s20(4)), the phone number of the
--     person who actually answers — all of it gets retyped per invoice or, more often,
--     not captured at all.
--
-- ── Why a record and not just a tidier string ────────────────────────────────
--
-- The cheap fix is to normalise the text and group case-insensitively, and it fixes
-- precisely one of those three problems. A supplier is a business the workshop has a
-- relationship with: terms were agreed with it, an account number belongs to it, and next
-- month's order goes to it. Those facts have nowhere to live on a `text` column.
--
-- ── Scope: WORKSHOP, exactly like partner_expenses (0430) ────────────────────
--
-- Same reasoning as 0473 gives for purchase orders: who a workshop buys from, and what it
-- pays them, is the margin behind every quote it gives a farm. So this is the 0430 policy
-- set verbatim — own workshop or rr_admin, no farm path at all, anon nothing — rather
-- than anything reaching for a farm helper.

create table suppliers (
  id             uuid primary key default gen_random_uuid(),
  workshop_id    uuid not null references workshops(id) on delete cascade,

  name           text not null,
  contact_person text,                    -- the person who answers, not the switchboard
  phone          text,
  email          text,
  address        text,
  vat_number     text,                    -- theirs; needed on a claim over R5 000 (s20(4))

  -- The workshop's account number WITH this supplier — the number quoted on the phone to
  -- be told what is owed. Not an identifier of anything in this database.
  account_number text,

  -- "30 days from statement" as a number of days, nullable because cash-on-collection is
  -- an honest answer and inventing 0 or 30 for it would be a lie the ageing later repeats.
  payment_terms_days int,

  notes          text,

  -- Deactivating is not deleting. A supplier the workshop has stopped using still owns
  -- every historical expense captured against it, and those must keep aging and keep
  -- appearing on the VAT return; the flag only takes it out of the pickers. Soft delete
  -- (below) is for a record that should never have existed.
  active         boolean not null default true,

  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid,

  constraint suppliers_name_ck check (btrim(name) <> ''),
  -- A year is the outer edge of a real trade term; anything past it is a typed slip.
  constraint suppliers_terms_ck check (payment_terms_days is null or payment_terms_days between 0 and 365),
  -- Composite uniqueness so `partner_expenses` and `purchase_orders` can point at a
  -- supplier OF THE SAME WORKSHOP through a foreign key rather than through a check
  -- somebody could forget to write. The house tenancy pattern (0473, `stock_items`).
  constraint suppliers_id_workshop_uq unique (id, workshop_id)
);

-- ── One record per supplier, per workshop ────────────────────────────────────
-- Case- and whitespace-insensitive, because "Agri Diesel", "agri diesel " and "AGRI
-- DIESEL" are one business and the whole point of the feature is that they stop being
-- three. This index is also what makes the 0481 name resolution deterministic — it can
-- match at most one live supplier — and what makes the backfill idempotent.
--
-- Partial on `deleted_at` for the reason 0475 gives about its own uniqueness: a record
-- created by mistake and retracted must not block the correct one from ever being
-- created. Only LIVE duplicates are refused.
create unique index suppliers_name_uq on suppliers (workshop_id, lower(btrim(name)))
  where deleted_at is null;

create index suppliers_workshop_idx on suppliers (workshop_id, name)
  where deleted_at is null;

comment on table suppliers is
  'Who the workshop buys from (G18). Workshop-scoped, like partner_expenses and '
  'purchase_orders — a farm reading its contractor''s supplier list and terms would be '
  'reading the margin behind every quote it is given. partner_expenses.supplier_id and '
  'purchase_orders.supplier_id point here; the free-text supplier_name is kept alongside '
  'so a row is still readable when nobody has filed the supplier yet.';
comment on column suppliers.active is
  'False takes the supplier out of the pickers and leaves every historical expense, order '
  'and ageing row exactly as it was. Use soft delete for a record that was a mistake.';

-- ── RLS: the partner's own supplier book, and nobody else's ──────────────────
-- The 0430 shape verbatim.
alter table suppliers enable row level security;
alter table suppliers force  row level security;

create policy suppliers_sel on suppliers for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy suppliers_ins on suppliers for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy suppliers_upd on suppliers for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy suppliers_del on suppliers for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

grant select, insert, update, delete on suppliers to authenticated;
grant all on suppliers to service_role;

create trigger suppliers_audit after insert or update or delete on suppliers
  for each row execute function app_audit();
