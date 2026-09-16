# Assistant thread

Planned 13 September 2026 against `76f1d8a`; **built 15 September 2026** on top of
`4f2d8ab`. This file began as the plan. It now records what was built, where the
build deviated from the plan and why, and what is still open — so the next person
changes it with the reasoning in hand rather than rediscovering it.

## What it does

The assistant used to replace each exchange with the next, so the screen had no
memory. It now keeps a conversation:

1. **Past exchanges stay on screen**, oldest first, inside their own scroll region
   that opens on the newest.
2. **Each exchange shows its outcome**, not just its answer — saved, declined,
   expired, not finished, replaced, failed.
3. **A pending proposal survives leaving the page**, and can be reviewed with every
   fact shown and then confirmed or declined.
4. **The live exchange never appears twice.** It renders as the usual cards until
   the live area clears, then moves up into the thread.
5. **A saved change links to its record.**
6. **Starter prompts show only on an empty conversation.**
7. **Runs of abandoned attempts fold into one line**, opened on request, so the
   exchanges that did something are not buried behind them.

## The finding that shaped it: history is the table

Every turn is already written to `public.ai_interactions` (`store.ts`), and the
read is already granted to its subject:

```sql
create policy ai_interactions_sel on public.ai_interactions for select to authenticated
  using (
    deleted_at is null
    and user_id = auth.uid()
    and app.has_farm_access(farm_id)
    and (app.is_farm_side() or app.is_rr_admin())
  );

grant select on public.voice_captures, public.ai_interactions to authenticated;
revoke insert, update, delete on public.voice_captures, public.ai_interactions from authenticated;
```

So there is **no new table, policy, grant or migration**. History kept in React
state would have died on reload, not followed a person to their phone, been
unable to say whether a proposal was ever confirmed, and become a second account
of events that could disagree with the audit record.

`conversationId` is the interaction id — the turn route returns
`conversationId: interactionId` at every branch — and a clarification cycle
updates one row. There is still **no `conversation_id` column**, deliberately:
nothing reasons across turns, so "your recent exchanges" is the whole need.

## How it is built

| File | Role |
| --- | --- |
| `src/lib/assistant/thread.ts` | **Pure.** What a stored row means to its subject: `threadStatus`, `parseDraft`, `threadHref`, `toThreadEntry`, and `groupThread` for folding runs. Tested without a database. |
| `src/lib/assistant/history.ts` | **Server-only loader.** Explicit columns, request-scoped client, farm and user scoped, newest 20, returned oldest first. |
| `src/app/(app)/assistant/page.tsx` | Loads the thread with the same client and machine list it already uses. |
| `src/components/assistant/assistant-client.tsx` | Renders the thread; moves the live exchange into it. |

**The loader must use the request-scoped client.** RLS is the access control for
this read. `store.ts` uses the service client because it *writes*; reusing that
here would bypass the one rule that makes history safe, invisibly at the call site.

**The browser never receives the row.** A `ThreadEntry` carries id, time, channel,
what was asked, what came back, status, link and — for a pending proposal — the
rebuilt facts. It carries no `tool_args`, provider, model, token counts or error
detail. `tool_args` is read on the server only, to rebuild proposals and links.

### Status, as built

| Stored `result_status` / `confirmation_status` | Shown as | Text shown |
| --- | --- | --- |
| `answered` | no chip | the answer |
| `applied` / `confirmed` | **Saved** + link | the saved message |
| `rejected` / `rejected` | **Not saved — you declined** | the outcome message |
| `proposed` / `pending`, inside its window, machine still visible | **Waiting for your confirmation** + Review | — |
| `proposed` / `pending`, window closed or unreadable expiry | **Expired before it was confirmed** | — |
| `proposed` / `pending`, machine no longer visible | **Not finished** | — |
| `proposed` / `not_required` or `processing` | **Not finished** | — |
| `failed` with `error_code = 'superseded'` | **Replaced by a corrected transcript** | — |
| `failed` with `error_code = 'proposal_expired'` | **Expired before it was confirmed** | — |
| anything else | **FleetWise couldn't do this** | — |

## Where the build deviated from the plan, and why

1. **A pending proposal is reviewed, not confirmed inline.** The plan put Confirm
   and Reject on the history entry. That would have let somebody save a change
   without seeing it. Instead the server rebuilds the proposal's facts with the
   same `proposalFor` the turn route uses, and **Review** re-opens the existing
   confirmation card with every fact shown. There is still exactly one way to save
   a change. If the facts cannot be rebuilt honestly — the machine was retired, or
   an operator lost the assignment — the entry reads **Not finished** and offers
   nothing.

2. **The live exchange is not inside the list.** The plan moved the live cards into
   the thread. They stay where they are, so their focus management and markup are
   untouched, and the exchange moves into the thread when the live area clears.
   That is done by **one** state-transition effect rather than an archive call at
   each reset: there are a dozen of those (new request, cancel, language switch,
   offline processing, farm change), and the next one added would forget. The live
   exchange's id is hidden from the thread while it is live, which is what stops a
   proposal under review appearing twice.

3. **There is no "this was removed" state.** The plan asked for one for
   POPIA-erased rows. They can never reach the page: the erasure
   (`20260829130000_erasure_scrubs_audit_location.sql`) sets `deleted_at`, and both
   the policy and the loader exclude it.

4. **Correction: a clarification is not `pending`.** The plan said an open
   clarification sits at `confirmation_status = 'pending'`. It sits at
   `not_required` (or `processing` while claimed) under `result_status = 'proposed'`.
   Only a confirmation card is `pending`.

5. **Stored failure text is never shown.** Failure rows keep English diagnostics
   written for support ("The selected-farm role cannot perform this intent.").
   Those render as the localized status instead. Answers and confirmation outcomes
   are localized when written, so those are shown.

6. **Expiry is judged twice, without a hydration risk.** The server judges it at
   load. The client re-judges only after mount, every 30 seconds, so a proposal that
   crosses its deadline while the tab is open loses its Review button — and the
   server render and first client render still agree. The confirm RPC refuses an
   expired proposal regardless.

7. **The composer is not sticky.** Pinned to the viewport it sat on top of the
   thread and hid exactly the newest exchanges the thread scrolls into view.

## Fixed along the way

- **A chosen machine was asked about again, as a dead end.** Asking "When is the
  Groen John Deere due for service?" offers a machine choice, because the other two
  machines share the make John Deere. The turn route then re-resolved the chosen
  machine *by name* against the whole fleet — ambiguous again — and, without
  checking, stored the question as the answer and returned it with no picker. The
  thread surfaced it: a row at `result_status = 'answered'` whose response was the
  question. `scopeForChosenMachine` (`local-read.ts`) now narrows the read to the
  machine chosen by id, every database-backed read then filters by that id, and the
  route refuses to persist a "which machine?" reply as an answer.
- **Dates were formatted in the server's timezone.** `shortDate` and `dateTime`
  now pin `Africa/Johannesburg`, the timezone `todayInSouthAfrica`, the nightly cron
  and API-token expiry already use. Unpinned, Vercel (UTC) printed "14 Sep" for a
  record made at 01:30 on the 15th, and a client component rendered one instant as
  09:45 on the server and 11:45 in the browser. `format.test.ts` forces `TZ=UTC`,
  because this workstation is already in South Africa and would hide the bug.
  `daysAgo` — and so `relativeDate`, which reads "Today" and "Yesterday" across
  thirteen files — counted days with the same host-local getters and was fixed the
  same way: both instants are reduced to a South African calendar day before being
  subtracted. Unfixed, a reading captured at 01:30 SAST read as "Yesterday" on the
  server and "Today" in the browser.
- **A declined proposal was headed "Saved".** It now reads "Not saved — you
  declined".
- **A question about one machine was answered with the fleet sentence.** "When is
  the Groen John Deere due for service?" parses as a local `service_attention`
  read, which replied "No visible machines are overdue or due soon for service." —
  true of that machine, and not an answer to the question. Only the Afrikaans
  phrasing reached the deterministic intent and its precise wording, so the same
  question was answered well in one language and uselessly in the other. The
  per-machine sentence is now `serviceDueAnswer` in `presentation.ts`, used by both
  paths: a local read that has resolved to exactly one machine uses it, and the
  fleet listing is untouched for "which machines need service?". Both languages now
  answer "Rooi Massey's service is up to date. Next target: 9 250 h or 2027-06-04."
  This also upgrades the answer after a machine is chosen in a clarification.
- **The two languages took different ROUTES to the same question.** The wording
  was fixed earlier; the split that caused it was not. `local-read.ts` and
  `parser.ts` each kept a copy of the "service timing" vocabulary, and the copies
  had drifted in opposite directions — the local reader knew `verskuldig` but not
  `volgende`, the parser knew `soon` but not `binnekort`. So "When is the X due for
  service?" was answered by the local reader while "Wanneer is die X se volgende
  diens?" fell through to the deterministic intent. Both now import
  `SERVICE_DUE_CUE` from `cues.ts`, measured before and after with the same probe:
  1 of 6 question pairs routed differently by language, now 0 of 6. Two tests hold
  it — one comparing routes, one comparing OUTCOMES, because a shared route that
  answers about a machine in one language and offers a picker in the other is still
  a split.
- **A short model or alias matched almost any sentence.** `matchMachine` scored
  `haystack.includes(label)` at 0.98 with no length floor, so a machine whose model
  is "X" matched the "x" inside "next" — two such machines then looked equally
  likely and the question became a picker. Found while writing the parity test, as
  a fixture artefact that is also a real weakness. Labels shorter than three
  characters now match through trigram similarity only.
- **On a phone the composer sat below the fold.** At 430×900 the input was at
  y=971 while the bottom tab bar starts at 835. The thread's scroll region is now
  16rem on a phone (28rem from `sm` up) and the language hint is desktop-only, so
  the input sits at 731–801 — clear of the tab bar — with the desktop layout
  unchanged.

## Verification

- **Unit tests:** `thread.test.ts` (11), `format.test.ts` (5, with a UTC control),
  two regression tests plus three language-parity tests in `local-read.test.ts`,
  and four in `thread.test.ts` for folding. Full suite 280/280. Each date test
  was mutation-checked: with the host-local getters put back, the day-boundary test
  fails `actual: 1, expected: 0`.
- **Gates:** typecheck, lint, design:lint, i18n:parity, i18n:keys, errors:check;
  production build.
- **The API, directly:** question → `clarify`; clarification choosing Groen John
  Deere by id → `answer`. Before the fix, the second call returned the question.
- **The running app, as the owner — 20 checks, all passing:** the thread opens with
  20 exchanges from the database; a question is clarified and answered; while live
  it is not duplicated; "New request" files it into the thread exactly once; a
  reload reads it back as answered; a fault proposal is clarified twice and offered;
  after leaving and returning it is pending with Review; Review shows the machine
  and the problem and hides the pending copy; declining completes under "Not saved —
  you declined"; it is recorded once and persists after reload; no hydration
  mismatch. The proposal was declined, so no farm data was written.
- **Layout:** 1280px and 430px, light and dark — no horizontal overflow, the thread
  ends above the composer, it opens on the newest exchange, and every bubble stays
  inside the viewport.

## Open

- **No SQL assertion covers an erased interaction being invisible to its own
  subject.** The existing H1 private-RLS block proves subject, colleague and owner
  visibility, not erasure. It was not added because there is no local PostgreSQL on
  the machine where this was built, and an unrun SQL test risks turning CI red.
- The thread shows the newest 20 exchanges, with no "show earlier".

## What not to do

- **Do not add a `conversation_id`** until something reasons across turns.
- **Do not read history with the service client.**
- **Do not put history in `localStorage`.** It is an operational record, and
  erasure can only reach it in the database.
- **Do not confirm from history without the facts on screen.**
- **Do not stream.** A single interpretation is not a generated essay; a typing
  animation over it is theatre.
- **Do not shrink the microphone.** The touch floor is 48px, for a cab and gloves.
