# Limits

Every size, duration, count and window limit FLEETWISE applies, by channel, and where each
one lives. The single source in code is `src/lib/limits.ts` (the catalogue); this file
explains it. `src/lib/limits.test.ts` fails when a raw byte size is written anywhere else
under `src/`, and checks the buckets against the catalogue.

Every limit has a kind:

- **Commercial**: what the customer was promised (founder decisions 8 to 11, 12 November
  2026). The website, help and the plan PDF quote these.
- **Abuse protection**: an operational guard against runaway or hostile use, not a promise.
- **Provider restriction**: imposed by Vercel, Supabase, Meta or Azure, quoted from their
  documentation with the date it was read.
- **Display or query window**: how much a screen or query handles at once. A page size is
  never a contractual history limit.

The new media limits are in **decimal** units: 1 MB = 1,000,000 bytes, the same convention
as the storage allowance (decision 14). Older caps set in binary units on purpose keep them
and say so (the fuel-card CSV's 2 MiB, the partner logo bucket's 2 MiB).

## What a customer can attach (commercial)

| Media | In the app | Through WhatsApp (provider restriction) |
|---|---|---|
| Photo | 20 MB (20,000,000 bytes) | 6 MiB (unchanged until task B4) |
| PDF | 50 MB (50,000,000 bytes), stored unchanged | not offered |
| Recorded voice note | 10 minutes and 20 MB | 3 minutes and 4 MiB (unchanged until B4) |
| Spoken assistant command | up to 10 minutes | voice note limits above |
| Video | not supported at launch | not supported |

Ordinary photos are reduced in the browser to a 2560-pixel long edge at JPEG quality 85
unless the person ticks "Keep original" (see "Photo reduction" below). PDFs are never altered.
A recording warns 30 seconds before its time limit and stops itself at the limit, keeping
what was captured.

Text, forms, records, downloads and existing files are never limited by these caps. A
file larger than allowed is refused with a translated sentence and the person's typed text
and chosen file stay in the form.

## How a file travels

Large file bodies never pass through a Vercel function (BRIEF section 10). The browser
asks the server to begin an upload, the server checks the person, the record, the plan, the
limits and the storage quota, reserves the space and returns a signed upload for one exact
private path; the browser sends the file straight to Supabase Storage (one signed PUT up to
6 MB, resumable TUS above); the server then reads the stored object's real size and first
bytes, checks them, and only then records the attachment. See `docs/DATABASE.md`
(`upload_intents`) and `docs/SECURITY.md` (upload threat model).

## Provider facts this relies on (read 13 November 2026)

- **Vercel Functions**: "The maximum payload size for the request body or the response body
  of a Vercel Function is 4.5 MB" (413 `FUNCTION_PAYLOAD_TOO_LARGE`); maximum duration 300 s
  on Hobby, 300 s default and 800 s maximum on Pro.
  https://vercel.com/docs/functions/limitations (page dated 2026-08-24).
  `serverActions.bodySizeLimit` in `next.config.mjs` (10mb) does not raise this; no file goes
  through a server action once the pipeline is in.
- **Supabase standard uploads**: "ideal for small files that are not larger than 6MB"; "we
  recommend using TUS Resumable Upload for uploading files greater than 6MB".
  https://supabase.com/docs/guides/storage/uploads/standard-uploads
- **Supabase resumable uploads**: chunk size "must be set to 6MB (for now)" (their example
  writes `6 * 1024 * 1024`); an upload URL is "valid for up to 24 hours"; a signed upload
  token goes in the `x-signature` header; the signed TUS endpoint is
  `/storage/v1/upload/resumable/sign` (Supabase's example
  `examples/storage/resumable-upload-signed-uppy`); they recommend the direct
  `<project>.storage.supabase.co` host for speed, which our content security policy does not
  allow, so uploads use `<project>.supabase.co` (slower, not weaker).
  https://supabase.com/docs/guides/storage/uploads/resumable-uploads
- **Supabase signed upload URLs**: `createSignedUploadUrl` URLs expire 2 hours after
  creation; individual signed URLs cannot be revoked (only by rotating the signing key).
- **Supabase file limits**: a global (project) limit in Storage settings, "For Free projects,
  the limit can't exceed 50 MB", Pro up to 500 GB; a bucket's limit "can't be higher than
  this global limit". https://supabase.com/docs/guides/storage/uploads/file-limits
- **MediaRecorder** (MDN): with only a container named, "the browser will select its preferred
  codecs"; "The audio default is adaptive, depending upon the sample rate and the number of
  channels". So the recorder sets `audioBitsPerSecond` explicitly (48 kbps): ten minutes is
  about 3.6 MB of Opus or AAC, far under 20 MB even if a browser ignores the hint and uses
  128 kbps (9.6 MB). Which container each browser really produces (WebM/Opus on Chrome and
  Android, MP4/AAC on Safari, Ogg/Opus on Firefox) is chosen with `isTypeSupported` and
  accepted by sniffing; it is to be confirmed on real phones.
  https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/MediaRecorder

## Human action: the Supabase project's global upload limit

Supabase refuses any file above the project's **global file size limit**, whatever a bucket
says. For 50 MB PDFs it must be at least **50 MB (50,000,000 bytes)**.

1. Supabase dashboard, the production project, Storage, Settings, "Global file size limit".
2. Set it to at least 50 MB (on Pro it can be higher; 50 MB is enough today).
3. Check: upload a PDF between 45 and 50 MB on a job card; it must finish.

If it is lower, every file above it fails at Storage with a 413 after the browser has sent
it: the person sees "The file is too big for the storage settings" with the file kept in the
form, and the reservation is released by the nightly sweep. Until it is raised, set
`UPLOAD_GLOBAL_LIMIT_BYTES` in Vercel to the dashboard value, and the begin step refuses
larger files up front with the same sentence instead.

## Inventory of every cap (13 November 2026)

File and line are as they stood at `6e3830a`, before this work.

### Media and uploads

| Where (at 6e3830a) | Old value | Now | Kind |
|---|---|---|---|
| `src/lib/fault-media.ts:5` photo | 6 MiB | `PHOTO_MAX_BYTES` 20 MB | commercial |
| `src/lib/fault-media.ts:6` voice | 8 MiB | `VOICE_NOTE_MAX_BYTES` 20 MB | commercial |
| `src/lib/machine-photo.ts:5` | 6 MiB | 20 MB | commercial |
| `src/lib/checklist-media.ts:8` | 6 MiB | 20 MB | commercial |
| `src/lib/jobcard-media.ts:3` | 8 MiB | 20 MB photo, 50 MB PDF (`maxBytesForMime`) | commercial |
| `src/lib/workrequest-media.ts:4` | 8 MiB | 20 MB photo, 50 MB PDF | commercial |
| `src/lib/receipt-media.ts:24` | 8 MiB | 20 MB photo, 50 MB PDF | commercial |
| `src/components/fault-capture.tsx:273-275` | 6 MiB photo, 8 MiB voice | 20 MB, 20 MB | commercial |
| `src/components/fault-capture.tsx:23` voice length | 2 minutes | 10 minutes (`VOICE_NOTE_MAX_MS`, step 3) | commercial |
| `src/components/fault-capture.tsx:24` recorder bitrate | 32 kbps | 48 kbps (`RECORDER_AUDIO_BPS`) | abuse |
| `src/app/api/work/media/route.ts:103` | 8 MiB | 20 MB photo, 50 MB PDF | commercial |
| `src/app/api/jobcards/media/route.ts:20` body | 9 MiB | `FUNCTION_BODY_MAX_BYTES` 4.5 MB | provider |
| `src/app/api/jobcards/media/route.ts:44` file | 8 MiB | 20 MB photo, 50 MB PDF | commercial |
| `src/app/api/public/fault/route.ts:37,42` body | 20 MiB, 16 MiB | 4.5 MB | provider |
| `src/app/api/sync/route.ts:13` body | 16 MiB | 4.5 MB | provider |
| `src/app/api/faults/route.ts:44` body | 16 MiB | 4.5 MB | provider |
| `src/app/api/documents/upload/route.ts:46,69` | 9 MiB body, 8 MiB file | 4.5 MB body; 20 MB photo, 50 MB PDF | provider, commercial |
| `src/app/(app)/finance/actions.ts:464` | 8 MiB | 20 MB photo, 50 MB PDF | commercial |
| `src/app/(app)/trips/actions.ts:18` | 8 MiB | 20 MB | commercial |
| `src/app/(app)/admin/billing/actions.ts:406` proof | 4 MiB | 20 MB photo, 50 MB PDF | commercial |
| `src/app/(app)/contractor/settings/actions.ts:137` logo | 2,000,000 bytes | unchanged, `PARTNER_LOGO_MAX_BYTES`: a letterhead logo | abuse |
| `next.config.mjs:25` `serverActions.bodySizeLimit` | 10mb | unchanged: Vercel's 4.5 MB applies first, and no file passes a server action after step 3 | provider |
| bucket limits, `20261013140000_storage_limits_and_trigger_grants.sql:26-42` | photos 8 MiB, voice 10 MiB, docs 10 MiB, logo 2 MiB | `BUCKETS` in the catalogue (photo buckets 20 MB, voice 20 MB, document buckets 50 MB, logo unchanged), set by the step 2 migration | provider |
| `finance-docs`, `20261028110200_asset_finance_documents.sql:127` | 10 MiB | 50 MB | provider |
| `billing-proofs`, `20261029100000_billing_manual_payments.sql:54` | 10 MiB | 50 MB | provider |

### Assistant and voice

| Where | Old value | Now | Kind |
|---|---|---|---|
| `src/app/api/assistant/transcribe/route.ts:43` | 2,000,000 bytes | unchanged (`HEARING_CLIP_MAX_BYTES`): the instant hearing posts WAV through a function; longer speech goes through the upload pipeline as command audio (step 5) | provider |
| `src/components/assistant/offline-voice.ts:10` | 60 s, also the live cap (`assistant-client.tsx:899,990`) | `INSTANT_CLIP_MAX_MS` 60 s for the instant path; spoken commands up to 10 minutes go through the recorded-command path (step 5) | provider, commercial |
| `src/components/assistant/speech-client.ts:728` file recognition | 25 MiB | unchanged, `RECOGNISE_FILE_MAX_BYTES`: ten minutes of 16 kHz WAV is 19.2 MB | abuse |
| `src/components/assistant/clip-recorder.ts:43` | 1,000 bytes minimum | unchanged, `CLIP_MIN_BYTES` | abuse |
| `src/lib/assistant/request-schema.ts:10` typed input | 2,000 characters | unchanged `ASSISTANT_TYPED_MAX_CHARS`; a spoken command may hold 16,000 (step 5) | abuse |
| `voice_captures.transcript`, `ai_interactions.input_text` (`20260813195653`) | 8,000 characters | 16,000 (step 5 migration): ten minutes of speech | abuse |
| `src/app/api/assistant/speech-token/route.ts:26` voice session hold | 2 minutes, rolled over as each fills | unchanged: a hold size, not a command limit | abuse |
| `src/components/assistant/speech-client.ts:21`, `voice-meter.ts:32` | 8.5 and 9 minutes | unchanged: Azure tokens last about ten minutes | provider |

### WhatsApp (provider restrictions, unchanged; task B4 rechecks them against Meta's docs)

| Where | Value | Now |
|---|---|---|
| `src/lib/whatsapp/media.ts:18` photo | 6 MiB | `WHATSAPP_IMAGE_MAX_BYTES`, unchanged |
| `src/lib/whatsapp/media.ts:20` voice | 4 MiB | `WHATSAPP_VOICE_MAX_BYTES`, unchanged |
| `src/lib/whatsapp/media.ts:21` voice length | 3 minutes | `WHATSAPP_VOICE_MAX_MS`, unchanged |
| `src/lib/whatsapp/media.ts:22` shortest | 300 ms | `WHATSAPP_VOICE_MIN_MS`, unchanged |

### Imports, statements and parsers (unchanged)

| Where | Value | Why unchanged |
|---|---|---|
| `src/app/(app)/fuel/cards/actions.ts:15` | 2 MiB CSV | the reviewed cap; BRIEF section 9 says it was not raised to 50 MB |
| `src/lib/fuel-cards.ts:13` | 2,000 rows | one statement's fills |
| `src/app/(app)/machines/import/csv.ts:23` | 200 rows | one import; import again for more (no total limit) |
| `src/lib/banking.ts:87` | 2,000 rows | one bank statement |
| `src/lib/offline/envelope.ts:21` | 20,000 characters | one queued capture's fields |

The machine and bank CSVs are read in the browser and posted as rows to a server action, so
their file size is bounded only by Vercel's 4.5 MB request limit; that is far above 200 or
2,000 rows.

### Request bodies that are never files (abuse protection, unchanged)

| Where | Value |
|---|---|
| `src/lib/billing/config.ts:38` Paystack webhook | 1 MiB |
| `src/lib/api-tokens.ts:138` public API body | 16 KiB |
| `src/app/api/csp-report/route.ts:18` | 16 KiB |
| `src/app/api/routing/routes/route.ts:7` | 16 KiB |
| `src/app/api/integrations/positions/route.ts:20` | 128 KiB |

### Windows (never history limits, unchanged)

| Where | Value |
|---|---|
| `src/lib/supabase/read-all.ts:24` | 100,000 rows; a longer read is reported and used |
| `src/lib/accounting-read.ts:9` | 100,000 journal lines; choose a shorter period |
| `src/lib/usage-billing.ts:15` | storage measured in binary GB for cost-plus usage; task A3 replaces it with the decimal pooled allowance |
| `src/app/(auth)/close-account/page.tsx:57` | shows megabytes; now decimal |

## Photo reduction

One reducer for every photo (`src/lib/upload/compress.ts`, used by the upload control, the
fault form and checklists), decision 13:

- The long edge goes down to **2560 pixels**, never up, at **JPEG quality 0.85** (never
  below 0.80). Why: a serial plate filling a tenth of a 12 MP phone photo's width is then
  about 256 pixels wide, so its characters are twenty-odd pixels tall; the old reduction
  (1600 pixels at 0.7) left them at about twelve, where stamped digits and hairline cracks
  blur. A 12 MP photo comes out at roughly 0.6 to 1.2 MB instead of 3 to 6 MB.
- **"Keep the original photo"** sits beside every photo choice; ticked, the file goes
  exactly as it is (up to 20 MB). The control says what reduction did ("4032 to 2560
  pixels wide") or that the photo was sent as it is.
- The original is also kept, unchanged, when the browser cannot decode it (HEIC on most
  browsers other than Safari), when encoding fails, or when the reduced file would not be
  smaller. EXIF orientation is applied while decoding, so the reduced copy is upright.
- **PDFs and recordings are never altered.** One copy is stored either way: there is no
  hidden second (original plus reduced) copy using the customer's storage.
- Tested on the reducer's decisions (long edge, quality floor, keep-original, PDFs
  untouched, failure falls back to the original). Whether a reduced photo of a real plate
  is legible is a judgement for a real phone and a real plate (PROGRESS, "To verify").

## Command audio

A spoken command (decision 11) may run to ten minutes:

- **Live dictation** (Azure, in the browser) runs to ten minutes, warns 30 seconds before
  and stops itself, keeping the transcript. A turn longer than a minute is not re-heard by
  the instant AI hearing (that route takes one minute of WAV through a function).
- **A recorded command** (made offline, or any recording longer than a minute) is recorded
  at 48 kbps (about 3.6 MB for ten minutes), sent straight to Storage as temporary command
  audio (the service-only `command-audio` bucket) and heard by a durable job
  (`assistant_command_jobs`): claimed with a lease of six minutes, tried at most three
  times, taken over when a run vanished, run inside the request the browser makes and
  polls (one call, at most 240 s of provider time, inside the 300 s function limit). One
  file, one call: OpenAI takes up to 25 MB in webm, ogg, mp4 and m4a
  (https://developers.openai.com/api/docs/guides/speech-to-text, read 2026-11-14). Paid
  hearing is held and settled in the AI usage ledger for the recording's whole length.
- The transcript comes back as the person's spoken request (up to 16,000 characters); the
  assistant's confirmation before any change is unchanged. It still proposes one change per
  turn, so a long request with several changes is confirmed one at a time, never created
  silently.
- **After a command completes**, its transcript and the assistant's record of what was
  confirmed stay; the temporary audio is removed at once. **A failed or unfinished command**
  keeps its audio for a **72-hour recovery window**, an engineering default and not a
  contractual term, with "try again"; then the nightly job removes it. A voice note attached
  to a fault is an attachment and is never removed by this. This is about FLEETWISE's own
  copy; what a provider keeps is governed by that provider's terms, not promised here.

## Manual driving (B3 R-044 candidate)

The drivingStops, drivingStopsTextChars and drivingMaxKm entries are abuse guards:
50 ordered stops, 200 characters per stop, 10,050 raw textarea characters including line
breaks, and readings from 0 to 999,999,999.9 km with at most one decimal place. Destination
and location allow 200 characters; notes allow 2,000. The parser and database validate
submitted data; the UI exposes the stop limit. These are not a paid route calculation or
a commercial history-retention limit. No route/map provider is called for written stops.
