# REPORT A4: service orders, the complete export, retention and deletion

Saved by the main session from the worker's final message (the worker's harness refused to write this file). Text unchanged apart from this line.

Lane A, branch `final/lane-a`, 18 to 19 November 2026, last commit 7f5a50c. BRIEF sections 16 and 18; decisions 28, 29, 30, 35, 38 and 40; scenarios 11 (deletion part), 20, 29 and 43. Codex started it: e36b9bd was kept and its untested draft 607b3e5 was rewritten. A Claude Opus worker finished it. No production system, live database, provider, push or merge was touched.

Final gates at 7d231ea (only docs changed after it):
- `tsc` clean.
- 1236 unit tests: 0 failed, 1 skipped.
- Dashes, i18n parity (8017 keys in each language), i18n keys, design lint and errors check all clean.
- Full SQL suite **97/97** on PGlite (`node scripts/migrate_check.mjs --suite`, 307 migrations).
- Mutations: **47/47 SQL** (service 18, export 15, retention 14) and **12/12 TS** (service 5, export job 7) caught. Each was restored with `git checkout`, and each was confirmed to have changed the file that ran.

## 1. Done

### Service orders and Done-For-You (steps 1 and 2; 18c09d4 to 73bc9f7)

**Migration `20261120100000_service_orders.sql`.** It replaces Codex's draft, which kept the terms as JSON, invoiced the managed fee by hand outside the subscription and would have billed the software twice.

- **`done_for_you_quotes`** is extended. Every existing row is marked `legacy` and is otherwise unchanged. A new agreement stores:
  - scope, work allowance, review schedule and what costs extra;
  - the staff owner, as a role (never a name);
  - assumptions and assumed assets;
  - the supplier mandate (empty means the owner approves every supplier cost);
  - explicit period prices: per full space, minimum spaces, equipment included, and the price of further equipment;
  - the recurring total at the assumed quantities (the A1 renewal sum);
  - currency, VAT snapshot, term, dates, acceptance, landing and end.
- **`dfy_offer`** enforces the floors:
  - R170 a space a month and R2,500 a customer a month;
  - annual terms at twelve times each (never the ten-month rule);
  - equipment never at the R15 software rate.
- **`dfy_accept`**: only the owner accepts, at the total they saw. An expired offer, a changed VAT setting or a business in its grace is refused.
- **`cron_apply_service_agreements`** runs in the billing cron after the scheduled changes and before the invoice run. At the first renewal on or after the start date, it pins the subscription to a private, frozen price row (`dfy-<quote>`). The ordinary invoice run then bills it, and A2's quotes price any added spaces at the agreement's own prices.
- A trigger refuses a self-service plan change while the term runs.
- **`dfy_end`** ends an agreement through A2's pending change at the next renewal.
- The old `billing_record_dfy_quote` stays, marked as the old path, for the live build and existing agreements.
- **Catalogue rules** are data on `billing_service_catalogue`:
  - clean setup R150 per asset, R750 minimum;
  - document capture R300 per asset, R1,500 minimum;
  - historical work and remote training R500 an hour, in quarter hours;
  - on-site training from R3,500 plus agreed travel;
  - QR kits R45 per asset, minimum ten, **not ready** until a supplier quote reference is recorded (a check constraint enforces this).
- The per-case codes onboarding, training and QR stickers are retired from new invoices. Installation stays.
- **`service_orders`**: Rapid Rise offers an order with quantity, scope, delivery and travel. The owner accepts it. Rapid Rise then raises one service invoice for exactly the accepted amount; the nightly card run never charges it.
- Clean import and document capture are never charged for the same work: one piece of setup work, or one asset, can have only one live setup order.
- **`service_work_entries`** records time by activity and asset (Rapid Rise only) and service reviews (the owner reads these).

**TypeScript and screens.**
- `src/lib/service-orders.ts` mirrors the SQL rules; its test reads the migration.
- `/billing` has a services card:
  - an offer waiting for the owner, with every term and an accept dialog;
  - the agreement in force and its reviews;
  - orders with an accept button;
  - the optional catalogue, worded by readiness;
  - support hours from the configured settings.
- The admin farm page has a services card: offer an agreement or an order, invoice, complete, cancel, end, and log work and reviews.
- The old "record a quote" form is gone.
- The admin's free-form service invoice now lists per-case codes only.
- EN and AF text and error codes are added.

### The complete export (step 3; bebbcd4 to 9466ec9)

**Migration `20261120110000_complete_export.sql`.**
- A private bucket `farm-exports` that no signed-in person can read. Paths are `exports/<farm>/<job>/...`, outside the business's own folder, so archives never count against its storage.
- Tables `farm_export_jobs` and `farm_export_job_files`.
- `export_readable_files` runs with the requester's own rights (SECURITY INVOKER), so Storage's row security and the pay gate decide which files are listed.
- Service functions:
  - create: repeat-safe, one job at a time per business, at most five a day;
  - lease, record files, finish, retry missing files, cleanup and orphan sweep.
- `export_job_finish` keeps an archive seven days, never past the owner's last reading day.
- `export_job_allowed` lets the background worker re-check the requester's role and the lifecycle.

**TypeScript (`src/lib/farm-export/`).**
- `tables.ts` is one table list shared with B3's streamed export, so there is no second exporter.
  - It adds equipment history, invoice lines, payments, credits, storage measurements and charges, and service agreements.
  - Staff chat, command audio, ledgers and card details are never listed.
- `archive.ts` builds numbered ZIP parts of about 40 MB, with portable hashed names and SHA-256 checksums. It also writes the contents list:
  - scope and what was left out;
  - row counts per table;
  - every file with its size, checksum and part;
  - missing files, named by a hash of their path and the reason.
- `job.ts` runs the steps:
  - Records are read page by page through the requester's session. Rows created after the cutoff are left out where the table records a creation time, and parts continue across steps.
  - File bytes are read through the requester's session while their page drives the job. The background worker copies only files on the list that session produced.
  - Three failed attempts and a file is reported missing.
  - Parts are numbered deterministically and overwritten on retry, so a crash never duplicates one.
  - It also holds the worker and the bounded cleanup.
- `access.ts` applies the same role and lifecycle rule as the streamed export.

**Routes and screens.**
- Routes:
  - `/api/farm/export/jobs`: start and list;
  - `[id]/step`;
  - `[id]/download`: a link signed for 10 minutes and made again on every press, or the contents list as a file;
  - `[id]/retry`;
  - `/api/cron/exports`: an optional worker on its own schedule.
- Nightly steps `export_worker` (45 seconds) and `export_cleanup`.
- The export panel shows progress, parts, the contents list, retrying missing files and a new copy. It is on:
  - `/settings`, for owners and managers;
  - `/suspended`, `/closed` and `/close-account`, for the owner during the 90 days.
- Export limits are in the limits catalogue and `docs/LIMITS.md`; a test pins the SQL numbers to them.
- The per-bucket file download never offers export archives.

### Retention and deletion (step 4; c6d9c77 to 6276e15)

**Migration `20261120120000_retention_schedules.sql`.**
- `retention_settings`: deletion **off**, delay 30 days.
- Tables `farm_retention_schedules` and `farm_retention_holds`.
- `farm_closures` gains `reason` (owner or retention), `basis` and `pending_logins`.
- A private bucket `deletion-ledger`.
- **`retention_schedule_run`** runs nightly:
  - It schedules each business that ended unpaid or cancelled, from A2's last reading day plus the delay.
  - It cancels the schedule if the business reactivates or becomes exempt, and applies holds.
  - It stores a dry-run preview: what would go, what billing evidence stays, the files, which logins would be removed and which moved, and every reason it cannot go yet.
- **Warnings go out only while deletion is switched on.** Deletion is never sooner than 30 days after the first warning, with further warnings at 7 and 1 days.
- **`retention_delete`** re-checks everything in the transaction that deletes:
  - deletion is switched on and the schedule is due;
  - the first warning is at least 30 days old;
  - the business is still closed for non-payment or cancellation, and past its reading window;
  - it is not billing-exempt;
  - no hold is active and no payment is in flight.

  It then runs the owner's own `close_farm_permanently`, recording reason `retention` and the basis. Billing evidence stays for five years under the existing purge. A person who also belongs to another business is moved there, never deleted.
- Holds and the on/off switch are Rapid Rise functions; switching on needs a typed phrase.

**TypeScript, screens and docs.**
- `src/lib/retention.ts` (`runRetention`) deletes only when both the database switch is on and `RETENTION_DELETION=enabled` is set on the deployment. Files and logins are removed after the closure, and anything left is retried nightly (`closure_logins`).
- Every closure, including an owner's own, is written to the deletion ledger, which a database restore cannot roll back.
- `/admin/retention` shows the switch, the schedule with previews and reasons, and holds.
- There is a notification template for the warning. The nightly `retention` step is a dry run today.
- Docs updated:
  - `BACKUP.md` section 8: what is deleted and when, how long backup copies last, and how a restore re-applies the ledger;
  - `CRON.md`, `DATABASE.md`, `SECURITY.md` and `LIMITS.md`.

## 2. Requirements and scenarios

| Covered | By |
|---|---|
| R-115, R-116, scenario 43 | `supabase/tests/service_orders.sql` [1] to [8], `src/lib/service-orders.test.ts` |
| R-100, R-124, scenario 29 | `supabase/tests/complete_export.sql` [3] to [7], `src/lib/farm-export/job.test.ts` |
| R-102, scenario 20 | `complete_export.sql` [1] [2] (owner, manager, restricted bucket, stopped business, chat, another business), `job.test.ts`, `src/lib/farm-export-files.test.ts`, `src/lib/chat/privacy.test.ts` |
| R-101, scenarios 11 (deletion, reactivation during scheduling) and 29 | `supabase/tests/retention_schedules.sql` [1] to [5], `src/lib/retention.test.ts` |

Register rows R-100, R-102, R-115, R-116 and R-124 are now E (A4). R-101 is **X**: built, but it ships off until the founder and a lawyer decide. Issues I-020, I-023 and I-034 are closed.

## 3. Not done, and why

- **No browser or live Storage run.** There is no `.env.local` here, so the new screens are type-checked and linted only. The export is proven with a stand-in Storage table and fake clients. Signed links, real uploads and real Storage policies have not been exercised.
- **No load test** of a very large export, which scenario 29 asks about. The design is bounded by steps and parts, not measured.
- **QR kits** cannot be ordered until a supplier quote exists. There is no admin screen to record it; it takes one SQL statement (section 6).
- **No notice when an export is ready.** The page shows it, and an unattended job finishes overnight.
- **The complete export does not set `last_export_at`.** Closing an account still needs the streamed JSON export within 24 hours, as before.
- **A Done-For-You agreement starts at a renewal, never mid-period**, so no proration is needed.
- **No `BUILD_LOG.md` entry.** The manager merges and logs.

## 4. Assumptions (flag any that are wrong)

1. **The Done-For-You price is all-in.** The approved pricing table lists Done-For-You as a tier, so its quote replaces the software price, billed through the subscription from the renewal.
2. **The floors apply per asset, equipment included.** The annual floor is twelve times the monthly one, so no annual quote can go below it. The R2,500 minimum is enforced as minimum spaces x price per space at least R2,500 a month.
3. **Optional orders are invoiced by Rapid Rise after the owner accepts**, at a time staff choose. They are paid by EFT or payment link and never charged to the card automatically.
4. **The superseded per-case codes** (onboarding, training, QR stickers) are switched off for new invoices.
5. **Export settings:**
   - parts of 40 MB, kept seven days, links valid 10 minutes;
   - five exports a day per business, 200,000 files, 1,000,000 rows per table;
   - Rapid Rise may start an export, as the streamed export already allowed.
6. **Retention timing:** deletion 30 days after the reading window (`delay_days`); warnings at 30, 7 and 1 days; holds placed by Rapid Rise.
7. **What a deletion keeps** is the closure's existing list: invoices, invoice lines, payments, payment attempts, subscriptions and the closure record. Service agreements, credits, storage charges and change quotes are deleted with the rest.
8. **Support hours** are read from `support_settings`. Its default opening time is 09:00; decision 30 says 08:00 (section 6).

## 5. Risks, most important first

1. **Files copied by the background worker.** It copies the list the requester's session produced, using the service role. It re-checks the requester's role and the lifecycle at every step, but not a Storage policy change between listing and copying. Steps driven by the requester's open page read through their session.
2. **Upload size limit.** The project's global upload limit must hold a 40 MB part, and also a lone 50 MB PDF. Supabase's Free plan cannot exceed 50 MB; Pro can be set up to 500 GB. Confirm the live value.
3. **Deploy order.** Apply `20261120100000`, then `20261120110000`, then `20261120120000`, and deploy straight after. The billing cron calls `cron_apply_service_agreements`, and the nightly cron calls the export and retention functions.
4. **Closures now delete more.** They also delete export jobs (their archives are swept up as orphans) and service records. A lawyer may want some of these kept (section 8).
5. **Records changing during an export.** A row updated after the cutoff appears in its updated form. Four tables paged by position (job card service lines, trip income, trip routes, storage measurements) could skip a row deleted while that table is being read.
6. **The nightly preview grows with stopped businesses.** It counts every table with a business column for each scheduled business: fine now, slower with many.
7. **Part downloads are buttons, not `DownloadLink`s.** They send the browser to a signed link, so behaviour in an iPhone home-screen app is unverified.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| QR kits | The founder approves a supplier quote (material, size, print method, adhesive, delivery to Hazyview, margin). Rapid Rise then runs `update billing_service_catalogue set supplier_quote_reference = '<quote ref>', ready = true where code = 'qr_kits';` |
| Scheduled deletion | A lawyer reviews section 8 and the terms, and the founder decides. Then type the phrase on `/admin/retention` and set `RETENTION_DELETION=enabled` in Vercel. Until then it is a dry run with no warnings. |
| Upload limit | Read Supabase, Storage settings, global file size limit. It must be at least `STORAGE_GLOBAL_LIMIT_NEEDED_BYTES` in `src/lib/limits.ts`. |
| Backup facts | Record the daily backup retention and the PITR window in `BACKUP.md` section 2.1. Run a restore drill that includes section 8.3. |
| Support hours | If decision 30 stands, set opening to 08:00 on `/admin/support/settings`. |
| Faster exports (optional) | Schedule `GET /api/cron/exports` every few minutes with the `CRON_SECRET` bearer. |
| Real checks | A staging run: offer, accept and land an agreement at a renewal; offer, accept and invoice an order; run a complete export with real photos and PDFs and check the download against the contents list. Then `ui:check` on `/billing`, `/settings`, `/admin/farms/[id]` and `/admin/retention` at 360 and 1024 px, in English and Afrikaans. |

## 7. For the next tasks

- **A5 (website and help):**
  - Describe Done-For-You as "quoted, from R170 per asset a month, R2,500 monthly minimum".
  - Use the catalogue prices exactly. Describe QR kits as "available once the supplier's price is confirmed".
  - Describe exports as records plus files, prepared in the background and kept seven days.
  - Describe deletion as a future policy that is switched off. Never promise instant removal from backups or third parties.
  - Show support hours from the settings.
- **A6 (release):**
  - Apply the three migrations in order; their probes are in `scripts/apply_pending.mjs`.
  - New cron steps: billing `apply_service_agreements`; nightly `closure_logins`, `retention`, `export_worker` and `export_cleanup`.
  - Check that the buckets `farm-exports` and `deletion-ledger` exist after applying.
  - Leave `RETENTION_DELETION` unset.
  - `billing_record_dfy_quote` can be dropped once no legacy agreement needs it.
- **Lane B:**
  - A new business table goes in `src/lib/farm-export/tables.ts`, never `chat_*` (the `NEVER_EXPORTED` test enforces this).
  - `whatsapp_*` tables are excluded too; B4 decides whether WhatsApp history should be exported.
  - Every new table with a business column is deleted by closures and retention unless kept on purpose.
- **Any lane:** a function that touches billing tables must be declared in the lockdown sweep in `billing_subscription.sql`. `retention_checks`, `retention_preview`, `service_tax_snapshot`, `dfy_apply_due`, `dfy_*` and `cron_apply_service_agreements` are already declared there.

## 8. Legal-review checklist (questions, not claims; code alone proves no compliance)

1. The **90-day reading window** and the **30-day delay** are product choices, not statutory periods. Are they adequate, and correctly worded in the terms (`src/lib/legal.ts`)?
2. **Billing records** are kept five years after a closure. Is that the right period under the Tax Administration Act, the Companies Act and any other rule that applies?
3. **What else must survive a deletion?** Accepted service terms, account credits, storage charges and change quotes are deleted today; invoices and payments are kept.
4. **The deletion ledger** keeps business ids and dates after deletion. What is the lawful basis for keeping them, and for how long?
5. **Backups.** Copies persist until backups expire (about a week, to be confirmed), and third parties keep what their own terms say. Is the planned disclosure enough under POPIA?
6. **Warnings.** Are the wording of the deletion warning and its timing (30, 7 and 1 days) enough notice?
7. **Exports and personal information.** Only the owner may export during the 90 days; while the business is open, managers export what they may read. How does this relate to a person's own access requests?
8. **Private staff chat** is never in a business export. Is that the right balance between the business and its staff?
9. **Done-For-You agreements.**
   - Is accepting by ticking a box a valid electronic acceptance?
   - Does the CPA apply to these business customers?
   - Review the supplier-mandate clause.
   - Review the sentence "unless written above: no unlimited administration, guaranteed savings, cover outside hours, emergency response or inspections".
10. **Optional services** have no written cancellation or refund terms for once-off orders after acceptance or invoice.
11. **Rapid Rise's own exports.** Staff may start an export of a customer's records in support mode. Does the customer agreement cover that?
