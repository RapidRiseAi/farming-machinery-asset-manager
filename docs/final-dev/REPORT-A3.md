# REPORT A3: pooled storage, paid blocks and the shared assistance spending cap

Saved by the main session from the worker's final message (the worker's harness refused to write this file). Text unchanged apart from this line.

Task A3 is finished on `final/lane-a`. It started on `48b7987` and the last commit is `ad774a2`. Nothing was pushed, merged or applied to a live database. BRIEF sections 11 and 12, decisions 14, 15, 22, 23, 24, 34 and 36, and scenarios 24, 25, 26, 30, 31 and 32 are covered, plus the storage and assistance half of scenario 12.

**What customers get:**
- **One storage pool per customer.** It is shared by every site and is max(2 GB, 100 MB per full space + 25 MB per equipment space).
- **Optional 10 GB blocks at R49 a month.** A block exists only after the owner accepts the price and pays it.
- **Automatic blocks, off by default.** The owner can switch them on with a monthly ceiling, and the ceiling counts the blocks already held.
- **One spending limit for paid AI, voice and WhatsApp.** It covers the whole customer and has no default: until the owner chooses one, nothing paid runs.

**Checks (local only, no `.env.local`):**
- Type check clean.
- 1181 unit tests, 0 failing.
- dashes, i18n parity, i18n keys, design and errors checks clean.
- All 87 SQL suites pass on PGlite (298 migrations), after the last code and doc change.
- Mutations: I broke 47 rules on purpose and a test failed for every one (40 database, 7 TypeScript).
- Not run: real Postgres CI, a browser walk, a real Paystack payment, a real WhatsApp message.

## 1. Done

| Step | Commits | What it delivers |
|---|---|---|
| 1 Storage pool | `c0339cc` to `bff3cb3` | **Migration `20261118120000`.**<br>**The allowance.** `app.storage_allowance` replaces `app.storage_quota_bytes` and `app.storage_pool_farm_ids`, now for the whole customer.<br>**Older files count.** Files with no upload record (from before the upload pipeline, older upload paths, orphans) are measured nightly into `storage_usage_snapshots`, one row per site per South African day. That table is also the record of storage for each billing period.<br>**Warnings and full.** Owners are warned at 80% and 95%. At full, only new attachments are refused. `storage_note_full` then tells the owners once; it is a separate call because the refusal undoes its own transaction.<br>**Tables and functions.** `storage_pool_settings` holds the automatic setting. `storage_charges` is a money record, stamped onto one invoice once. `storage_pool_status` shows money to the payer only. `storage_set_auto` is the owner's switch.<br>**Tests:** `storage_pool.sql`. |
| 2 Blocks on the bill | `8425d22` to `623d917` | **Migration `20261118120100`.**<br>**Buying.** A block is an A2 quote with change `storage`. Accept, apply, raise invoice and cancel are copied from A2 with storage branches added.<br>**Giving back.** Fewer blocks start the next storage month, and are refused while the files would not fit (`storage-reduction-over-usage`).<br>**The monthly charge.** It goes on the period invoice for monthly customers. For annual customers it goes on the usage invoice (kind `ai_usage`, which now means "usage").<br>**The usage invoice.** It now carries the AI use of every pooled site (before, a pooled site's use was never invoiced), and a unique index allows at most one per customer per day.<br>**The old meter.** `usage_for_month` now reports measured storage only; it no longer prices anything.<br>**Tests:** `storage_blocks.sql`; `billing_payment_integrity.sql` adjusted for the new index. |
| 3 Spending limit | `47a854b` to `fa75620` | **Migration `20261118120200`.**<br>**The budget.** `assistance_budgets` holds one row per customer. With no row, paid work is refused with `budget_unset`. Existing customers keep their limit as their choice (`app.assistance_migrate_existing`), and their owners are told.<br>**One customer, one count.** Holds lock per customer; spend and per-person limits are counted across all sites.<br>**WhatsApp.** Messages go on the same AI ledger: held before sending, settled from Meta's delivery pricing. Free, failed, and unanswered after 72 hours all settle at R0.<br>**The record.** Each usage row now also keeps the customer, rate version, supplier currency, supplier tax treatment and pricing category.<br>**Owner functions.** `ai_set_farm_limit` (blank refused, zero allowed), `ai_set_member_limit` and `assistance_accept_whatsapp`.<br>**Tests:** `assistance_cap.sql`; `ai_usage.sql` and `test_account_fence.sql` now set a budget in their fixtures. |
| 4 Storage screens | `6da8d46` to `e62edba` | **Catalogue and mirror.** Storage limits added to `src/lib/limits.ts`; `src/lib/storage-allowance.ts` mirrors the SQL, with a test that checks it against the migration.<br>**`/billing`.** A new storage card: usage, warnings, where the allowance comes from, blocks, the monthly charge (with a note for annual plans), any scheduled reduction, a dialog to change blocks (goes to the A2 price review), and a dialog for automatic blocks with the ceiling and acceptance.<br>**Uploads.** A refused upload tells the owners.<br>**Nightly job.** It now runs `cron_storage_measure`.<br>**`/admin/usage`.** Now a cost view only; the old "raise usage invoice" action (`raiseUsageInvoice`) is removed.<br>**Words.** Notices in English and Afrikaans. |
| 5 Assistance screens | `67874c7` to `ec2633b` | **No limit chosen.** The `budget_unset` refusal is handled in the ledger, the assistant, the voice and transcription routes, and WhatsApp voice.<br>**`/settings/ai`.** A setup card when no limit is chosen; the time zone, next reset and number of sites; a note when the limit was carried over; the paid WhatsApp acceptance dialog and a withdraw button.<br>**WhatsApp hooks.** `src/lib/whatsapp/paid.ts` holds alerts (utility) and replies (service) before sending; the webhook settles them from Meta's `pricing`.<br>**`/admin/ai`.** Rapid Rise sets the WhatsApp billing start date, the per-category USD rates and the supplier tax treatment. |
| 6 Documents | `67e9b61` to `ad774a2` | **Terms.** In `legal.ts`, "What it costs" now describes the one limit, paid WhatsApp and the storage pool; `TERMS_VERSION` bumped to 2026-11-18.<br>**Docs.** BILLING section 18; AI_USAGE "One spending limit per customer"; LIMITS "The storage pool"; PLAN_FEATURES; DATABASE; the requirement register rows; PROGRESS. |

## 2. Scenarios and requirements

| Scenario | Where it is tested |
|---|---|
| 24 | `storage_pool.sql` [24]:<br>- the 2 GB minimum and the 2.375 GB example;<br>- Essential's included equipment counted;<br>- a scheduled reduction shown, not applied early;<br>- a retired pump's file kept and still counted;<br>- files from before the pipeline counted, in the counted buckets only.<br>Also `storage-allowance.test.ts`. |
| 25 | `storage_pool.sql` [25]:<br>- full stops a photo at the main depot, because the North depot's file is in the same pool, to the byte;<br>- a form without attachments still saves, and nothing is removed;<br>- the owner is told once, never the manager, with no false alarm;<br>- the 80% and 95% warnings go out once each.<br>Also `upload/server.test.ts`. |
| 26 | `storage_pool.sql` [26]:<br>- automatic blocks off by default, and off again holds;<br>- R98 means two blocks in total, and a block bought by hand counts;<br>- demand after a purchase does not buy again;<br>- nothing in the grace;<br>- the lock is taken first.<br>`storage_blocks.sql` [26]:<br>- R24.50 for half a month;<br>- the block arrives only on payment, and a stale price is refused;<br>- a reduction is scheduled, refused below what is stored, and can be cancelled; buying more cancels it;<br>- the period invoice carries the reduced blocks plus the automatic part, once.<br>`storage_blocks.sql` [meter]: no download charges, and a past month is never rebuilt from today's storage. |
| 12 (storage and assistance half) | `storage_blocks.sql` [12]:<br>- an annual customer pays R49 on the usage invoice the day its storage month starts, once;<br>- the annual renewal carries one month only;<br>- a month already charged is never charged again.<br>`assistance_cap.sql` [31]: the reset time zone and date on the owner's page. |
| 30 | `assistance_cap.sql` [30] and [migrate]:<br>- no budget means `budget_unset`, for holds and for voice;<br>- the business's own OpenAI key is neither capped nor billed;<br>- blank is refused, zero is a clear "no", a positive limit works;<br>- carried-over limits match the old effective limits exactly. |
| 31 | `assistance_cap.sql` [31]:<br>- one R200 limit holds across two sites with holds still in flight;<br>- settling releases the unused part;<br>- the hold is the customer charge including the 30% margin;<br>- a per-person limit holds at both sites, and a large one never lifts the customer limit;<br>- the trial guard, the per-customer lock, the owner's page. |
| 32 | `assistance_cap.sql` [32]:<br>- WhatsApp is not held while billing is off;<br>- owner acceptance is required, with evidence;<br>- an unpriced category is refused;<br>- free means R0; billable means cost + 30% with the full record;<br>- a repeated status settles once;<br>- failed and refused messages leave a R0 row; no status in 72 hours means R0, with the estimate kept;<br>- in the grace, `billing_paused`.<br>Also `whatsapp/paid.test.ts` and `delivery.test.ts` (held, refused and failed sends). |

**Register rows:**
- **Closed or moved to E:** R-010, R-075, R-076, R-077, R-078, R-080, R-081, and the usage part of R-083.
- **Moved to X (built, awaiting external checks):** R-082 and R-086.
- **Inventory items:** I-030 and I-032 resolved. I-041 is still open.

## 3. Not done

- **Usage corrections as account credit.** The A2 credit ledger could hold them, but there is no admin action and no `source` value for it.
- **Reconciliation against provider invoices.** Not built; the ledger now records what it needs (provider id, rate version, cost).
- **Changing the margin with notice to owners** (listed as "not built yet" in AI_USAGE). Not built.
- **No browser run.** The new cards, dialogs and the upload message are type-checked and linted only.
- **No live checks.** No real WhatsApp delivery status, real Paystack payment or real Storage objects. Truly simultaneous uploads near the limit are proven by the lock, not by two live sessions.
- **No app-wide storage warning banner.** Owners get notices, and everyone can see the level on `/billing`.

## 4. Assumptions (flag any that are wrong)

1. **"Full spaces" in the formula** means purchased full spaces, at least the minimum. A subscription with no quota uses what is counted.
2. **"Equipment spaces"** means the included spaces plus the extra paid for. A subscription with no quota uses what is in use.
3. **The storage month** is the billing period for monthly customers. For annual customers it steps month by month from the period start, on the anchor day.
4. **An automatic block's charge** for the rest of the month goes on the next invoice, and the block exists at once. The owner's switch, with its ceiling, counts as acceptance in advance.
5. **Exempt and unsubscribed businesses** get the formula allowance and no automatic blocks. A block bought by hand is free for an exempt business. `app.storage_quota_overrides` still wins when set.
6. **Orphan objects** in a business's folders count against it, like any other stored copy.
7. **The carried-over limit** is the billing site's own setting, or R200 if it had none. The trial guard keeps every current effective limit unchanged.
8. **Alerts are utility templates; replies are service messages.** Rates are in USD per message, because ZAR was not in Meta's currency list. An account billed in another currency needs a code change first.
9. **When WhatsApp billing is on,** a reply that cannot be held (no acceptance, limit reached) is not sent on WhatsApp. The app still has everything.

## 5. Risks, most important first

1. **Uploads now have a limit.** Until this migration, pipeline uploads were unlimited. A business already over its allowance on the day can no longer add attachments; nothing is deleted. Production holds only test accounts, so this should be safe, but check stored sizes first.
2. **Deploy order matters.** Apply `20261118120000`, `20261118120100` and `20261118120200` in that order, then deploy at once. The new `/billing` reads columns these migrations add, and the old `/admin/usage` invoice path must not outlive them.
3. **New businesses start with paid help off.** Anyone created after the migration has no budget until the owner chooses one. That is the decision, but expect questions.
4. **Copied functions.** Four A2 quote functions, the invoice run and the usage invoice run are copies with storage branches added. Any later change must start from these copies, not the originals.
5. **A second usage invoice on the same day** for one customer now fails with an error instead of being skipped.
6. **The terms changed** (`TERMS_VERSION` 2026-11-18) and need a lawyer's read, like A2's.
7. **Annual customers buying blocks mid-month** use the storage month; this is tested on fixtures only.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| WhatsApp billing | On `/admin/ai`, enter the utility and service rates from the WhatsApp account's own rate card (and confirm the account is billed in USD), then set the start date. Until then WhatsApp sends exactly as today and is not charged. |
| Supplier tax treatment | An accountant confirms how the AI Gateway, Azure and Meta invoices are taxed for Rapid Rise. Record it on `/admin/ai`; every usage row records it. |
| Legal read | A lawyer reads the changed "What it costs" clauses in `src/lib/legal.ts`. |
| Real checks | A staging run: fill storage, buy a block with a test card, switch automatic storage on, choose and change a limit, send a real WhatsApp message and check its delivery pricing. Then `ui:check` on `/billing` and `/settings/ai` in English and Afrikaans at 360 and 1024 px. |
| Release | Apply the three migrations in order (each has a probe in `scripts/apply_pending.mjs`) and deploy straight away. |

## 7. Handover

- **A4 (exports and deletion):** count `storage_usage_snapshots` and `storage_charges` among a business's records. Deleting files after the 90 days must go through Storage and set `upload_intents.object_removed_at`. The pool keeps counting a file with no upload record until it is actually gone.
- **A5 (website and help):** use the storage allowance; R49 blocks, billed monthly also for annual plans; "no download charges"; one owner-chosen spending limit with no default. Do not advertise paid WhatsApp as live until the real-phone checks pass. The in-app wording is under `billing.storage*` and `aiUsage.*`.
- **A6 (release):** add the three migrations and the new nightly step `storage_measure` to the release sequence. Watch `cron:storage_measure` and `upload:storage-note-full`.
- **B4 (WhatsApp):** `src/lib/whatsapp/paid.ts` and its two hooks in `worker.ts` are the metering. Keep holding before every outgoing message and settling from the status `pricing`. WhatsApp media sends need the same hold. `app.whatsapp_member` and the grace rule are unchanged.
- **Any lane:** a test fixture that reserves paid AI now needs an `assistance_budgets` row. Storage months use `app.billing_today()` and the invoice run uses `current_date`; the two differ between 22:00 and 24:00 UTC. In this harness, a shell command containing `=>` hangs, so edit files through a script file instead.
