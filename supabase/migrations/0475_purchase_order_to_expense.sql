-- 0475_purchase_order_to_expense.sql
-- The one moment a purchase order becomes money.
--
-- 0473 says a purchase order is a commitment and books nothing. This is where that
-- promise is kept honest, because "books nothing" is only safe if there is exactly one
-- place the cost DOES appear and it can be reached from the order.
--
-- The supplier's invoice arrives. It is captured as a `partner_expenses` row, the same
-- row it would have been if no purchase order had ever existed — same VAT treatment, same
-- time of supply, same behaviour on the VAT return and the P&L. The only difference is
-- that it now remembers which order it settles.
--
-- ── Exactly once, and provably ───────────────────────────────────────────────
--
-- Two directions have to hold, and rls_isolation.sql G16 asserts both:
--
--   * raising an order and receiving every item of it changes NO cost anywhere. There is
--     no trigger from 0473/0474 into `cost_entries` or `partner_expenses` to do so.
--   * converting produces exactly ONE expense, and converting again produces none — not
--     "produces a duplicate the app then has to clean up".
--
-- The second guarantee is a UNIQUE INDEX rather than a check in the server action, for the
-- reason 0435 gives about payment callbacks: a double-submitted form, a retried request
-- and two people in the office capturing the same invoice are all the same race, and a
-- read-then-write in application code loses it. The database refuses the second row.
--
-- ── Why the index is partial on deleted_at ───────────────────────────────────
--
-- Soft-deleted expenses drop out of the uniqueness. That is deliberate, and it is the
-- same judgement `stock_items_part_uq` makes. An expense captured against the wrong order,
-- or captured for the wrong amount and deleted, is a mistake being retracted; if the index
-- covered deleted rows too, that mistake would strand the purchase order forever — it
-- could never be converted again, and the only way out would be a support ticket. The
-- softer rule still refuses what actually matters, which is two LIVE expenses claiming the
-- same order.

alter table partner_expenses
  add column purchase_order_id uuid;

-- Composite, so an expense can only ever point at a purchase order of its OWN workshop.
-- The house tenancy pattern: RLS already stops a partner READING another workshop's
-- orders, but a foreign key makes the cross-workshop write structurally impossible rather
-- than merely unreachable through the UI. MATCH SIMPLE (the default) means the constraint
-- stands down entirely while `purchase_order_id` is null, which is the ordinary case —
-- most expenses were never ordered on paper at all.
alter table partner_expenses
  add constraint partner_expenses_po_fk foreign key (purchase_order_id, workshop_id)
    references purchase_orders(id, workshop_id);

create unique index partner_expenses_po_uq on partner_expenses (purchase_order_id)
  where purchase_order_id is not null and deleted_at is null;

comment on column partner_expenses.purchase_order_id is
  'The purchase order this supplier invoice settles, when there was one (G16, 0475). The '
  'expense is the ONLY thing that books the cost — the order itself books nothing. A '
  'partial unique index makes a second live conversion of the same order impossible.';
