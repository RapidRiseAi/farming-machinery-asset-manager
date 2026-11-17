# B3 R-044 manual driving: isolated Codex contribution

17 November 2026. Ready for Claude review after local verification; not merged, accepted
or released. This is only the independent manual-driving portion of B3. Claude remains
the orchestrator and final reviewer. Do not mark TASK B3 COMPLETE or implement R-044 again.

Branch: `codex/b3-driving-20261117`, worktree `C:/projects/.fw-codex-b3-driving`.
Base: `be6fae750894b67d6d8df53f3694d0f93d6b3cbd` (accepted A1/B1). The final candidate
SHA is recorded in `C:/projects/output/fleetwise-final-dev/CODEX-B3-DRIVING-HANDOFF.md`.
The separate B2 candidate is not an ancestor of this branch.

## Scope and behaviour

- R-044: manual start, arrive, depart and finish dialogs accept kilometre readings, a
  current destination and an ordered written stop list. Essential needs no map service.
  Existing A1 entitlements give the manual workflow to every plan and refuse equipment.
- Existing sessions/events hold the new fields; there is no competing journey model.
  Optional readings preserve unknown distances. Actual zero remains zero. Readings cannot
  decrease within a session and do not update an asset's separate service meter.
- `record_manual_driving_event` reuses the existing writer, chronology and attribution.
  Authenticated callers must have current internal membership, account access and asset
  eligibility. Managers can record on behalf of a driver; coworkers cannot impersonate.
  Tenant policies and audit triggers remain. Anonymous execution is denied.
- Request UUID plus the exact submitted payload deduplicates retries in one transaction.
  Current permissions are checked before replay. A changed payload is refused visibly.
  Explicit draft discard allows a fresh request after the user checks driving history.
- A session plan version prevents old dialogs overwriting newer instructions. Reload
  itinerary adopts current instructions while retaining kilometres, time and notes.
- EN/AF dialogs use the existing pending guard. Tab drafts retain fields and request ID
  through failed saves/navigation/reload when browser storage is available. They clear on
  successful save or sign-out. A failed action never closes the dialog as if it succeeded.

## Verification

Local evidence lives under `C:/projects/output/fleetwise-final-dev/codex-b3-driving-*`.

| Check | Result |
|---|---|
| `pnpm test` | 1,156 pass |
| TypeScript, production build | Pass, no environment file or provider credentials |
| Lint | Pass with existing route-planner ref warning at line 253 |
| Dashes, EN/AF parity/key coverage, design/contrast, error coverage | Pass |
| `node scripts/migrate_check.mjs --suite` | 290 migrations apply; 78 SQL suites pass, 1 existing billing failure |
| `manual_driving.sql` | Pass, including retry identity, stale plans, readings, Essential, account and tenant checks |
| `manual_driving_review_check.mjs` | Four removed guards caught: changed retry, stale plan, intermediate backwards reading, coordinate entitlement |
| `manual_driving_ui_check.mjs` | Pass: real dialogs in headless Chrome at 360px/1280px, EN/AF, failed save, draft restoration, repeat submit, stale-plan recovery and explicit discard |

The full suite includes driving_activity, deploy_compatibility, equipment_restrictions and
pay_gate_functions. The only failure is `billing_review_5.sql`, `money-10 trial-anchor`,
also reproduced on the unchanged base in `codex-b2-baseline.log`. No billing fix belongs
in this contribution. The full run preceded the final test-helper expansion to accept
check-constraint refusal; the final targeted suite verifies that expansion.

Browser evidence uses the real components/styles with an in-memory server-action fixture.
SQL uses throwaway PGlite. These checks are not combined application/real Postgres CI,
live Supabase verification or native-phone signoff. No paid provider was invoked.

## Integration and remaining work for Claude

1. Preserve A2's existing worker and finish its lifecycle work. A3 depends on A2; later B4/B5
   depend on A3, B6 needs driving contracts and A6 needs the integrated product. This scope
   was chosen because it can use the existing A1 helpers without changing those contracts.
2. Review this branch against the base, then integrate through the existing manager process.
   B2 also edits `sign-out-form.tsx`: retain BOTH `fw-chat:` and `fw-driving:` cleanup.
   Preserve both tasks' translations, limits, migration probes, run.sh suites and docs.
   This branch must not overwrite B2's requirement states or A2's shared-file changes.
3. Apply additive migration `20261117110000_manual_driving_log.sql` before the new page.
   The legacy RPC signature remains unchanged; older clients can still write existing
   events. Application rollback can leave these columns and captured history intact.
4. Run CI on real Postgres and the full app after integration. Check A2 grace, suspension,
   cancellation/retrieval and reactivation, lost responses, revoked membership, concurrent
   tabs and legacy/new clients together. Verify real mobile EN/AF dialogs and refresh.
5. Finish the rest of B3: trip/route and downgrade audits, imports, broader offline/retry
   gaps, assistant and payment retries, exports and digest scheduling. New manual coordinate
   capture checks Complete plus map readiness, but this does not certify all legacy map,
   route or tracking endpoints. Native Android is outside this contribution.

Scenario 13 is addressed only for manual logs; scenario 35 only for this web form's retry
and draft behaviour. There is no automatic offline queue, cross-device draft sync or
guaranteed recovery after closing the tab/clearing browser storage. No launch acceptance,
zero-breakage guarantee, merge, push, production migration or deployment is claimed.
