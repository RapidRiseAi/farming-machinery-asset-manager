# FleetWise app: Claude Cloud continuation checkpoint

Prepared 31 October 2026. **This is an unfinished development checkpoint, not a production release. Do not merge or deploy it as-is.**

Repository: RapidRiseAi/farming-machinery-asset-manager. Branch: **codex/cloud-handoff-20261030** (the identifier was created before the date changed). The marketing website is a different repository, **RapidRiseAi/fleetwise-website**, destined for Cloudflare Pages. Keep the app and website separate.

## What is already live

Vercel reported the production app Ready at `c34170fa9d9bfcb6d919defe989feb580740f249` on the existing app project, associated with app.fleet-wise.co.za. This includes the 28 October support desk, finance/lease and access-control work. The older main checkout on the local computer is behind this release; do not use its HEAD as production truth.

## What this branch preserves

The committed local Claude branch at `e97a9e5` is 17 commits ahead of production: fault voice notes, support chasing, subscription suspension/grace, manual payments, once-off service invoices, and four rounds of billing review fixes. This checkpoint also copies eight tracked, uncommitted files from the fifth review's customer worktree. `CLOUD-SNAPSHOT.json` records their paths and hashes. Other fifth-review worktrees had no changes when inspected. Original working folders and the running Claude process were left untouched.

This is a source snapshot, not a complete copy of the previous conversation or Claude's in-memory work. No credentials, environment files, logs, local agent state or customer data are included.

## Verification and exact blockers

- Unit tests on the snapshot: **818 tests; 814 passed, 4 failed**.
- Typecheck: **two errors** in src/lib/billing/service.ts, missing `CancelRefusal` and `CANCEL_REFUSALS`.
- The four failing checkout-cancel tests hit the missing `CANCEL_REFUSALS`. The customer worktree was part-way through extending the cancellation guard to pending and cancelled subscriptions. Finish this change coherently, including refusal messages/callers and regression tests; merely declaring a placeholder constant would hide the unfinished behaviour.
- Fifth-review stale-checkout recovery and stopped-page changes also need review and adequate tests before release.
- A read-only `apply_pending.mjs --dry` run against the configured database reported **20261029150000_billing_review_fixes_4.sql** pending (258 migration files, 93 object probes). No migration was applied by this checkpoint task. Probe results are not a claim that every unprobed migration was independently checked.
- No production app deployment, real charge, data mutation or live customer test was performed for this checkpoint. The full SQL suite and production build must pass before a coordinated schema/app release.

## Approved commercial decisions still to implement

The website advertises new quotations at Essential R49/asset/month or R490/year; Professional R79 or R790; Complete R99 or R990. Five paid assets minimum, once per customer, pooled over that customer's sites. Complete adds consolidated management. Unlimited users, role permissions remain.

Managed service is quoted from R170/asset/month, minimum R2,500/customer/month, adjusted for workload. It covers remote maintenance planning, workshop follow-up, cost monitoring and owner reporting in the agreed scope. API/integrations remain with managed service, separately scoped. Annual managed service is quoted, not automatically discounted.

The released entitlement source still lists R44/R73/R89/R250 and the billing catalogue needs coordinated changes, not just a marketing-string edit. Preserve historical invoice snapshots and existing agreements. Implement and test catalogue versions, minimum units, customer-level pooling, quoted managed-service activation and self-service checkout totals together.

AI, voice and WhatsApp: actual landed provider cost +30%, no included paid messages; provider-free messages cost zero, separately used AI can still be charged. WhatsApp general customer launch is deferred. Attachment storage: 100 MB/paid asset, minimum 1 GB/customer; paid storage blocks must stay unadvertised until metering works.

Setup: clean spreadsheet R150/asset, min R750; documents/photos R300/asset, min R1,500, as alternatives. Historical work R500/hour. Remote training R500/hour. On-site from R3,500 for up to four hours plus agreed travel. Physical QR labels remain supplier-quote dependent; printable files and existing tyre/sale/warranty tools remain included. No public self-hosting, white labelling, SLA or new paid workshop offer.

## Start the cloud session

At https://claude.ai/code, connect the GitHub repository and select **codex/cloud-handoff-20261030**, then start a new cloud session. If the UI starts at main, ask it to fetch and switch to this branch before any changes. Cloud sessions run without the laptop. Remote Control requires the local computer and is not the same thing.

Prompt:

> Continue the FleetWise app from codex/cloud-handoff-20261030. Read CLAUDE.md, docs/SCOPE.md and docs/CLOUD-HANDOFF.md first; this handoff updates the older status notes. Inspect the checkpoint diff against main. Finish the fifth billing review, beginning with the missing CancelRefusal/CANCEL_REFUSALS definitions and their full behaviour, then verify the stale-checkout recovery. Run pnpm test, pnpm typecheck, the production build and node scripts/migrate_check.mjs --suite. Use only a local/test database for tests. Reconcile the approved pricing and entitlement decisions in the handoff with the real billing catalogue and checkout. Work through a pull request. Do not apply production migrations or release a failing build. Report the exact remaining release gates and prepare the coordinated deployment for review. The marketing website is in a different repository and uses Cloudflare; do not combine it with this app.

Install dependencies with pnpm using the committed lockfile. Production credentials do not belong in GitHub or this document. Configure any required cloud test environment privately using `.env.example`; use a separate test database and test payment configuration. Existing local secrets are not automatically available in Claude Cloud.

Reference: https://code.claude.com/docs/en/claude-code-on-the-web (cloud execution and session handoff), https://code.claude.com/docs/en/remote-control (local execution).
