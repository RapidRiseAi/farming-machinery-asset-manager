-- 0492_partner_books_tier.sql
-- A third partner product, for the partners who run their books here.
--
-- 0382 shaped the partner offer as two products rather than two sizes: `portal` (their
-- customers see the fleet with them in it, and they attach the paperwork their own system
-- already produces) and `managed` (they build quotes and invoices here, take payments, and
-- send statements). That split still holds, and neither changes.
--
-- What has changed is that a whole financial-management layer now exists above it — profit
-- and loss, cash-flow forecasting, the VAT return, expenses, suppliers, purchase orders,
-- bank reconciliation and standing costs. That is not a bigger version of invoicing; it is
-- the difference between writing the invoice and running the business, and it is worth its
-- own rung.
--
-- `books` sits above `managed` and unlocks exactly that layer. Nothing a partner relies on
-- today moves behind it: every existing `managed` partner keeps precisely what they had,
-- and every `portal` partner keeps uploading their own documents for free. The new tier is
-- an upgrade, never a repossession — which is the same promise 0382 made when it decided
-- that uploading a document produced elsewhere would stay core on every plan.
--
-- ── Why there is no SQL mirror of the entitlement map ────────────────────────
--
-- Deliberate, and unchanged from 0320/0382: a partner's data isolation is guaranteed
-- SOLELY by RLS and `workshop_links`, never by their plan. Downgrading a partner must
-- change what they can DO, not what they can SEE of other tenants — that is already
-- impossible. So the plan lives here as a column and the feature map lives app-side in
-- `src/lib/contractor-plan.ts`, with no `app.has_entitlement` twin. The farm plan needs
-- its SQL mirror because farm entitlements gate row-returning RPCs; this one gates
-- screens.
--
-- Adding the value only. Postgres will not let a new enum label be USED in the same
-- transaction that adds it, and nothing here needs to — the default stays `portal` and no
-- existing row moves.

alter type workshop_plan add value if not exists 'books';

comment on column workshops.plan is
  'Which partner product this workshop bought (0382, extended 0492): portal - their '
  'customers see the fleet and they upload their own paperwork; managed - they build '
  'documents and take payments here; books - plus the financial-management layer (P&L, '
  'cash flow, VAT, expenses, suppliers, purchase orders, bank reconciliation). RR-admin '
  'writable only (0320 guard trigger). NOT a tenancy control: isolation is RLS.';
