-- 0250_plans_and_subscription.sql  (FleetWise F5 — plans & entitlement framework)
-- Replace the legacy `farm_tier` (starter/standard/large) with the four real
-- FleetWise plans, and give every farm an explicit subscription shape:
-- plan + billing_period + status (status already exists) + a maintained asset_count.
--
-- Plan data map (documented; applied below):
--   starter   → essential
--   standard  → professional
--   large     → complete
--   (done_for_you is the new top plan — no legacy tier maps onto it)
-- Default for new farms stays the entry plan: 'essential'.
--
-- Tenancy/RLS/audit are untouched: this only reshapes columns on the already
-- RLS-forced, audited `farms` table (the audit trigger diffs to_jsonb(row), so a
-- dropped/added column is captured automatically). No new tenant table is added.
-- Creating a BRAND-NEW enum and using its values in the same transaction is allowed
-- (the "can't use a new value in the same txn" rule only applies to ALTER TYPE ADD
-- VALUE on an existing enum), so this whole file is transaction-safe.

-- ── New enums ─────────────────────────────────────────────────────
create type farm_plan      as enum ('essential','professional','complete','done_for_you');
create type billing_period as enum ('monthly','annual');

-- ── farms: add the subscription columns ───────────────────────────
alter table farms
  add column plan           farm_plan      not null default 'essential',
  add column billing_period billing_period not null default 'monthly',
  add column asset_count     integer        not null default 0;

comment on column farms.plan is
  'FleetWise subscription plan. Drives feature entitlements — see app.has_entitlement '
  'and src/lib/entitlements.ts (the single source of truth mirrored by this DB helper).';
comment on column farms.billing_period is 'monthly | annual (per-vehicle pricing display only; charging deferred).';
comment on column farms.asset_count is
  'Denormalised billable-asset count (active, non-deleted, non-retired/sold machines). '
  'Maintained by the app_farm_asset_count trigger (0251). Display/billing-seam only — no charging.';

-- ── Map legacy tier → plan, then retire the old column + type ──────
update farms set plan =
  case tier
    when 'starter'  then 'essential'
    when 'standard' then 'professional'
    when 'large'    then 'complete'
    else 'essential'
  end::farm_plan;

alter table farms drop column tier;
drop type farm_tier;
