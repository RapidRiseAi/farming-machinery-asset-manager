# Limits catalogue

Generated from `src/lib/limits.ts` by `pnpm exec tsx scripts/limits_catalogue.ts` (A6). Do not edit by hand:
change the table in code and regenerate; `src/lib/limits-catalogue.test.ts` fails when they differ.
Media sizes are decimal (1 MB = 1,000,000 bytes) unless a limit says MiB. docs/LIMITS.md explains
the reasoning, the provider facts and how files travel.

80 limits. "Shown" means the limit is stated to customers (help, plan pages, error messages).

## Commercial limits (what a plan or decision promises)

| Name | Value | Shown | Why |
|---|---|---|---|
| `storageMinBytes` | 2 000 MB (2 000 000 000 bytes) | yes | Decision 14: every customer's pool is at least 2 GB (decimal). |
| `storagePerFullSpaceBytes` | 100 MB (100 000 000 bytes) | yes | Decision 14: each purchased full space adds 100 MB to the one shared pool, never a per-asset cap. |
| `storagePerEquipmentSpaceBytes` | 25 MB (25 000 000 bytes) | yes | Decision 14: each equipment space, included or extra, adds 25 MB to the pool. |
| `storageBlockBytes` | 10 000 MB (10 000 000 000 bytes) | yes | Decision 15: an optional paid block adds 10 GB (R49 a month, charged monthly). |
| `photoMaxBytes` | 20 MB (20 000 000 bytes) | yes | Decision 8: photos up to 20 MB. |
| `pdfMaxBytes` | 50 MB (50 000 000 bytes) | yes | Decision 9: PDFs up to 50 MB, kept unchanged. |
| `voiceNoteMaxBytes` | 20 MB (20 000 000 bytes) | yes | Decision 10: recorded voice notes up to 20 MB. |
| `voiceNoteMaxMs` | 10 minutes | yes | Decisions 10 and 11: voice notes up to ten minutes. |
| `commandAudioMaxMs` | 10 minutes | yes | Decision 11: spoken commands up to ten minutes. |
| `photoLongEdge` | 2 560 pixels | yes | Ordinary photos are reduced to this long edge: 2560 px keeps a serial plate or a crack legible. |
| `liveDictationMaxMs` | 10 minutes | yes | Decision 11: ten-minute spoken commands. |
| `whatsappVoiceMaxMs` | 10 minutes | yes | Decision 11: ten minutes, as in the app; a longer or larger note gets an app upload link instead. |

## Protections against misuse

| Name | Value | Shown | Why |
|---|---|---|---|
| `chatBodyChars` | 8 000 chars | yes | Maximum text per staff chat message; split longer messages. |
| `chatRequestBytes` | 100 kB (100 000 bytes) | yes | Bound streamed chat JSON including multibyte message text and member identifiers. |
| `chatMembers` | 100 count | yes | Maximum active members per group, not a subscription seat limit. |
| `chatAttachments` | 10 count | yes | Maximum files per message; text remains available at full storage. |
| `drivingStops` | 50 count | yes | Maximum written itinerary stops per driving session, not a plan entitlement. |
| `drivingStopsTextChars` | 10 050 chars |  | Fifty stop names of two hundred characters with line separators. |
| `drivingMaxKm` | 999 999 999.9 km |  | Finite nonnegative odometer values with at most one decimal place. |
| `storageWarnPercent` | 80 count | yes | Engineering default, not a founder term: owners are warned at 80% full. |
| `storageUrgentPercent` | 95 count | yes | Engineering default, not a founder term: owners are warned again at 95% full. |
| `commandAudioMaxBytes` | 20 MB (20 000 000 bytes) |  | The byte ceiling for a ten-minute command recording; the recorder bitrate keeps ten minutes far below it. |
| `recordingWarnBeforeMs` | 30 seconds | yes | Warn shortly before a recording stops itself. |
| `recorderAudioBitsPerSecond` | 48 kbit/s |  | Set on MediaRecorder so a ten-minute note cannot depend on a browser's adaptive default bitrate. |
| `recordingMinMs` | 300 ms |  | Shorter clips carry no words. |
| `imageMaxPixels` | 210 000 000 pixels |  | Decoded-pixel ceiling read from the header: a 200 MP phone photo passes, a decompression bomb does not. |
| `imageMaxEdge` | 30 000 pixels |  | Longest side an image header may claim. |
| `photoJpegQualityPercent` | 85 count |  | JPEG quality for a reduced photo; 85 keeps fine print. |
| `photoJpegQualityMinPercent` | 80 count |  | Never re-encode below this quality. |
| `uploadIntentTtlMs` | 2 hours |  | A reservation is released once its upload can no longer land. |
| `sniffHeadBytes` | 262.14 kB (262 144 bytes) |  | Enough for every header we parse, past a JPEG's 64 kB EXIF block to its frame header. |
| `sniffTailBytes` | 524.29 kB (524 288 bytes) |  | Enough to find the last Ogg page or WebM cluster. |
| `openIntentsPerUser` | 40 count |  | Stops a runaway client from reserving the pool. |
| `clipMinBytes` | 1 kB (1 000 bytes) |  | A clip under 1 kB is a header and silence. |
| `recogniseFileMaxBytes` | 25 MiB (26 214 400 bytes) |  | Ten minutes of 16 kHz WAV with headroom. |
| `assistantTypedMaxChars` | 2 000 chars |  | A typed request; longer text is a document. |
| `assistantSpokenMaxChars` | 16 000 chars |  | Ten minutes of fast speech with headroom. |
| `commandAudioRecoveryMs` | 3 days | yes | Engineering default, not a contractual term: three days to retry a command before its temporary audio is removed. |
| `commandJobMaxAttempts` | 3 count |  | Retry limit for one command's transcription. |
| `commandJobLeaseMs` | 6 minutes |  | Longer than one Vercel function run (300 s). |
| `whatsappVoiceMinMs` | 300 ms |  | Shorter WhatsApp notes carry no words. |
| `fuelCardCsvMaxBytes` | 2 MiB (2 097 152 bytes) | yes | Reviewed 2 MiB fuel-card CSV cap, unchanged (BRIEF section 9). |
| `fuelCardMaxRows` | 2 000 rows | yes | Rows read from one fuel-card statement. |
| `machineImportMaxRows` | 200 rows | yes | Vehicles in one CSV import; import again for more. |
| `bankStatementMaxRows` | 2 000 rows | yes | Lines in one bank statement import. |
| `readingsImportMaxBytes` | 2 MiB (2 097 152 bytes) | yes | A readings sheet for the import review (task B5), the same reviewed cap as fuel-card CSV. |
| `readingsImportMaxRows` | 2 000 rows | yes | Readings staged from one sheet; public.import_rows_stage refuses more in one call. |
| `partnerLogoMaxBytes` | 2 MB (2 000 000 bytes) | yes | A partner's letterhead logo. |
| `partnerLogoBucketBytes` | 2 MiB (2 097 152 bytes) |  | partner-branding bucket, a little above the form's cap. |
| `webhookBodyMaxBytes` | 1 MiB (1 048 576 bytes) |  | Paystack webhook bodies are a few kilobytes. |
| `apiBodyMaxBytes` | 16.38 kB (16 384 bytes) |  | Public API writes are small JSON. |
| `cspReportMaxBytes` | 16.38 kB (16 384 bytes) |  | A CSP violation report. |
| `routingBodyMaxBytes` | 16.38 kB (16 384 bytes) |  | A route request: at most 25 stops. |
| `trackerBatchMaxBytes` | 131.07 kB (131 072 bytes) |  | One tracker position batch. |
| `offlinePayloadMaxChars` | 20 000 chars |  | One queued offline capture's fields. |
| `requestClaimOutcomeChars` | 65 536 chars |  | An answer a request claim keeps for a replay (20261119110000); a longer one is not kept. |
| `exportMaxFiles` | 200 000 count | yes | Files listed for one complete export; beyond it the contents list says the export is capped. |
| `exportsPerDay` | 5 count | yes | Complete exports a business may start in one South African day; each copies every file. |
| `exportFileAttempts` | 3 count |  | Attempts at one file before the export reports it missing with its reason. |

## Provider restrictions

| Name | Value | Shown | Why |
|---|---|---|---|
| `resumableThresholdBytes` | 6 MB (6 000 000 bytes) |  | Supabase standard uploads docs (read 2026-11-13): standard upload for files not larger than 6MB, TUS above. |
| `resumableChunkBytes` | 6 MiB (6 291 456 bytes) |  | Supabase resumable uploads docs (read 2026-11-13): chunk size must be 6MB, example 6 * 1024 * 1024. |
| `signedUploadTtlMs` | 2 hours |  | Supabase JS reference: a signed upload URL is valid 2 hours. |
| `storageGlobalLimitNeededBytes` | 50 MB (50 000 000 bytes) |  | The project-wide Storage limit must be at least the largest file the app accepts (50 MB PDFs). |
| `functionBodyMaxBytes` | 4.5 MB (4 500 000 bytes) |  | Vercel Functions limits (page dated 2026-08-24): 4.5 MB request or response body. |
| `legacyMultipartMaxBytes` | 4.4 MB (4 400 000 bytes) |  | Under Vercel's 4.5 MB with room for the form fields around the file. |
| `serverActionBodyMaxBytes` | 4.5 MB (4 500 000 bytes) |  | Server actions sit behind the same Vercel 4.5 MB body limit; a larger Next setting promises nothing. |
| `hearingClipMaxBytes` | 2 MB (2 000 000 bytes) |  | The instant hearing posts WAV through a function (Vercel 4.5 MB); a longer clip uses the upload pipeline. |
| `instantClipMaxMs` | 1 minutes |  | One minute of 16 kHz WAV is 1.92 MB, the most the instant hearing can post through a function. |
| `whatsappImageMaxBytes` | 5 MB (5 000 000 bytes) | yes | Meta's WhatsApp image limit: 5 MB (JPEG, PNG, static WebP). |
| `whatsappVoiceMaxBytes` | 16 MB (16 000 000 bytes) | yes | Meta's WhatsApp audio limit: 16 MB. |
| `exportPartBytes` | 40 MB (40 000 000 bytes) |  | About 40 MB per ZIP part: under a 50 MB per-object upload limit (a Free project's ceiling, Supabase Storage file limits) with room for headers; a larger file goes alone in its own part. |

## Display and query windows

| Name | Value | Shown | Why |
|---|---|---|---|
| `chatPageRows` | 50 rows |  | Chat messages, people and conversations per page; older pages remain available. |
| `readAllMaxRows` | 100 000 rows |  | Paged reads stop and report beyond this. |
| `journalMaxLines` | 100 000 rows |  | Accounting journal export; choose a shorter period beyond. |
| `positionRecentMs` | 10 minutes | yes | A reported position older than this is shown as the last known position with its age, never as current or live. |
| `routeGapMs` | 10 minutes | yes | Two recorded positions further apart in time than this are a gap: the route is drawn as separate pieces and the distance across the gap is not counted (B6). |
| `routeJumpKm` | 2 km |  | A step longer than this that would need more than 250 km/h is a jump (a bad fix or a gap), never a road driven (B6). |
| `tripReportWindowDays` | 90 count | yes | The trip earnings report covers the last 90 days and says so; older trips stay on their own pages and in the export. |
| `exportKeepDays` | 7 count | yes | A finished export is kept for download seven days at most, never past the owner's last reading day. |
| `exportLinkMs` | 10 minutes | yes | A download link to one part works for ten minutes; a new one is made on every press while the export is kept. |
