# REPORT B4: WhatsApp completion and equipment-aware assistance

Lane B, branch `final/lane-b`, 19 November 2026, from `6613701`. Built by the main Claude session itself (the founder ended subagents on 19 Nov). BRIEF section 13 and the last paragraph of 12; decisions 19, 21, 24; scenarios 33 and 36. Nothing was pushed, merged, applied to a live database or released by this work.

The November adapters were already sound (linking with a hashed single-use challenge, HMAC signatures, Meta id deduplication, an explicit selected business per number that a web switch never moves, delegated user tokens, typed `CONFIRM <code>`, access re-checked before every send, photos and voice notes). B4 closed the gaps against the brief rather than rewriting them.

Gates at the final code commit: tsc clean; 1243 unit tests pass; dashes, i18n parity and keys, design lint and errors clean; `node scripts/migrate_check.mjs --suite` 98/98 on PGlite. Mutations: 11/11 database guards and 5/5 TypeScript guards caught (break, watch a test fail, restore). CI on real Postgres runs at integration.

## 1. Done

One migration, `20261121090000_whatsapp_completion.sql` (additive; probe in `scripts/apply_pending.mjs`, suite `supabase/tests/whatsapp_completion.sql` in `run.sh`, a `docs/DATABASE.md` line).

| Gap | What was built | Commits |
|---|---|---|
| One switch for the whole channel | Four capability flags in `feature_flags`: `whatsapp_text` and `whatsapp_alerts` released (real-phone verified 17 and 18 Oct), `whatsapp_photos` and `whatsapp_voice` in testing. `app.whatsapp_capability`; the worker answers a closed path with a short reply and never a model call, and an alert on a closed path stays in the app (`capability_off`). Managed on `/admin/features`. | `46d0fa0`, `69ee9b0` |
| Old 3 minute / 4 MiB / 6 MiB constants | Meta's "Supported media types" table read on 19 Nov 2026 (developers.facebook.com/docs/whatsapp/cloud-api/reference/media): images 5 MB, audio 16 MB (Ogg Opus only), documents 100 MB, inbound at most 100 MB (error 131052), media URLs expire in 5 minutes. Catalogue: photos 5 MB, voice 16 MB and ten minutes (decision 11). Hearing time scales with the note inside a 240-second deadline in a 300-second run; heard text keeps the spoken length (16,000 characters) and goes in as a voice request instead of being cut to 2,000. | `fbba031`, `56da52f` |
| Photos bypassed B1's pipeline and A3's pool | `whatsapp_stage_photo` reserves the bytes on the customer's pool under its lock (refuses `upload:storage_full`), records the photo and a finalised `upload_intents` row of the new kind `whatsapp_media`, so the pool counts it at once and the nightly orphan measurement leaves it alone. B1's byte checker (`inspect`) replaces the old magic-byte test. A full pool tells the owners once through A3's `storage_note_full`, as the person. `whatsapp_photo_removed` frees the bytes on discard or expiry; an attached photo keeps counting. | `00a6c71`, `f66bc3d` |
| No app upload link | `whatsapp_upload_links` (forced RLS, service only, pay gate, test-account fence) with `whatsapp_upload_link_create` and `whatsapp_upload_link_open`. `/whatsapp/upload/<token>` opens only for the same signed-in person, on the same business, while a member, for 30 minutes; a forwarded link answers another person exactly as an unknown one; only the token's SHA-256 is stored. Used for a photo past 5 MB, a document, video or sticker, and photos on a closed path. The upload itself is B1's `UploadField` on the chosen fault. | `00a6c71` |
| A paid answer could be bought twice | `whatsapp_inbox.answer_started_at` and `whatsapp_start_answer`: marked under the lease before the model is asked; a retry after a crash asks the person to send again. | `46d0fa0`, `69ee9b0` |
| Statuses overwritten in any order | `whatsapp_record_status`: forward only (sent < failed < delivered < read), with `delivery_status_at` and `delivery_chargeable` from Meta's pricing; A3 still settles the money. | `46d0fa0`, `69ee9b0` |
| Equipment through the assistant | `src/lib/assistant/equipment.ts` (`equipmentRefusal`, A1's own rule): no diesel proposal for support equipment, refused before any proposal; the fuel summary gives no consumption rate for equipment; confirmation words A1's `equipment-refused-*` and `plan-feature-*` refusals. The asset profile now reaches the assistant's machine list. | `90dbfd5`, `704a2ea` |
| Docs | `docs/WHATSAPP.md` (Completion section, corrected limits), `docs/LIMITS.md` (WhatsApp media, cited), `docs/DATABASE.md`, the register. | `79bd232` and the closing commit |

Already sound and verified rather than rebuilt: the media download sends Meta's token only to Meta's hosts and refuses a redirect elsewhere (`trustedMediaHost`), with the size checked before and during the download; sender verification and linking; revoked links and memberships (`whatsapp_channel.sql`); owner acceptance of WhatsApp charges and the cap (A3, `assistance_cap.sql` [32]); the agent's tools are read-only and its prompt says business data and tool results are records, never instructions.

## 2. Requirements and scenarios

| Covered | By |
|---|---|
| Scenario 33 (consent, revoked number or membership, duplicated events, stale confirmations, oversized-media app link) | `supabase/tests/whatsapp_completion.sql` [1] to [5]; `src/lib/whatsapp/media-worker.test.ts` (oversized photo link, document link, full pool, closed photo and voice paths, answer once); `delivery.test.ts` (alerts off); the existing `whatsapp_channel.sql`, `whatsapp_media.sql`, `assistance_cap.sql` [32]. Real phone media delivery is external (section 6). |
| Scenario 36 (equipment cannot create fuel records or fuel analytics even on Complete; injection cannot escalate tools) | `src/lib/assistant/equipment.test.ts`; `equipment_restrictions.sql` (A1, the table) |

Register rows: R-041 and R-084 now E (B4's part); R-085 X (built; real-phone journeys pending, photos and voice off until they pass); R-086 unchanged X (A3 built, real phones pending); I-071 resolved.

## 3. Not done, and why

- **No real phone.** Text and alert journeys were verified in October; the photo, voice, oversized-photo link and upload-link journeys need a real phone with the production number. Photos and voice stay off until then.
- **Expired upload links are not swept.** Rows are tiny and refuse after 30 minutes; a sweep can join `whatsapp_prune` later.
- **No WhatsApp document support,** as the brief says; documents get the app link only.
- **The weekly or nightly report of WhatsApp delivery** (an operations view of failed and unknown sends) is still the October pilot policy: inspect before retrying, never bulk-reset.

## 4. Assumptions (flag any that are wrong)

1. Text and alerts start released because they passed real-phone tests in October; photos and voice start off.
2. WhatsApp photos are limited to Meta's 5 MB even though the app takes 20 MB; anything larger gets the app link.
3. A voice note up to ten minutes is heard in one run (the app's limit, decision 11), within Meta's 16 MB.
4. Meta's "MB" is read as decimal megabytes, the smaller reading.
5. A photo whose upload to Storage fails after the pool reserved it is settled as discarded and its bytes freed.

## 5. Risks, most important first

1. **Ten-minute notes take time.** A long note may use most of a 300-second run; the worker stops claiming new messages after 60 seconds so one note does not starve the rest, and the minute cron drains any backlog.
2. **Photos now count against the pool.** A business already at its limit can no longer stage WhatsApp photos; it gets the "storage full" reply and its owners are told.
3. **Deploy order.** Apply `20261121090000` before the new worker runs: it calls `whatsapp_capability`, `whatsapp_start_answer`, `whatsapp_stage_photo` and `whatsapp_record_status`. Until the migration is applied, `capabilityOn` answers "off" and every inbound message gets the "not available yet" reply.
4. **The upload page shows open faults by description,** which may be empty; an unnamed fault shows a placeholder.

## 6. External blockers

| Blocker | Smallest human action |
|---|---|
| Real-phone journeys (scenario 33) | With the production number and a test business: send a photo, a photo over 5 MB (follow the link, add it), a short and a nine-minute voice note, a PDF (follow the link), STOP, and a message after the person is removed from the business. Then release `whatsapp_photos` and `whatsapp_voice` on `/admin/features`. |
| WhatsApp charges | Rapid Rise enters the rates and start date on `/admin/ai` (A3) before WhatsApp is charged; owners accept on `/settings/ai`. |
| Release | Apply `20261121090000` with the deploy (probe in `scripts/apply_pending.mjs`). |

## 7. For the next tasks

- **A5 (website and help):** describe WhatsApp per path: questions and alerts available; photos and voice notes "coming once tested"; no documents over WhatsApp; files WhatsApp cannot carry are added through a link in the app.
- **B5:** imports and documents stay in the app; WhatsApp has no document path.
- **B6 (Android):** WhatsApp is separate; nothing here depends on the app.
- **A6 (release):** add `20261121090000` to the release sequence; the four flags appear on `/admin/features`; watch `capability_off` cancellations and `paid_*` refusals in `whatsapp_notification_delivery`.
