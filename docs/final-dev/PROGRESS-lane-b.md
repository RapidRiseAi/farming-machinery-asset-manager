# Lane B progress (all lane B tasks complete: B6, B5, B4, B3, B1 below)

## Task B6 (started 19 Nov 2026 at ca29985, by the main Claude session)

Inventory: no Capacitor or native code exists. The web recorder (`src/components/map/route-recorder.tsx`) needs the
screen kept on and holds at most 200 points in memory; `/api/positions` takes 200 points of at most 24 hours for a
running driving session. `routeLine` joins every point into one line, so a data gap is drawn and counted as driven
km (a defect against "no route inferred across a data gap"). Android Studio is installed (JBR 21); no Android SDK.
Plan:
1. Gaps: split driven routes at time gaps and impossible jumps (routeSegments), draw segments separately, count only
   recorded km and say when there were gaps (trip card, map page).
2. Current docs: Capacitor, the background-geolocation plugin, Android foreground-service location rules, Play
   policy (background location, foreground service declarations), App Links, WebView file chooser and CSP.
3. Capacitor Android project loading the hosted app: config, offline fallback page, permissions and foreground
   service declarations, deep links (App Links) for emailed links, external links to the system browser.
4. Web side: native bridge; background recording tied to the driving session's start and stop, through a foreground
   service; a persistent queue bound to the person, retry with backoff, dropped on logout or account change; stop on
   the session ending (409); push marked unavailable in the app unless native push is configured.
5. Debug build artifact (Android SDK install), docs/ANDROID.md (build, signing, Play listing, declarations, real-
   device test steps, iPhone limits), tests, report.

Step 1 DONE (1681265): routeSegments/segmentsKm, offRouteSegments, trip card and /map draw and count piece by piece.
Step 2 DONE: docs read (Capacitor 8 guide and config, plugin README/manifest/source, Android FGS and notification
permission, Play FGS declaration, App Links verification, Capacitor Android source for cookies and bridge injection).
Steps 3-4 DONE: Capacitor 8.6.2, plugin 1.3.1, @capacitor/app 8.1.2 (pinned); capacitor.config.ts; android/ with
manifest hardening, icons, splash, notification resources, release signing from an untracked keystore; src/lib/native
(platform, links, position-queue, recorder, asset-links); NativeLinks, NativeSession; recorder native branch with
disclosure; sign-out clears; push marked unavailable; /.well-known/assetlinks.json from env.
Step 5: local SDK download measured at ~22 KB/s from dl.google.com (npm 675 KB/s): stopped, empty folders removed;
debug APK built by .github/workflows/android.yml instead. docs/ANDROID.md, REPORT-B6.md. Mutations 13/13 TS.
Gates at 5f6ccfa: tsc, unit 1295, statics, eslint on changed files, pnpm build, audit.

## TASK B6 COMPLETE

19 Nov 2026. Report: docs/final-dev/REPORT-B6.md. Android build verified in CI at integration. Lane B is done; next
is A6 on lane A.

## Task B5 (started 19 Nov 2026 at 3b552e8, by the main Claude session)

Inventory: no custom fields, staging, OCR or manuals code exists; only pdf-lib is installed (it splits
PDFs, it cannot read text). Plan:
1. Custom asset fields (Professional and Complete): definitions, typed values, validation, visibility,
   groups, rename and retire without losing values, audit, CSV import and export mapping, isolation;
   no billing or engine effect; equipment may use them.
2. Structured import staging: import_batches / import_rows, mapping, type, date and unit validation,
   duplicates, preview, explicit confirmation; uncertain values stay uncertain.
3. OCR adapter interface behind the readiness flag document_extraction (off). Live provider use on
   Professional waits for the founder's cost decision; on Complete only through the approved AI path
   under the A3 spending limit. Manual capture never depends on it.
4. Manuals questions on Complete behind the flag manual_questions (off): private ingestion, pages read
   through the approved AI path under the spending limit (bounded), Postgres full-text index, a
   read-only agent tool with document and page citations, permission filtering, reindex and delete,
   "no supporting evidence" when nothing matches, no second storage charge.
5. Old roadmap entries classified in the register with evidence.
6. Tests (scenario 44), docs, report.

Step 1 DONE (ac11f87 to the commit after d06989a): migration 20261121100000 (probe, suite custom_asset_fields.sql,
DATABASE.md); custom_fields on Professional in app.feature_min_rank and CAPABILITY_MIN_PLAN (entitlements.test now
reads the latest definitions); /settings/fields, the asset card and dialog, Settings link, EN/AF, error codes; the
business export lists both tables (asset_field_values got a paging id); the machine import carries field:<key>
columns and applies them through asset_field_set, reporting skipped values. Mutations 10/10 SQL. Unit 1256 pass.
Step 2 DONE (4c5bde4 to the commit after 1f2dc3d): migration 20261121110000 (import_batches, import_rows,
import_batch_open / import_rows_stage / import_row_decide / import_rows_bulk / import_batch_confirm / import_batch_cancel;
flag document_extraction off; documents need the tco rank = Professional and Complete per the brief). Every doubt is
a named issue; a doubtful asset, date or reading is accepted only with the person's own value for that field (the
dialog leaves it empty); bulk accepts only rows with no issue; confirm re-checks and writes once; same file reopens
its batch. Provider fields are untrusted (bad confidence = uncertain, bad row = invalid, 4000-char row cap). Suite
import_staging.sql registered, probe, DATABASE.md, 10 error codes EN/AF. Mutations 31/31 (two first-run survivors were
faulty mutations: to_date also refuses 30/02; "false and A or B" left B active). /imports list + /imports/[id] review,
template CSV, Machines menu entry. Unit 1264 pass; pay-gate, fence and deploy-compatibility suites pass.
Step 3 DONE: import_batch_open takes p_provider (a document names its reader, a sheet none); src/lib/extraction
(provider interface, rowsFromExtraction: missing or bad confidence = 0, pages outside dropped, text cleaned and
bounded; runExtraction: Essential refused, Professional cost_undecided, Complete inside a hold); shared runHeld
(src/lib/extraction/held.ts: hold first, no call without it, settle always, unusable = charged/not billed);
startDocumentImport (bytes decide the type) and a dialog shown only when provider + flag + plan. Adapter mutations 9/9.
Step 4 DONE: migration 20261121120000 (manual_index, manual_pages with simple tsvector, invoker manual_search with
filler-word filter and cap 8, manual_index_put service-only, manual_index_remove, soft-delete trigger, flag
manual_questions off, Complete via voice_ai rank); src/lib/manuals.ts (reader none, pagesForIndex, runManualRead,
searchManuals with cite and no-evidence note); assistant search_manuals only when manual_questions_available, prompt
rule; asset Manuals card (upload PDF, make searchable, read again, remove) gated; export lists import_batches,
import_rows, manual_index. SQL mutations 16/18 (2 equivalent: attachments RLS already confines the farm; EXECUTE is
revoked from people), TS 11/11.
Step 5 DONE: register R-110 (E staging, X adapter), R-111 E, R-112 X; I-050..I-061 re-checked unchanged.
Step 6: full SQL run found audit_redaction (no app.audit_table_rules for five new tables, since step 1): rules
added, farm scope. FOUNDER-DECISIONS-PENDING 12 (provider and Professional price) and 13 (assumptions) added.
Full gates at 43a384f: tsc clean, unit 1281 pass, statics clean, SQL suites 101/101. REPORT-B5.md written.

## TASK B5 COMPLETE

19 Nov 2026. Report: docs/final-dev/REPORT-B5.md. Next on lane B: B6 (Android app).

Worker log for `final/lane-b`. Read this and `git log` first when resuming; never restart.

## Task B4 (started 19 Nov 2026 at 6613701, by the main Claude session itself: the founder ended subagents)

Plan (gaps found by comparing BRIEF 13 / 12 last paragraph with the November adapters):
1. Capability flags per path (text, alerts, photos, voice) in feature_flags; text and alerts
   were real-phone verified 17 and 18 Oct (docs/WHATSAPP.md), photos and voice were not.
2. Provider media limits from current Meta documentation, cited, in src/lib/limits.ts.
3. WhatsApp photos staged through B1's upload pipeline (upload_intents, sniffing, A3's pool),
   not straight into fault-photos.
4. Secure app upload link (signed-in, bound to user, site and target) for files WhatsApp
   cannot carry (oversized voice or photo, documents).
5. Replay protection for assistant turns and hearings per inbound message id (B3 handover).
6. Delivery statuses monotonic under out-of-order events; media fetch refuses non-Meta hosts.
7. Equipment-aware assistant: tools refuse equipment-forbidden work with the A1 codes; chat,
   documents and transcripts are data; one proposal per turn (scenario 36).
8. Tests (scenarios 33, 36), docs/WHATSAPP.md, report.

## TASK B4 COMPLETE

All eight steps done (report: docs/final-dev/REPORT-B4.md). Migration 20261121090000 (probe, suite
whatsapp_completion.sql, DATABASE.md line). Gates: tsc clean, 1243 unit tests, dashes, i18n parity and keys,
design, errors clean; 98/98 SQL suites on PGlite. Mutations: 11/11 SQL and 5/5 TS guards caught.
External: real-phone journeys before photos and voice are released (flags stay off).

## Task B3 (started 18 Nov 2026 at 45e5efd)

## TASK B3 COMPLETE

Final gates at the last commit: tsc clean; 1209 unit tests pass (1 skipped); dashes, i18n
parity and keys, design lint, errors clean; node scripts/migrate_check.mjs --suite 94/94
PASS (PGlite). The harness refused docs/final-dev/REPORT-B3.md: the full report is the
worker's final message. Six migrations 20261119090000 to 20261119140000, all probed.
Blocker: founder reads Mapbox's current Product Terms on storing routes before the map
flag is released (docs/ROUTING.md).

Driving logs, trips and maps by plan; imports, repeat taps, offline gaps; history after a
downgrade. R-044 (manual driving log, Codex, 20261117110000) is built and reviewed: verify
and build on it, never rebuild. Steps, committed one by one:

1. Trips by plan (R-045, R-061, R-060): server gate on every trip action and RPC (DB
   trigger on trip updates too), saved trips readable after a downgrade (history mode),
   trip money on the phone (income, expenses, result), report honesty (cancelled and
   incomplete trips, missing readings, zero km, 90-day window said), aggregation moved to
   src/lib/trips.ts with tests.
2. Maps (R-046, R-062): readiness flag enforced in the database for positions and routes,
   POD location only with maps, stale positions labelled (never live), docs/ROUTING.md
   provider terms rechecked with citations.
3. Downgrade history (R-051, Sc17): fuel and fines records readable read-only, retained
   positions listed without a map, export includes trips/routes/positions, scheduled
   reports and CSV routes refuse lost features.
4. Imports (R-120): duplicates beyond the name, error codes through t(), create-only said.
5. Repeat taps (R-122): work media claim, assistant turn and transcribe claims, activation
   Pay resumes the attempt in flight, contractor sync verified, template once per machine.
6. Offline (R-123): online request id becomes the offline client id, claims checked in
   SQL, plan/equipment/access refusals kept and explained (not retried forever).
7. Export pages streamed, accounting summary in SQL, weekly digest once a week with
   catch-up and pay gate, empty states, assistant starters never send.
8. Scenario 18 check, docs, REPORT-B3, register rows.

### B3 done

- Step 1 DB (72f7085..a694d6d): migration 20261119090000_trips_maps_history.sql (plan gate
  on updates of saved trips/loads/money with cancel and finish-underway exceptions; map
  readiness in the database for routes and positions; POD location only with maps; a
  trip's driver must be a member of the business). Suite trips_by_plan.sql PASSES, in
  run.sh; probe; DATABASE.md; history guard mutation caught.
- Step 1 TS (4b0e67b): tripReport/tripResultCents in src/lib/trips.ts with tests.
- Step 1 done (e77f6f3): report page (window said, cancelled/unfinished/missing readings,
  per-km from trips with readings, Professional only), trip page history mode + result,
  plan checks in actions, error words.
- Step 2 done: ROUTING.md provider recheck (Mapbox route storage = maps release blocker,
  tiles need a production source), positions labelled with age/last known (never live),
  positionRecentMs + tripReportWindowDays in limits.ts, tracker feed refused plainly after
  a downgrade. Full SQL suite 88/88 after fixture fixes (82b1a86).
- Step 3 (mostly done): SavedRecords frame; fuel and fines history read-only; export paged
  (cap 50,000) with trips/routes/positions/fuel cards; retained positions on a trip without
  maps (TripSavedTracking + /trips/[id]/positions.csv); migration 20261119100000 (AARTO
  reminders by plan and open business, digest once a week with catch-up), suite
  scheduled_work_by_plan.sql. Scheduled reports and API access were already plan-gated.
- Step 4 done: import refuses repeats of unidentified rows (machineKey), refusal codes in
  words; csv.test.ts; 3/3 mutations.
- Step 5 done: work media claim (route test), respondOnce for assistant turn and
  transcribe (content digest id), migration 20261119110000 (64 KiB outcomes, nightly claim
  sweep), activation Pay resumes the open checkout, contractor sync verified by test,
  migration 20261119120000 (template once per machine). All mutations caught.
- Step 6 done: queued capture keeps the online request id; migration 20261119130000
  (apply_offline_capture_once, claim_request answers a capture id, fuel plan asked again);
  sync refusals classified; queue reasons EN/AF. 7/7 mutations.
- Step 7 done: export paged (step 3), migration 20261119140000 (journal summary in SQL),
  digest once a week (step 3 migration), empty states, starters guard test.
- Step 8: sites_roles_consolidated.sql (scenario 18), PLAN_FEATURES.md downgrade table,
  register rows, LAUNCH_CHECKLIST. Report: the harness refused REPORT-B3.md, so the full
  report is the final message.

## Task

B1 from `C:\projects\output\fleetwise-final-dev\MASTER-PLAN.md`: BRIEF sections 9 and 10
(limits catalogue, upload pipeline, compression, long audio, command-audio cleanup),
decisions 8 to 13, scenarios 21, 22, 23, 27, 28. Steps, committed one by one:

1. Limits catalogue (`src/lib/limits.ts`) + inventory `docs/LIMITS.md` + guard test.
2. Upload pipeline: `upload_intents`, reservation, signed direct upload (TUS above the
   threshold), finalisation with byte sniffing, nightly expiry sweep, storage policies,
   bucket configuration.
3. Every attachment path onto the pipeline (machine photos, faults online/offline/QR,
   job cards, work requests, checklists, finance docs, partner documents and receipts,
   trip photos, billing proofs).
4. One shared photo compressor with keep-original.
5. Long audio: 10-minute voice notes and spoken commands, durable transcription job,
   command-audio cleanup and recovery window.
6. Tests for scenarios 21, 22, 23, 27, 28.
7. Docs: LIMITS, DATABASE, SECURITY.

## Done

- Step 1, limits catalogue: `src/lib/limits.ts` (every limit labelled commercial, abuse,
  provider or window; media classes; bucket table), `src/lib/limits.test.ts` (no raw byte
  size anywhere else under src/, mutation-tested by re-adding `8 * 1024 * 1024` to
  jobcard-media.ts; bucket and class invariants), `docs/LIMITS.md` (inventory with file and
  line at 6e3830a, old and new values, provider citations, the human action). Every cap in
  the inventory now reads the catalogue. Gates green: tsc, 1081 unit tests, dashes, i18n
  parity and keys, design lint, errors, migrate_check --suite (73 suites PASS).

- Step 2a, `d75303a`: migration `20261115090000_upload_pipeline.sql` (upload_intents,
  upload_begin / upload_mark_verified / upload_commit / upload_fail, sweep, quota hooks,
  bucket limits, command-audio bucket, inert reserved-path Storage policies), suite
  `supabase/tests/upload_pipeline.sql` (in run.sh), probe in apply_pending, fence trigger
  and exemption, DATABASE.md; `src/lib/upload/sniff.ts` + `media-fixtures.ts` + tests.
  Mutation-tested 7 SQL guards (scratchpad b1/mutate.mjs; all killed).

- Step 2 complete (2a d75303a database, 2b a4be848 + 63e79e5 server, 2c a265350 + 9e09ee0
  client, TUS, UploadField). Full gates green at 1c18eff: tsc, 1138 unit tests, dashes,
  i18n parity and keys, design lint, errors, migrate_check --suite (77 suites).
- Step 3 complete (e1aa817 .. 1c18eff): every attachment path uploads straight to Storage
  and finishes through the pipeline, older pages' multipart still accepted:
  machine gallery and add-vehicle photo; faults online, offline queue and member QR (fault
  first in a small request, then files with stableRequestId(client_id|field, file), farm id
  now in /api/sync and /api/public/fault answers); job card media; work request media;
  finance documents; supplier documents (/api/documents/upload, commits on every success
  answer); receipts attached to an expense; trip delivery photo; billing proofs (a refusal
  asks whether a payment already names the proof before removing it); checklist photos
  (client-chosen instance id). The sweep finishes, never removes, a file a record uses.
- Step 4 largely done (5870ccd): src/lib/upload/compress.ts used by UploadField, fault
  capture and checklists. Still to note in LIMITS.md "Photo reduction".

- Step 4 complete (5870ccd): src/lib/upload/compress.ts (2560 px long edge, quality 0.85,
  keep-original, PDFs untouched, original kept when decode/encode fails or would grow),
  used everywhere a photo is chosen; LIMITS.md "Photo reduction".
- Step 5 complete (b188acc .. 4124a9d): migration 20261115100000_command_audio_jobs.sql
  (assistant_command_jobs, start/claim/cancel/retry/record, command audio sweep, spoken
  requests to 16,000 characters), suite command_audio_jobs.sql (7 guards mutation-tested),
  src/lib/assistant/command-transcribe.ts (ledger hold for the whole recording, one call,
  fallback on failure only), /api/assistant/commands (start, run, status, done, cancel,
  retry; maxDuration 300), nightly command_audio_sweep, command-client.ts, assistant client
  (live dictation and offline recording to ten minutes, 30-second warning, long recordings
  heard by the job, done removes the audio), fault voice notes to ten minutes.
- Step 6 complete: scenario tests listed in the final report.
- Step 7 complete (3fe0004): LIMITS.md, DATABASE.md, SECURITY.md section 5e.
- Final gates at 3fe0004: tsc, 1151 unit tests, dashes, i18n parity and keys, design lint,
  errors, migrate_check --suite (78 suites PASS).

## TASK B1 COMPLETE

Report: the harness refused to write docs/final-dev/REPORT-B1.md, so the full report is the
worker's final message (the runner saves it).

## For later tasks

- A3: replace app.storage_quota_bytes(farm) (null = no limit; app.storage_quota_overrides
  for a hand-set figure) and app.storage_pool_farm_ids(farm) with the pooled customer
  allowance and paid blocks; app.storage_pool_usage counts finalised pipeline files plus
  open reservations; files stored before the pipeline are not in it (A3 measures real
  usage). The reservation lock is per pool (min farm id of the pool).
- B2: chat attachments use the pipeline: add 'chat_message' to upload_intents target_kind,
  app.upload_bucket_for and app.upload_target_problem (membership of the conversation),
  then UploadField with finish "caller".
- B4: WhatsApp media staging can stage through upload_intents (service-side begin) and the
  same sniff/verify; the WhatsApp limits stay labelled provider in limits.ts.

## Known limits of what is built

- A new expense's receipt chosen in the create form still goes with the form (4.5 MB
  bound): that form does not choose the expense id first. Attaching a receipt afterwards
  uses the pipeline.
- A checklist whose value rows fail to save soft-deletes its inspection; a retry with the
  same screen then collides with that id and fails. Rare; the person reloads the page.
- app.upload_settings.enforce_reserved_paths is off. Switch it on (SQL below) once the
  release is live and no older page is in use: update app.upload_settings set
  enforce_reserved_paths = true, updated_at = now();

## Decisions and assumptions

- Provider facts read 13 Nov 2026 (cited in docs/LIMITS.md):
  - Supabase standard uploads: "ideal for small files that are not larger than 6MB";
    "we recommend using TUS Resumable Upload for uploading files greater than 6MB"
    (https://supabase.com/docs/guides/storage/uploads/standard-uploads).
  - Supabase resumable: chunk size "must be set to 6MB (for now)" (example uses
    `6 * 1024 * 1024`); upload URL valid up to 24 hours; signed upload tokens go in the
    `x-signature` header; the signed TUS endpoint is `/storage/v1/upload/resumable/sign`
    (Supabase's own example, examples/storage/resumable-upload-signed-uppy)
    (https://supabase.com/docs/guides/storage/uploads/resumable-uploads).
  - `createSignedUploadUrl`: valid 2 hours; individual signed URLs cannot be revoked.
  - Global file size limit: Free cannot exceed 50 MB, Pro up to 500 GB; a bucket limit
    cannot exceed the global one (https://supabase.com/docs/guides/storage/uploads/file-limits).
  - Vercel Functions: request or response body 4.5 MB, 413 FUNCTION_PAYLOAD_TOO_LARGE;
    300 s default and maximum on Hobby, 800 s max on Pro (https://vercel.com/docs/functions/limitations,
    page dated 2026-08-24).
- The CSP allows the browser only `NEXT_PUBLIC_SUPABASE_URL`'s origin, so uploads go to
  `<project>.supabase.co/storage/v1/...`, not the `storage.supabase.co` host Supabase
  recommends for speed. Not widened.
- No TUS package in node_modules; a small TUS 1.0 client is written in-house
  (`src/lib/upload/tus.ts`) rather than adding tus-js-client.

## Blockers (human actions)

- Supabase dashboard, Storage, Settings: the project's global file size limit must be at
  least 50 MB (50,000,000 bytes) for PDFs to reach 50 MB. See docs/LIMITS.md.
