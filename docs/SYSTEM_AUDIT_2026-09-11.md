# FleetWise system audit — 11 September 2026

## Outcome

The system has substantial working functionality; the important gaps found in this pass were workflow reliability and permission enforcement, not a need to rebuild the product. Fixes are in the local worktree. This is **not** a claim that every production workflow has been exercised or that these pending changes have been deployed.

The worktree contains concurrent design, billing, signup and email-verification work. Those changes were preserved and included in application validation; this report does not claim authorship of them. Snapshot checked against HEAD `4777bf6` plus the pending worktree changes.

Handoff finalized on 12 September. HEAD has subsequently advanced to `c042498` with additional billing/refund work; the results below describe the recorded verification checkpoint, not a fresh certification of those later changes. Rerun the gates against the exact release commit.

## What was fixed in this audit

| Area | Change | Client benefit |
| --- | --- | --- |
| Multiple farms and roles | Resource-farm roles used for core actions and media uploads; database write policies and tenant bindings strengthened | An owner at one farm cannot accidentally act as an owner at another farm where they are only a driver |
| Daily readings and repairs | Assigned operators can record readings; mechanics retain operational commands without administrative machine-edit rights; job/fault/service-line links bound to the same machine and farm | Daily capture works without granting unnecessary admin access |
| Offline capture | Capture plus retry acknowledgement commit in one transaction; repeat requests reuse the saved result; decreasing readings and locked-card edits become conflicts | Reconnection cannot silently duplicate a fault or roll back service-due readings |
| Offline recovery | Account-bound drafts, durable IndexedDB commits, retained rejections/conflicts, `/queue` review/download/removal, visible storage errors | Work is not silently thrown away when permission, storage or connectivity changes |
| Fault reporting | Online and offline fault form use the same retry key; media retries attach to the existing fault; bounded uploads and optional-location fixes; form labels and recording cleanup | Lost responses no longer require starting the fault again; missing GPS does not become a false location |
| Fault list | Active faults queried separately from resolved history, ordered by urgency before pagination; resource-farm action controls | Older history cannot hide ongoing breakdowns or produce a false all-clear |
| Financial privacy | Raw structured financial columns restricted; masked read projections preserve operational rows; cost-sensitive reports, PDFs, attachments, notifications and subject exports checked | Hiding costs is enforced beyond the visible screen |
| Service kits | Applying a priced kit requires cost permission, in both the action and UI | A masked price cannot silently become a zero-cost repair line |
| Scheduled reports | Explicit farm-scoped service-worker reads, with masked projections retained for interactive callers | Privacy protections do not empty background reports |
| Notifications | Leased batches, persisted per-device acknowledgements, retry on provider/query/persistence failure, terminal handling for expired subscriptions | Temporary delivery failures do not permanently discard reminders |
| Push privacy/security | Browser-provider endpoint validation, bounded requests, redirect rejection, monetary details suppressed on push | Stored endpoints cannot become arbitrary server requests; lock screens do not display financial amounts |
| Verification | Recursive test discovery now includes billing and every nested suite; CI includes tests, lint, design checks, translations, error coverage and build | Newly added suites are not silently skipped |

Principal implementation locations: `src/lib/auth.ts`, `src/app/api/sync/route.ts`, `src/lib/offline/`, `src/components/offline/`, `src/lib/fault-media.ts`, `src/app/(app)/faults/page.tsx`, `src/lib/cost-visibility.ts`, `src/lib/push/deliver.ts`, and the pending audit migrations/tests under `supabase/`.

The database and interface skills influenced the implementation: permission checks moved to the database boundary, while recovery screens use explicit labels, retained error states and deliberate confirmation before deleting a local copy. The [Supabase RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security) was used to check the distinction between grants, row policies and view ownership; the actual behavior was checked with local tests, not inferred from the guide.

## Verification

- `pnpm test`: **236 passed**, zero failures in the latest completed run. Includes billing, report-worker isolation, push delivery, media helpers, assistant/voice, input validation and same-origin checks.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with no lint warnings/errors. The installed Next.js version prints a notice that `next lint` will be deprecated in a future major version.
- `pnpm build`: passed, including the current signup, billing, recovery and verification routes.
- `pnpm design:lint`: passed, including all 12 contrast-contract checks.
- `pnpm i18n:parity` and `pnpm errors:check`: passed.
- `git diff --check`: passed; Git emitted only Windows line-ending conversion notices.
- Full local PostgreSQL 16.6 run: **157 migrations and all 10 SQL suites passed**, exit code 0, zero ERROR/FATAL entries, ending `==> OK`. Includes pending/closed billing rejection for offline and QR captures, unchanged legacy-farm access, financial disclosure, role isolation, atomic rollback and push lease/retry tests. Exact local log: `C:/Users/Xander/AppData/Local/Temp/fleetwise-db-audit-085ae541898f436693a0f9d5e173b4b4/suite_final_verified_20260911.log`.

Database verification uses a disposable database on `127.0.0.1:55439` with the repository's Supabase auth/storage shim. It validates SQL and policies, **not** the hosted PostgREST relationship cache, real Auth cookies, Storage delivery, mail providers, or browser behavior. No production migration, deployment, charge, push or email was performed by this audit.

## Remaining release gates

1. **Deploy schema and code together on staging, then exercise real roles.** Pending migrations include column grants, views and RPC changes. A frontend-only deployment is unsafe. Verify PostgREST reads/relationships, authenticated storage downloads, secondary-farm permissions and zero restricted financial fields in API responses. The local Supabase URL is configured; that alone is not proof of an authenticated client journey.
   Also test closed-account access through direct API requests and server actions outside the newly gated capture RPCs. Global billing-closure enforcement is not certified by a screen redirect or by the capture-specific tests.
2. **Run a real mobile acceptance trial.** On Android Chrome and iPhone Safari: sign in, open a machine, capture a reading/fault/photo/voice note offline, close/reopen, reconnect, inspect the saved record and exactly one usage entry. Repeat with an expired session, another account on the same device, a revoked membership, a locked job card and a decreasing meter. Exercise `/queue` recovery before deleting any draft.
3. **Verify live integrations deliberately.** Follow `PAYSTACK_GO_LIVE.md` for provider setup, signed webhook verification and controlled test-mode payment/reconciliation. Confirm receipt/verification email delivery, document/report email delivery and notification subscription/unsubscription. The repository now records confirmed prices; the earlier empty-catalogue finding is superseded. This audit did not enable charging or inspect live billing secrets.
4. **Schedule and monitor delivery.** `docs/CRON.md` documents that nightly push alone processes at most 25 notifications; configure the frequent authenticated push scheduler and monitor failures/deferred counts. Verify the maintenance, scheduled-report and billing schedules on the deployed environment, not just their route responses.
5. **Prove backup restoration and support recovery.** Follow `BACKUP.md` on an isolated restore. Confirm that a client can retrieve their data after subscription closure, and that staff can resolve retained offline conflicts and older unowned drafts without attributing them to the wrong account.

## Known functional limitations still worth addressing

- **Offline fuel capture is not implemented in the general capture queue.** The install help and historical feature checklist now say so. The current queue supports readings, faults, job-card entries and job completion; it is not a promise that every screen or form works offline.
- **Normal in-app fuel issue and usage-log writes are still separate.** `src/app/(app)/fuel/actions.ts` inserts the issue and then a usage record; the latter result is not checked. This should move into an authenticated atomic command so driver-utilisation history cannot diverge after a partial failure. Public QR fuel capture already has an atomic command.
- **Some media/amount/event workflows remain multi-step.** Job/work attachment persistence now reports failure honestly, but a later amount/event update can fail after a file was saved. Reconcile those partial outcomes explicitly; do not present a successfully uploaded file as proof that the financial event completed.
- **Privacy does not scan free text or image contents.** Structured costs and known financial-document types are protected. A photo, note or user-entered description can still contain a price; do not advertise automated content redaction.
- **Legacy unowned offline drafts require support review.** Automatically assigning old drafts to whoever signs in next would be unsafe. They are retained, not silently submitted or deleted.
- **Speed and ease-of-use need client measurement.** A passing build is not evidence of a sub-30-second task. Time a new user's first machine setup and three repeated daily captures over rural connectivity.

## Highest-value client trial

Use one owner, one mechanic and one driver with a small representative fleet. Track whether they can complete this loop without help:

`add/import machine → driver reading or fault → assign repair → complete service → owner reviews history, cost and next due task`

Also switch the same person between farms with different roles. Success means correct records, visible next actions, no lost captures, no unauthorized costs, and a reminder that reaches the intended device. Fix failures in this loop before adding optional integrations or expanding the feature list.
