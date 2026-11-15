# Report B1: limits catalogue, direct uploads, photo reduction, ten-minute audio

Saved by the runner from the worker's final message (the worker's harness refused to write this file). Text unchanged.

All seven steps are built and committed on `final/lane-b`. The last commit is `2832e41`. I did not push or merge anything, and I applied no migration anywhere except the local test database.

The harness would not let me write `docs/final-dev/REPORT-B1.md`, so the full report is this message. `PROGRESS-lane-b.md` says "TASK B1 COMPLETE" and points here.

**Gates at `3fe0004`** (the last code commit; everything after it is the progress file only): typecheck clean, 1151 unit tests pass, and dashes, i18n parity, i18n keys, design lint and errors are all green. `migrate_check --suite` passes all 78 SQL suites on PGlite. CI on real Postgres has not been run.

## What was done

| Step | Result | Commits |
|---|---|---|
| 1 | **One limits catalogue.** `src/lib/limits.ts` labels every limit as commercial, abuse protection, provider restriction or display window. Media limits are decimal: photo 20 MB, PDF 50 MB, voice note 10 min / 20 MB, spoken command 10 min, no video. Every cap in the code now reads from it. `docs/LIMITS.md` lists each cap with file, line, old and new value. A test fails on any raw byte size elsewhere under `src/`; I broke it on purpose to confirm it fails. | `3a32f17` |
| 2 | **Upload pipeline.** Migration `20261115090000`: the `upload_intents` table and the begin / verify / commit / fail functions. Quota is reserved under one lock per storage pool, against a server-chosen path. Bucket limits are raised and a private `command-audio` bucket is added. A nightly sweep removes lapsed and refused uploads. The server checks each file's real bytes, not its name or declared type. The browser uses one signed upload up to 6 MB, and a small resumable (TUS) client I wrote above that. A reusable `UploadField` control shows progress, pause, carry on and try again. | `d75303a` `a4be848` `63e79e5` `a265350` `9e09ee0` |
| 3 | **Every attachment path moved onto it:** machine photos, faults (online, offline queue, member QR), job cards, work requests, finance documents, supplier documents, receipts, trip delivery photos, billing proofs and checklists. Older installed pages that still post the file directly keep working. | `e1aa817` … `1c18eff` |
| 4 | **One photo reducer** with a "Keep the original photo" option: long edge 2560 px, quality 0.85, PDFs untouched. | `5870ccd` |
| 5 | **Ten-minute audio.** Migration `20261115100000`: spoken-command jobs with a lease, a retry limit, cancel and "try again". Hearing goes through the existing AI usage hold, sized for the whole recording, in one call to the transcription provider. A `/api/assistant/commands` route runs the job inside a request the browser polls (within the 300 s limit). Live dictation and offline recording now run to 10 minutes, with a warning 30 s before the end. Spoken requests can hold 16,000 characters. Command audio is deleted once the command is done and kept 72 hours (an engineering default, not a contractual term) when it fails. Attached voice notes are never touched. | `b188acc` … `4124a9d` |
| 7 | **Docs:** `LIMITS.md`, `DATABASE.md`, and a short upload threat model in `SECURITY.md` (section 5e). | `3fe0004` |

Both migrations are additive and safe on the live data:
- New tables and functions only.
- Bucket limits are raised; stored files are untouched.
- The transcript length checks are widened without locking writes (`NOT VALID`, then `VALIDATE`).
- Each migration has a probe in `apply_pending.mjs`, a SQL suite in `run.sh`, a fence exemption and a `DATABASE.md` line.

## Scenarios and the tests that cover them

- **21** (boundaries, spoofed and malformed files): `sniff.test.ts`, `upload_pipeline.sql`, `server.test.ts`.
  - Just below, at and above each byte and duration limit.
  - A PDF named .jpg, and an executable labelled as an image.
  - A truncated PDF, and a 65,535 x 65,535 image header.
  - An unsupported codec, and a video track.
  - A file whose real type differs from the declared one.
- **22** (ten-minute recordings): `command-transcribe.test.ts` builds a ten-minute recording in memory and takes it through file checking, the full ten-minute AI budget hold and one whole-file provider call. Only the provider is mocked. Also `request-length.test.ts`, `command-client.test.ts` and `command_audio_jobs.sql`.
- **23** (interrupted, expired, repeated, revoked, near quota): `client.test.ts`, `server.test.ts`, `upload_pipeline.sql`.
  - An upload dropped after two chunks resumes and sends only the missing chunks.
  - Pause works, and an expired upload link starts afresh.
  - A file that never arrived keeps its reservation.
  - Calling finalise twice after a lost response saves one attachment.
  - A member removed between start and save cannot save it.
  - The quota fills to the byte: 30 MB is accepted, one byte more is refused.
- **27** (photo reduction): `compress.test.ts`.
- **28** (command audio cleanup): `command_audio_jobs.sql`, `sweep.test.ts`, `command-client.test.ts`.

I broke 16 database guards one at a time and each was caught by a failing test.

## Not done, and why

- **Truly simultaneous uploads near the quota are not tested.** PGlite has one connection. The arithmetic is tested to the byte, and every reservation takes a per-pool advisory lock.
- **A long request containing several changes is confirmed one change per turn.** The assistant stops at its first proposed change, so nothing is created silently, but the changes are not listed together for one confirmation.
- **A receipt chosen while creating a new expense still goes with the form**, so it is capped at 4.5 MB. Attaching a receipt to an existing expense uses the pipeline.
- **The rule that stops direct Storage writes outside a reserved path is off,** so older open pages keep working. After release run: `update app.upload_settings set enforce_reserved_paths = true, updated_at = now();`
- **Checklist retry edge case.** If a checklist's answers fail to save, the next retry on the same screen fails until the page is reloaded.
- **No `BUILD_LOG.md` entry.** I left it for the merge to avoid a conflict in a shared file.

## Assumptions

- **Supabase upload details are from its documentation and example code:** the 6 MB resumable threshold, 6 MiB chunks, and the signed resumable endpoint `/storage/v1/upload/resumable/sign` (Supabase's Uppy example).
- **Uploads go to `<project>.supabase.co`.** Supabase recommends its faster storage host, but the content security policy allows only the main Supabase address. I did not widen the policy.
- **I wrote a small resumable-upload client** instead of adding the `tus-js-client` package.
- **Some uploads don't count against a customer's storage pool:** billing proofs and command audio. Contractor receipts belong to the workshop, not a farm pool.

## Risks

- **Not run against a real Supabase project:** signed uploads, resumable uploads with the upload token, and range reads of stored files.
- **AI Gateway request size limit is unknown** for 4 to 20 MB audio. A farm's own OpenAI key goes direct to OpenAI, which documents a 25 MB limit.
- **Ten-minute live dictation is unchecked:** it depends on the voice meter rolling its two-minute sessions, and `voice:check` was not run.

## External blockers: the exact human actions

1. **Raise the Supabase upload limit.** In the dashboard, open Storage, Settings, "Global file size limit", and set it to at least 50 MB. Until then, set `UPLOAD_GLOBAL_LIMIT_BYTES` in Vercel to the current value so larger files are refused up front with a clear message.
2. **Check on real phones with real credentials:**
   - A ten-minute recording on Android Chrome (WebM/Opus) and on iPhone Safari (MP4/AAC), through upload, job, transcript and confirmation.
   - A 45 to 50 MB PDF on a job card.
   - An upload interrupted by switching off mobile data.
   - A reduced photo of a real serial plate, read back.
3. **After release**, once no older page is in use, run the enforcement SQL above.

## For later tasks

- **A3:** replace `app.storage_quota_bytes` and `app.storage_pool_farm_ids` with the pooled customer allowance. Files uploaded before the pipeline are not yet counted in the pool.
- **B2:** for chat attachments, add `chat_message` as an upload target kind and use `UploadField`.
- **B4:** WhatsApp media can be staged through `upload_intents` and the same file checks. The WhatsApp limits stay unchanged in the catalogue, labelled as provider restrictions.
