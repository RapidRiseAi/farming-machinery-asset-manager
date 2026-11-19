# Final development: release notes, sequence and rollback

Task A6, 19 November 2026. Covers everything on `final-dev` that is not on `main`: tasks A1 to A6 and
B1 to B6. **Nothing here has been released.** Releasing needs the founder's approval at the final
combined review (FOUNDER-DECISIONS-PENDING). The steps below are the plan, not a record.

## 1. What changes

| Task | What a customer gets | Migrations |
|---|---|---|
| A1 | Support equipment as its own asset profile, equipment allowances and pricing, capacity checks, moves and licences | 20261114090000 to 20261114090400 |
| B1 | One limits catalogue; direct, resumable uploads with the storage pool reserved first; photo reduction with keep-original; ten-minute voice notes and commands | 20261115090000, 20261115100000 |
| A2 | Priced changes (quote, accept, pay), the subscription lifecycle (grace, suspension, closure), sign-up with equipment | 20261115110000 to 20261115130000 |
| B2 | Staff chat on every plan, with attachments | 20261117090000, 20261117090100 |
| B3 | Manual driving log; trips and maps by plan; history after a downgrade; repeat-tap and offline gaps closed | 20261117110000, 20261119090000 to 20261119140000 |
| A3 | Pooled storage with paid blocks; one owner-chosen spending limit for paid AI, voice and WhatsApp | 20261118120000 to 20261118120200 |
| A4 | Service orders; the complete export with files; retention schedules (deletion off) | 20261120100000 to 20261120120000 |
| B4 | WhatsApp per-path flags, media on the pool, upload links, one answer per message | 20261121090000 |
| A5 | Website pricing (website repo, unpublished), sign-up prefill, EN/AF guidance | none |
| B5 | Custom asset fields; import review for readings; document reading and manual questions built but off | 20261121100000 to 20261121120000 |
| B6 | The Android app (separate build); routes split at data gaps | none |
| A6 | Vehicles move only within one customer; security and isolation checks; restore drill and load-test kits | 20261121130000 |

## 2. Before the release day

1. Founder decisions that change what is switched on: FOUNDER-DECISIONS-PENDING items 1 to 14.
   None of them blocks deploying with features in their default states.
2. Rehearse on staging if one exists:
   - apply all 30 migrations;
   - run `node scripts/migrate_check.mjs --suite` (every SQL suite on PGlite);
   - run `pnpm db:test` against staging's Postgres;
   - run `ui:check` against the staging preview.
3. Production checks:
   - Stored file sizes against the new pool (A3). A business already over its allowance can no longer add files; nothing is deleted.
   - The buckets `farm-exports` and `deletion-ledger` exist (A4).
   - `RETENTION_DELETION` is unset (deletion stays dry-run).
4. Take a fresh database backup, or note the PITR point, and record it in the release log.

## 3. Release sequence (one sitting, in this order)

1. **Dry run:** from the main checkout with the production `.env.local`, run `node scripts/apply_pending.mjs --dry`. It must list exactly the 30 migrations in section 1, in order. Every one has a probe naming an object only it creates; a migration without one would be skipped as "assumed applied".
2. **Apply:** `node scripts/apply_pending.mjs --apply`. It runs each file in its own transaction, in order, and stops at the first failure. Then run `--dry` again: nothing pending, every probe true.
3. **Deploy at once:** merge `final-dev` into `main` and push. Vercel builds `main`. The old build must not run long against the new schema:
   - the old change screens call functions A2 replaces;
   - `/api/sync` calls `apply_offline_capture_once` (B3);
   - the WhatsApp worker calls B4's functions.
4. **Confirm live by commit SHA** (memory: query Vercel by commit). Then run `/api/health`, `pnpm ready:check` and `pnpm ui:check` against the live URL.
5. **Scheduler:** the nightly route now runs these steps:
   - storage_measure;
   - apply_service_agreements and closure_logins;
   - retention (dry run);
   - export_worker and export_cleanup.

   Watch `cron_runs` and `cron:*` errors for the first night.
6. **After no older page is open** (a day later): enable the reserved upload paths (B1):
   `update app.upload_settings set enforce_reserved_paths = true, updated_at = now();`
   Then drop the two superseded change functions A2 left for the old screens
   (`billing_change_quota`, `billing_change_plan`) in a follow-up migration.
7. **Website:** publish the A5 branch only with the founder's approval, together with or after the app (the website now sends `equipment` to sign-up).

## 4. Flags and settings, as released

| Flag or setting | Released state | Turned on by |
|---|---|---|
| `map` (maps on Complete) | off for everyone | Rapid Rise per business on `/admin/features`, after the Mapbox terms read (decision 5) |
| `general_chat` | as before | `/admin/features` |
| `whatsapp_text`, `whatsapp_alerts` | released | |
| `whatsapp_photos`, `whatsapp_voice` | off | after the real-phone journeys (B4) |
| `document_extraction`, `manual_questions` | off | after a provider and its price (decision 12) |
| `RETENTION_DELETION` | unset (dry run) | founder, after the lawyer's read (decision 7) |
| `BILLING_CHARGING_ENABLED` | unchanged | |
| `ANDROID_CERT_SHA256` | unset (no app claims the links) | after Play App Signing (decision 14) |
| `DOCUMENT_EXTRACTION_PROVIDER`, `MANUAL_READER_PROVIDER` | unset (`none`) | after decision 12 |

## 5. Rollback

- **Code:** redeploy the previous production build from Vercel (Deployments, Promote). This is safe only while the database still answers the old calls. `supabase/tests/deploy_compatibility.sql` pins the call shapes the deployed build makes, so no migration here drops a signature the old build uses, except A2's superseded change functions, which are not dropped until step 6.
- **Database:** migrations are forward-only. Do not "un-apply" them. A fault in a migration is fixed by a new migration. Ledgers (billing, storage charges, AI usage, the deletion ledger) are never rolled back by deleting history; a wrong charge is corrected by a compensating entry (credit) through the existing paths.
- **A bad data change:** restore to a PITR point into a scratch project, compare, and copy back only what is needed (BACKUP.md sections 3 and 9). Then re-apply the deletion ledger and erasures, so a restore never brings back a closed business (section 8.3).
- **Features:** every new path that spends money or reaches a provider has a flag or an unset setting. Switching it off is the first rollback.

## 6. Afterwards

- The AI notice, terms and pricing pages changed (A2, A3). The lawyer's read is still open; bump `TERMS_VERSION` after it.
- Record the release in docs/BUILD_LOG.md: SHA, CI run, migrations applied, checks run, and what was not exercised.
