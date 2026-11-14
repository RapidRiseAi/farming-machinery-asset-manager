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

## In progress

Step 2b (WIP, committed): `src/lib/upload/protocol.ts` (target kinds, codes, begin answer),
`src/lib/upload/server.ts` (beginUpload, verifyUpload with range reads, commitUpload,
failUpload, storageReader, error mapping, UPLOAD_GLOBAL_LIMIT_BYTES readiness),
`/api/uploads/begin`, `/api/uploads/finalise` (generic attachments). Still to do in 2b:
unit tests for server.ts with fake db/svc/reader (lost response, expired, revoked,
spoofed), i18n sentences for every UploadCode in errors.ts + en/af, nightly sweep step
(`src/lib/upload/sweep.ts` + step in cron/nightly). Then 2c client helper
(`src/lib/upload/client.ts`, `tus.ts`, `src/components/ui/upload-field.tsx`).

## Next

Step 3.

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
