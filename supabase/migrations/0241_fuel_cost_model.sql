-- 0241_fuel_cost_model.sql
-- Fuel → cost_entries / TCO, WITHOUT double-counting (F4, coordinates with F1's 0211).
--
-- ┌─ FUEL-COST MODEL DECISION (authoritative) ─────────────────────────────────────┐
-- │ Model chosen: PER-ISSUE ATTRIBUTION.                                            │
-- │                                                                                 │
-- │ A farm buys diesel in bulk (fuel_deliveries → tank stock) and then issues it to │
-- │ individual machines (fuel_issues). Only the ISSUE is attributable to an asset,  │
-- │ so the issue is the single authoritative source of fuel cost in the TCO ledger: │
-- │ each non-deleted fuel_issue with a cost books exactly one `fuel` cost_entry,     │
-- │ scoped to its machine (machine_id null → farm-level fuel, e.g. a bulk/other      │
-- │ draw). This satisfies FR-10.1 / gap-analysis T2(d): fuel appears in the ASSET's  │
-- │ cost record and rolls into app.machine_tco().                                   │
-- │                                                                                 │
-- │ A DELIVERY is a stock purchase, not an asset cost, so it no longer books a       │
-- │ cost_entry. F1's 0211 previously booked each delivery as a farm-level `fuel`     │
-- │ entry (so TCO reflected fuel before this UI shipped); now that fuel is captured  │
-- │ per issue, that delivery-level entry is REMOVED here (the 0211 trigger function  │
-- │ is replaced to keep no delivery cost entry, and existing delivery-sourced fuel   │
-- │ entries are soft-deleted in the backfill below).                                │
-- │                                                                                 │
-- │ NO-DOUBLE-COUNT INVARIANT: fuel is booked into cost_entries on exactly ONE path  │
-- │ (fuel_issues). Deliveries book zero. Therefore a farm's fuel appears in TCO      │
-- │ exactly once — asserted in supabase/tests/rls_isolation.sql (F4 section).        │
-- │                                                                                 │
-- │ Fuel PURCHASED (deliveries) vs fuel ISSUED/attributed (issues = the TCO figure)  │
-- │ differ by tank-stock movement; the dashboard/report widgets show both so the two │
-- │ reconcile. Both are honest numbers: cash-out on diesel vs diesel consumed by     │
-- │ assets.                                                                          │
-- └────────────────────────────────────────────────────────────────────────────────┘
--
-- All sync functions are SECURITY DEFINER (owned by a BYPASSRLS role) so they maintain
-- the ledger regardless of the caller's RLS, writing only farm-scoped rows derived from
-- the source row's own farm_id — the exact pattern 0211 established.

-- ── Deliveries → NO cost entry (replace the 0211 booking) ─────────
-- Keep the fuel_deliveries_cost trigger (attached in 0211) but neutralise its body:
-- a delivery is tank stock, not an asset cost. If a prior delivery-sourced `fuel` entry
-- exists (from 0211 or its backfill), soft-delete it so history is preserved and the
-- ledger holds fuel exactly once (via issues).
create or replace function app_cost_from_fuel_delivery() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row fuel_deliveries;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;

  update cost_entries set deleted_at = coalesce(deleted_at, now())
    where source_type = 'fuel_delivery' and source_id = v_row.id and deleted_at is null;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

-- ── Issues → per-machine `fuel` cost entry (the authoritative path) ─
-- Mirrors app_cost_from_job_card_line (0211): upsert keyed by (source_type='fuel_issue',
-- source_id); soft-deleting / zero-costing the issue soft-deletes its cost entry (history
-- preserved). machine_id flows through as-is (null → farm-level fuel cost).
create or replace function app_cost_from_fuel_issue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_row     fuel_issues;
  v_amount  bigint;
  v_deleted boolean;
begin
  if tg_op = 'DELETE' then
    v_row := old; v_deleted := true;
  else
    v_row := new; v_deleted := (new.deleted_at is not null);
  end if;

  v_amount := coalesce(v_row.cost_cents, 0);

  if v_deleted or v_amount = 0 then
    update cost_entries set deleted_at = coalesce(deleted_at, now())
      where source_type = 'fuel_issue' and source_id = v_row.id and deleted_at is null;
  elsif exists (select 1 from cost_entries where source_type = 'fuel_issue' and source_id = v_row.id) then
    update cost_entries
       set farm_id = v_row.farm_id, machine_id = v_row.machine_id, type = 'fuel',
           amount_cents = v_amount, vat_rate_bps = v_row.vat_rate_bps,
           occurred_on = coalesce(v_row.date, current_date), deleted_at = null, deleted_by = null
     where source_type = 'fuel_issue' and source_id = v_row.id;
  else
    insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps, source_type, source_id, occurred_on)
    values (v_row.farm_id, v_row.machine_id, 'fuel', v_amount, v_row.vat_rate_bps,
            'fuel_issue', v_row.id, coalesce(v_row.date, current_date));
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $$;

create trigger fuel_issues_cost
  after insert or update or delete on fuel_issues
  for each row execute function app_cost_from_fuel_issue();

-- Trigger-only functions: keep them off the PostgREST RPC surface.
revoke execute on function app_cost_from_fuel_delivery() from anon, authenticated, public;
revoke execute on function app_cost_from_fuel_issue()    from anon, authenticated, public;

-- ── Idempotent backfill (production; no-op on the empty test DB) ──
-- 1) Retire any delivery-sourced fuel cost entries (Model B: deliveries book zero).
update cost_entries set deleted_at = coalesce(deleted_at, now())
  where source_type = 'fuel_delivery' and deleted_at is null;

-- 2) Book existing costed issues as per-machine fuel cost entries (skip already-synced).
insert into cost_entries (farm_id, machine_id, type, amount_cents, vat_rate_bps, source_type, source_id, occurred_on)
select fi.farm_id, fi.machine_id, 'fuel', fi.cost_cents, fi.vat_rate_bps, 'fuel_issue', fi.id,
       coalesce(fi.date, current_date)
from fuel_issues fi
where fi.deleted_at is null and coalesce(fi.cost_cents, 0) <> 0
  and not exists (select 1 from cost_entries ce where ce.source_type = 'fuel_issue' and ce.source_id = fi.id);
