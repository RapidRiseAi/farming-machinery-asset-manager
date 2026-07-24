-- 0320_workshop_plans.sql
-- Contractor-plan gating seam (F12c, spec §1 last bullet).
--
-- FleetWise is two-sided: farms pay for the fleet manager (plans in 0250), and
-- contractors/suppliers (a `workshop`, 0002/0300) get a paid SaaS portal on top of the
-- SAME workshop spine. This migration adds the LIGHTWEIGHT column that lets richer
-- contractor features be gated behind a contractor plan later — value-first onboarding:
-- every contractor starts FREE (they can already see incoming requests across all their
-- linked farms and act on them), and premium contractor extras (cross-client analytics,
-- CSV export, …) sit behind `pro`.
--
-- PAYMENTS ARE DEFERRED. This column moves no money; it is the single stored input the
-- app-side entitlement map (`src/lib/contractor-plan.ts`) reads. Unlike the FARM plan
-- (0251 `app.has_entitlement`), the contractor plan does NOT guard tenancy — RLS +
-- `workshop_links` remain the SOLE isolation guarantor — so it needs no SQL/RLS mirror:
-- it only tailors a contractor's own portal. It is therefore a plain, additive column.
--
-- Additive only: existing workshops default to 'free'. RLS on `workshops` is unchanged
-- (0101: a workshop reads its OWN row via `id = app.user_workshop_id()`; only rr_admin
-- may write — so RR sets the plan, no self-upgrade). The 0008 workshops_audit trigger
-- already covers the new column.

create type workshop_plan as enum ('free', 'pro');

alter table workshops
  add column plan workshop_plan not null default 'free';

comment on column workshops.plan is
  'Contractor portal plan (F12c). free = see/act on requests across linked farms; '
  'pro = premium contractor extras (analytics, export). App-gated only via '
  'src/lib/contractor-plan.ts — NOT a tenancy guard (RLS + workshop_links isolate). '
  'Payments deferred.';
