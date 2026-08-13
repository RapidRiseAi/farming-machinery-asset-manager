-- 0473_purchase_orders.sql
-- What has been ORDERED and has not yet arrived (G16).
--
-- `partner_expenses` (0430) records a purchase at the moment the SUPPLIER'S INVOICE
-- arrives. That is exactly the right moment for the books — it is the time of supply, it
-- is what input VAT is claimed from, it is what the P&L counts — and it is far too late
-- for the workshop floor. Between "I phoned Bearing Co on Monday" and "their invoice came
-- on Friday" this product held nothing at all, so three ordinary questions had no answer:
--
--   * what is on order? The bakkie is stripped in bay two waiting for a part somebody
--     ordered last week, and the only record of it is in that person's head.
--   * did it all arrive? A supplier who ships eight of the ten and invoices for ten is
--     not a rare event. Without a record of what was ordered there is nothing to compare
--     the delivery note against, and the short two are paid for and quietly forgotten.
--   * what did we agree to pay? The price was argued on the phone three weeks ago.
--
-- ── A purchase order is a COMMITMENT, not a cost ─────────────────────────────
--
-- This is the load-bearing decision in the whole feature, and it is the same rule 0450
-- worked through for stock: a cost enters the ledger EXACTLY ONCE, and the question is
-- always "which row owns this rand". A purchase order owns none of them.
--
--   * Ordering is not spending. Nothing is owed until the supplier has actually
--     supplied — a PO can be cancelled the same afternoon and no money ever moves. A
--     product that booked cost at order time would show a month as loss-making because
--     of parts that never came, and would then double it when the invoice was captured.
--   * So `purchase_orders` and `purchase_order_lines` have NO cost trigger. Not a
--     conditional one like 0450's — none at all. There is deliberately no code path from
--     this migration to `cost_entries` or to `partner_expenses`, which is the strongest
--     form the guarantee can take, and rls_isolation.sql G16 asserts it by raising and
--     receiving a whole order and then counting both tables.
--   * The cost appears when, and only when, the supplier's invoice is captured as an
--     expense. 0475 records the LINK from that expense back to this order, so the two can
--     be compared, with a unique index making a second conversion impossible.
--
-- Receiving stock therefore books nothing here either. If the workshop also keeps that
-- part on a shelf, `stock_movements` (0450) is where the shelf is adjusted and 0450's own
-- rule decides what that costs — this table stays out of it.
--
-- ── Totals are maintained by trigger ─────────────────────────────────────────
--
-- The header carries subtotal/VAT/total and the app may never type any of them. Copied
-- from `app_stock_rollup()` and from the partner-document rollups for the same reason:
-- a typed total drifts the moment a line is edited by somebody who forgets to retype it,
-- and a total that disagrees with the lines beneath it is worse than no total, because it
-- is believed. Here it is enforced rather than merely conventional — the BEFORE trigger
-- overwrites whatever was submitted, so a stale form cannot restate an order's value.
--
-- Scope: WORKSHOP, exactly like `partner_expenses`. What a workshop has on order with its
-- suppliers is its own business; a farm reading it would see the buying prices behind
-- every quote it is given.

-- ── The lifecycle ────────────────────────────────────────────────────────────
-- Six states, and the middle three are the engine's (0474) rather than the app's:
-- `sent` -> `part_received` -> `received` follow from what the lines say has arrived, so
-- nobody has to remember to move them. `draft`, `closed` and `cancelled` are decisions a
-- person makes and the engine never overrides.
create type purchase_order_status as enum (
  'draft',          -- being written; the supplier has not seen it
  'sent',           -- with the supplier, nothing received yet
  'part_received',  -- some of it arrived
  'received',       -- everything ordered has arrived
  'closed',         -- done with: invoiced, or short-shipped and written off as finished
  'cancelled'       -- never happening; no money will move
);

-- ── The order ────────────────────────────────────────────────────────────────
create table purchase_orders (
  id             uuid primary key default gen_random_uuid(),
  workshop_id    uuid not null references workshops(id) on delete cascade,

  supplier_name  text not null,
  -- OUR reference for it — the number said down the phone, written on the delivery note,
  -- and quoted back when the invoice is queried. Not the supplier's; that one arrives
  -- later and lands on `partner_expenses.reference`.
  reference      text,

  order_date     date not null default current_date,
  -- When they said it would be here. Nullable, because "next week sometime" is the honest
  -- answer often enough that forcing a date would mean inventing one.
  expected_date  date,
  notes          text,

  status         purchase_order_status not null default 'draft',

  -- The VAT the SUPPLIER is expected to add, which is not the same question as whether
  -- this workshop is VAT-registered (0401). A non-registered workshop still pays VAT on
  -- what it buys — it simply cannot claim it back — so unlike `partner_documents` there is
  -- no guard forcing this to zero. It is an estimate of somebody else's invoice, and the
  -- real figure is captured from the paper when it arrives.
  vat_rate_bps   int not null default 1500,

  -- All three maintained by trigger from the lines. Never written by the app.
  subtotal_cents bigint not null default 0,   -- ex-VAT, integer cents (Scope §6)
  vat_cents      bigint not null default 0,
  total_cents    bigint not null default 0,

  created_by     uuid references users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid,

  constraint purchase_orders_rate_ck check (vat_rate_bps between 0 and 10000),
  -- Composite uniqueness so the lines (and 0475's expense link) can be tied to an order
  -- OF THE SAME WORKSHOP by a foreign key rather than by a check somebody could forget to
  -- write. The house tenancy pattern, borrowed from `stock_items`.
  constraint purchase_orders_id_workshop_uq unique (id, workshop_id)
);

create index purchase_orders_workshop_idx on purchase_orders (workshop_id, order_date desc);
-- "What is still coming?" is the question this screen exists to answer, so it gets its
-- own partial index rather than a scan filtered in the app.
create index purchase_orders_open_idx on purchase_orders (workshop_id, expected_date)
  where deleted_at is null and status in ('sent', 'part_received');

-- ── What was ordered ─────────────────────────────────────────────────────────
create table purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  workshop_id       uuid not null,
  purchase_order_id uuid not null,
  sort_order        int not null default 1,

  description       text not null,
  -- Free text on purpose. A supplier's part number is what goes on the order, and it is
  -- frequently not a number this workshop has ever catalogued — insisting on a
  -- `parts_catalogue` row would mean filing a part before you are allowed to order it.
  part_no           text,

  -- Numeric rather than integer: oil is ordered in litres and cable in metres, exactly as
  -- `stock_movements.qty` already allows.
  qty_ordered       numeric(14,3) not null,
  -- What has actually turned up. Partial deliveries are the norm, so this climbs; it is
  -- allowed to EXCEED the quantity ordered, because over-delivery happens and refusing to
  -- record it would only mean the record stops matching the shelf. 0474 clamps it when
  -- deciding the header's status so an over-received line cannot hide a short one.
  qty_received      numeric(14,3) not null default 0,

  unit_price_cents  bigint not null default 0,   -- ex-VAT, integer cents

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  deleted_by        uuid,

  constraint purchase_order_lines_qty_ck      check (qty_ordered > 0),
  constraint purchase_order_lines_received_ck check (qty_received >= 0),
  constraint purchase_order_lines_price_ck    check (unit_price_cents >= 0),
  constraint purchase_order_lines_order_fk foreign key (purchase_order_id, workshop_id)
    references purchase_orders(id, workshop_id) on delete cascade
);

create index purchase_order_lines_order_idx on purchase_order_lines (purchase_order_id, sort_order);
create index purchase_order_lines_workshop_idx on purchase_order_lines (workshop_id);

-- ── VAT and total follow the subtotal ────────────────────────────────────────
-- A BEFORE trigger, so the derived figures are computed on the row on its way in and
-- there is no window in which the stored total is wrong. It fires on the rollup's own
-- update too, which is how a line edit reaches the total, and on a plain header edit,
-- which is how changing the expected VAT rate reaches it.
create or replace function app_purchase_order_totals() returns trigger
language plpgsql as $$
begin
  new.vat_cents   := round(new.subtotal_cents::numeric * new.vat_rate_bps / 10000);
  new.total_cents := new.subtotal_cents + new.vat_cents;
  return new;
end $$;

create trigger purchase_orders_totals before insert or update on purchase_orders
for each row execute function app_purchase_order_totals();

-- ── The subtotal follows the lines ───────────────────────────────────────────
-- Recomputed from the whole set rather than adjusted by the delta, for the reason 0450
-- gives: two people editing lines at the same moment can each read a stale running total
-- and write it back, and a full re-sum cannot race that way. Soft-deleted lines drop out.
create or replace function app_purchase_order_rollup() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order uuid;
begin
  v_order := coalesce(new.purchase_order_id, old.purchase_order_id);

  update purchase_orders o
     set subtotal_cents = coalesce((
           select sum(round(l.qty_ordered * l.unit_price_cents))
             from purchase_order_lines l
            where l.purchase_order_id = v_order and l.deleted_at is null
         ), 0)::bigint,
         updated_at = now()
   where o.id = v_order;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger purchase_order_lines_rollup
after insert or update or delete on purchase_order_lines
for each row execute function app_purchase_order_rollup();

-- ── RLS: the partner's own order book, and nobody else's ─────────────────────
-- The 0430 shape exactly: own workshop or rr_admin, with no farm path whatsoever. A farm
-- reading its contractor's purchase orders would be reading the buying price behind every
-- quote it has ever been given, which is the same margin leak F16 closed for expenses.
-- Anon gets nothing — 0102 revoked the default privileges and no anon policy exists.
alter table purchase_orders enable row level security;
alter table purchase_orders force  row level security;

create policy purchase_orders_sel on purchase_orders for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy purchase_orders_ins on purchase_orders for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy purchase_orders_upd on purchase_orders for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy purchase_orders_del on purchase_orders for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

alter table purchase_order_lines enable row level security;
alter table purchase_order_lines force  row level security;

create policy purchase_order_lines_sel on purchase_order_lines for select to authenticated
  using (deleted_at is null and (app.is_rr_admin() or workshop_id = app.user_workshop_id()));
create policy purchase_order_lines_ins on purchase_order_lines for insert to authenticated
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy purchase_order_lines_upd on purchase_order_lines for update to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id())
  with check (app.is_rr_admin() or workshop_id = app.user_workshop_id());
create policy purchase_order_lines_del on purchase_order_lines for delete to authenticated
  using (app.is_rr_admin() or workshop_id = app.user_workshop_id());

grant select, insert, update, delete on purchase_orders      to authenticated;
grant select, insert, update, delete on purchase_order_lines to authenticated;
grant all on purchase_orders      to service_role;
grant all on purchase_order_lines to service_role;

create trigger purchase_orders_audit after insert or update or delete on purchase_orders
  for each row execute function app_audit();
create trigger purchase_order_lines_audit after insert or update or delete on purchase_order_lines
  for each row execute function app_audit();

comment on table purchase_orders is
  'What the workshop has ORDERED and not yet been invoiced for (G16). Workshop-scoped. A '
  'commitment, not a cost: this table books nothing into cost_entries or partner_expenses '
  '— the cost appears only when the supplier invoice is captured (see 0475). '
  'subtotal/vat/total are maintained by trigger from the lines and must never be written.';
comment on table purchase_order_lines is
  'One row per thing ordered. qty_received climbs as deliveries arrive and may exceed '
  'qty_ordered; the header status follows from these lines (0474). Money is ex-VAT '
  'integer cents.';
