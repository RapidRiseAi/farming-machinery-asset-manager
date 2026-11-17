# B2: private staff chat, Codex handoff

Implementation is ready for Claude review on `codex/final-b2-chat-20261116`, worktree
`C:/projects/.fw-codex-b2`, based on `be6fae750894b67d6d8df53f3694d0f93d6b3cbd`.
This is an isolated contribution, not acceptance, integration, CI success or a release.
The founder authorised unstarted B2 only. Claude remains the orchestrator and final reviewer.
A2, the original checkout, both Claude lanes and `final-dev` were not changed by Codex.

## What is implemented

- Direct conversations and team groups on Essential and above. Any active internal staff
  member can create; only the group creator can rename, add or remove others. Direct pairs
  cannot become groups. No owner override, partner membership or self-escalation.
- Membership-filtered messages, search, unread counts and metadata. New and re-added
  members see messages published after joining; removal revokes server access. Suspended
  writes use the existing account gate, which A2 replaces without changing its interface.
- Pending sends, explicit failures, stable retry IDs, paginated history and scoped browser
  text drafts. An altered retry is refused rather than silently discarding the new text.
  Draft attachments remain private to their sender until publication.
- Photo, PDF and voice attachments through B1's begin/verify/commit and quota hooks.
  Voice recording uses MediaRecorder, stops at ten minutes, and invokes no paid AI or
  transcription. Failed recording uploads can be retried or discarded before sending text.
- English/Afrikaans screens, navigation and generic in-app notifications. Notifications
  contain a conversation link, never the body or attachment content.
- Private edit/delete audit metadata. No message body, title or membership list goes into
  the farm-wide audit log. Audited support visits permit reading only while the visit is open.
- Postgres Changes on conversation updates through RLS, plus periodic refresh for missed
  events and revocation. The channel name grants no access. Attachment downloads use the
  caller's authenticated Storage client and revoke local blob URLs on unmount.
- A cross-feature review found the service-backed business file export would otherwise
  include private chat files. Its file selection now excludes `chat-files`. Quota accounting
  and permanent farm-closure cleanup still include the bucket.

Existing shared-job discussions (`work_request_events`), support conversations and WhatsApp
remain their respective domains. B2 adds the missing internal staff conversation domain and
reuses the existing notifications, uploads, account gates, UI controls and readiness system.
The assistant does not ingest or execute chat content.

## Evidence, 17 November 2026

| Check | Result |
|---|---|
| TypeScript | Pass |
| Production build | Pass; see build log for pre-existing warnings outside B2 |
| Unit tests | 1,157 pass, zero skipped or failed |
| Changed chat/API files, ESLint | Pass, no warnings |
| Dashes, translation parity and key coverage, design/contrast, error coverage | Pass |
| Migration application | 291 apply on throwaway PGlite |
| Full SQL suite | 78 pass, one existing billing failure, detailed below |
| Expanded `staff_chat.sql` | Pass, including linked partner isolation, direct retries, altered retries, removed members, history, inactive home-farm membership, audited support access, full quota and pending upload revocation |
| Storage policy fixture | Pass against the actual B2 migration, even with an intentionally broad legacy Storage policy |
| Five SQL guard mutations | All caught by behavioural failures: membership, joining history, group administration, altered send retry and inactive membership |
| Browser fixture | Real components, React, styles and headless Chrome: 360px/1280px, drafts across navigation, failed retry identity, modal closure, voice failure recovery, stale search responses, access removal and Afrikaans rendering pass |

The browser's API, Realtime and microphone are fixtures. Its ten-minute timer is exercised
with an accelerated clock, not a ten-minute microphone recording. The Storage fixture checks
Postgres policies, not the hosted Storage server, signed upload endpoint or Realtime delivery.
PGlite has one connection and stubs digest for migration application; it cannot establish
real Postgres concurrency or Supabase service behaviour.

Reproduce the B2-specific checks from this worktree:

```text
pnpm typecheck
pnpm test
node scripts/migrate_check.mjs --suite staff_chat.sql
node scripts/chat_review_check.mjs storage
node scripts/chat_review_check.mjs mutations
node scripts/chat_ui_check.mjs
```

Evidence logs are in `C:/projects/output/fleetwise-final-dev/codex-b2-*.log`.
The generated SQL mutation runners change only in-memory migration text; the source
migrations and Claude worktrees are never rewritten by those checks.

### Existing acceptance blocker

`billing_review_5.sql`, assertion `money-10 trial-anchor`, fails on today's date:
the first invoice after a 14-day trial covers 2026-11-17 to 2026-12-01 (15 days),
but charges R20, a full month. `node scripts/chat_review_check.mjs baseline` reproduces
the same failure with both B2 migrations omitted and unchanged original migrations/tests.
This is not a green full-suite claim. The billing fix belongs with Claude/A2; no billing
implementation or billing assertion was changed to hide it.

## Integration and remaining checks

1. Resume A2 in its existing lane. Do not allocate another B2 worker. Review this branch's
   diff from `be6fae7` and this report before deciding integration.
2. Keep both sets of additions in shared translations, notifications, migration probes and
   `run.sh`. B2's changed export file is `api/farm/export/files/route.ts`; A2's active change
   is `api/farm/export/route.ts`. B2 does not replace any billing function. Follow the
   existing manager conflict procedure rather than overwriting either task.
3. Resolve the existing billing failure through A2, then run full mechanical gates and CI
   on real Postgres against the combined integration commit. Check grace, owner-only
   retrieval, cancellation, suspension and reactivation specifically. An owner who is not
   a conversation member still must not gain private chat history during retrieval.
4. In an approved test business, check signed/resumable uploads, PDF/photo/voice boundaries,
   quota accounting, concurrent near-quota uploads and real Realtime removal in two
   sessions. Test support visit start/end and that the business ZIP cannot return chat files.
5. Check Android Chrome and iPhone Safari microphones, playback, long recording, lost
   signal, navigation/reload, membership changes and mobile/desktop dialogs through the
   actual app. The isolated fixture is additional evidence, not the manager's browser signoff.
6. Only after manager acceptance enable `general_chat` via existing feature administration.
   Its migration defaults to unreleased; no customer was enabled by Codex.

Migrations: `20261117090000_staff_chat.sql` and `20261117090100_chat_uploads.sql`, with
probes in `apply_pending.mjs` and the SQL suite in `run.sh`. A3 owns pooled quota changes;
B2 uses that hook and does not implement storage purchases or billing lifecycle work.

## Deliberate limits and review notes

- Creator-only group administration; no admin transfer or self-leave UI. Inactive staff
  immediately fail the membership helper. A group whose creator leaves can continue
  chatting but cannot change membership until the creator's access is restored.
- Draft text is stored in sessionStorage, scoped to login and room and cleared on sign-out.
  Raw in-flight files/recordings are not durable offline storage. Already finalised draft
  files remain retained and count against storage; deleting a message hides, not erases, files.
- Revocation prevents subsequent server reads immediately; an open foreground screen clears
  on its next failed refresh (up to 15 seconds without another signal). Already downloaded
  content cannot be recalled. No sensitive message body is sent over the Realtime channel.
- The feature does not add a private-chat bulk export. Business-wide export deliberately
  excludes chat attachments, even if the owner belongs to one conversation. Members can
  download their readable attachments individually. Privacy/retention export expansion
  needs explicit membership-aware design.
- No production credentials, database migration, push, merge, deployment or provider charge
  occurred. Readiness remains off. Zero breakage or lost-context guarantees are not claimed.
