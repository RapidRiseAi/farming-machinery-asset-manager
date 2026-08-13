-- 0474_purchase_order_receiving.sql
-- Receiving: the header's status follows the lines, by itself.
--
-- Somebody carries a box in from the bakkie and ticks off what is in it. That is the whole
-- interaction, and it happens standing up, often with one hand. Asking that person to
-- ALSO remember to move the order from "sent" to "part received" — and then to notice, two
-- deliveries later, that it has quietly become complete — is how a status column becomes
-- decoration: it is right on the day it is set and wrong for the rest of the month.
--
-- So the status is derived, not typed. The same reasoning as `stock_items.on_hand` in
-- 0450: the ledger is what people actually maintain, so anything summarising it must be
-- computed from it rather than kept in step by hand.
--
-- ── Which states the engine owns ─────────────────────────────────────────────
--
-- Only the three that describe a delivery: `sent` -> `part_received` -> `received`.
--
--   * `draft` is untouched because a draft is not with the supplier yet. Quantities typed
--     against a draft are a mistake being corrected, not a delivery arriving.
--   * `closed` and `cancelled` are untouched because they are DECISIONS. A partner who
--     closes a short-shipped order — the supplier is never sending the last two, the
--     invoice is captured, it is finished — must not find it reopened as `part_received`
--     the next time anyone touches a line. An engine that overrides a human decision gets
--     switched off; this one cannot, because it never sees those rows.
--
-- Nothing in here books cost. Receiving stock is stock arriving, exactly as a fuel
-- delivery is in F4 and a stock receipt is in 0450 — the money still enters only when the
-- supplier's invoice is captured (0475).

-- ── What the lines say has arrived ───────────────────────────────────────────
-- SECURITY DEFINER so the triggers can read the lines regardless of which policy path the
-- caller came in on, and EXECUTE revoked from everyone: this is trigger plumbing, not an
-- entry point. 0440 is the reason the revoke is explicit — a function with no grant
-- defaults to EXECUTE TO PUBLIC, which is how a debug helper ended up reachable by anon.
create or replace function app.purchase_order_derived_status(
  p_order   uuid,
  p_current purchase_order_status
) returns purchase_order_status
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_ordered  numeric := 0;
  v_received numeric := 0;
begin
  -- Draft, closed and cancelled are not the engine's to move. Returning the current value
  -- unchanged is what makes the triggers below safe to fire on every write.
  if p_current not in ('sent', 'part_received', 'received') then
    return p_current;
  end if;

  select coalesce(sum(l.qty_ordered), 0),
         -- Clamped per line. A supplier who sends twelve of one item and none of another
         -- has NOT completed the order, and an unclamped sum would say they had — the
         -- surplus on one line would silently cover the shortfall on the other.
         coalesce(sum(least(l.qty_received, l.qty_ordered)), 0)
    into v_ordered, v_received
    from purchase_order_lines l
   where l.purchase_order_id = p_order
     and l.deleted_at is null;

  -- An order with no lines left on it is still just "with the supplier"; there is nothing
  -- it could be said to have fully received.
  if v_ordered <= 0 or v_received <= 0 then return 'sent'; end if;
  if v_received >= v_ordered then return 'received'; end if;
  return 'part_received';
end $$;

revoke all on function app.purchase_order_derived_status(uuid, purchase_order_status)
  from public, anon, authenticated;

-- ── On the header: a typed status inside the engine's range is corrected ─────
-- This is what makes "the status follows the lines" true by construction rather than by
-- the app remembering. When the partner sends an order, the app writes `sent` and this
-- decides what `sent` actually means given what has already arrived; a stale form posting
-- `received` over a half-delivered order is corrected the same way.
create or replace function app_purchase_order_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.status := app.purchase_order_derived_status(new.id, new.status);
  return new;
end $$;

create trigger purchase_orders_status before insert or update on purchase_orders
for each row execute function app_purchase_order_status();

-- ── On the lines: receiving moves the order ──────────────────────────────────
-- Fires after 0473's rollup (triggers on one table fire in name order, and `_rollup`
-- sorts before `_status`), so the subtotal is already settled when this runs.
--
-- The rollup's own write to the header would in fact re-run the BEFORE trigger above and
-- reach the same answer, so this trigger is belt and braces today. It is here on purpose:
-- that side effect is an accident of the rollup touching `updated_at`, and a later change
-- making the rollup skip no-op writes would silently stop receiving from moving the
-- status. The guarantee should not depend on an unrelated function's implementation.
create or replace function app_purchase_order_status_from_lines() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order uuid;
begin
  v_order := coalesce(new.purchase_order_id, old.purchase_order_id);

  update purchase_orders o
     set status = app.purchase_order_derived_status(o.id, o.status),
         updated_at = now()
   where o.id = v_order
     and o.status is distinct from app.purchase_order_derived_status(o.id, o.status);

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger purchase_order_lines_status
after insert or update or delete on purchase_order_lines
for each row execute function app_purchase_order_status_from_lines();

comment on function app.purchase_order_derived_status(uuid, purchase_order_status) is
  'What a purchase order''s status should be given what its lines say has arrived. '
  'Returns draft/closed/cancelled unchanged — those are human decisions, not deliveries. '
  'Per-line clamped so over-delivery on one line cannot mask a shortfall on another.';
