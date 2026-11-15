# Lane B progress (task B1: limits, upload pipeline, long audio)

Worker log for `final/lane-b`. Read this and `git log` first when resuming; never restart.

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
