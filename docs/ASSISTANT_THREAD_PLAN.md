# Assistant thread — implementation plan

Written 13 September 2026, against `76f1d8a`. This is a plan, not a record of
work done: nothing in it is built yet.

## Why this document exists

`76f1d8a` turned the assistant from a form into a composer — mic inside the
input, Enter sends, starters that disappear. What it did **not** do is make it a
conversation. A new turn still replaces the last one, so the screen has no
memory and a person cannot see what they asked two minutes ago, or what the
assistant did about it.

That last step is the difference between "a smart input box" and "an assistant",
and it needs real state rather than a reshuffle of JSX. It is scoped here so it
can be done in one deliberate pass.

## The finding that should shape the whole design

**Do not invent client-side history. It is already in the database.**

Every turn is written to `public.ai_interactions` by `src/lib/assistant/store.ts`
(`createInteraction`, `updateInteractionDraft`). The table already carries
everything a thread needs to render:

| Column | What it gives the thread |
| --- | --- |
| `input_text` | what the person asked |
| `response_text` | what the assistant said back |
| `channel` | `typed` / `voice` / `whatsapp` — lets a turn show how it was made |
| `intent`, `tool_name`, `tool_args` | what it decided to do |
| `confirmation_status` | `pending` / `confirmed` / `rejected` / `edited` / `failed` |
| `result_status` | `proposed` / `answered` / `applied` / `rejected` / `failed` |
| `linked_record_type`, `linked_record_id` | the record it created, for a link back |
| `proposal_expires_at` | whether a pending proposal is still actionable |
| `created_at`, `completed_at` | ordering and duration |
| `locale` | which language the exchange happened in |

And the access is **already granted**:

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

So: **no new table, no new policy, no new grant.** A signed-in person can already
read their own interactions, scoped to a farm they may access, and cannot read
anybody else's. Writes stay service-role only, which is correct — the thread is a
view of the record, never a second way to write it.

This is worth insisting on, because the obvious implementation (an array in React
state) is strictly worse in four ways: it dies on reload, it does not follow a
person to their phone, it cannot show whether a proposal was ever confirmed, and
it creates a second account of what happened that can disagree with the audit
record. Reading the table has none of those problems and is less code.

### The one thing that is genuinely missing

**There is no `conversation_id`.** `conversationId` in `AssistantTurnResponse` is
the interaction id — see `src/app/api/assistant/turn/route.ts`, which returns
`conversationId: interactionId` at every branch. A clarify sequence reuses one
row (`reserveClarification` / `updateInteractionDraft`), so a
question→clarification→answer cycle is one row, not three. Separate requests are
separate rows with no link between them.

That is fine, and **do not add a `conversation_id` column for v1.** A thread of
"your recent exchanges, newest last" is exactly what a chat history is, and the
grouping a `conversation_id` would buy is only needed if the assistant ever needs
to reason across turns. It does not today: each turn is interpreted on its own.
Adding the column now would be schema change for a feature nobody has asked for,
and this project's own notes are emphatic about what unneeded migrations cost.

## What "thread" means concretely

Six behaviours, in the order they matter:

1. **Past exchanges stay on screen**, oldest at the top, newest above the
   composer, scrolled to the bottom on open.
2. **Each exchange shows its outcome**, not just its answer: applied, rejected,
   expired, failed. This is the part that builds trust, and it is free — the
   columns already hold it.
3. **A pending proposal in history is still actionable** if it has not expired,
   and is visibly dead if it has.
4. **The in-flight turn appends to the end** rather than replacing the view.
5. **Starting fresh is possible** — a "new request" affordance that clears the
   composer and scrolls to the bottom, without deleting anything.
6. **The record links out**: an exchange that created a fault links to the fault.

## Proposed shape

### Server

Add one read to `store.ts`'s sibling — a **server component fetch**, not an API
route. `/assistant` is already a server component; it can select the rows and
pass them down as props. That avoids a new endpoint, a new auth surface and a
client round trip.

```ts
// src/lib/assistant/history.ts   (server-only, mirrors store.ts)
export type ThreadEntry = {
  id: string;
  createdAt: string;
  channel: "typed" | "voice" | "whatsapp";
  locale: AssistantLocale;
  input: string | null;
  response: string | null;
  intent: string | null;
  toolName: string | null;
  confirmation: "not_required" | "pending" | "processing" | "confirmed" | "rejected" | "edited" | "failed";
  result: "proposed" | "answered" | "applied" | "rejected" | "failed";
  proposalExpiresAt: string | null;
  link: { type: string; id: string } | null;
};

/** The signed-in person's own recent exchanges on the current farm. */
export async function recentThread(limit = 20): Promise<ThreadEntry[]>;
```

Use the **request-scoped client**, not the service client. The RLS policy is the
access control; going through the service role here would bypass the one rule
that makes this safe and would be a genuine security regression. `store.ts` uses
`createServiceClient` because it WRITES; this reads, and must not.

Select an explicit column list. `ai_interactions` also holds `provider`, `model`,
`input_tokens`, `output_tokens`, `confidence`, `error_detail` — none of which
belong on a farmer's screen, and `select *` would ship them to the browser.

### Client

`AssistantClient` gains one prop, `initialThread: ThreadEntry[]`, and one piece
of state, `thread`, seeded from it. The existing `turn` / `transcript` /
`completion` state stays exactly as it is and represents **the live exchange
only**. On completion, push a `ThreadEntry` and clear the live state.

Render order inside the column becomes:

```
language toggle
offline captures (unchanged)
── thread ────────────────────────────
  past entries, oldest first
  the live turn's cards (clarify / confirm / consent / answer) as the last entry
── starters (only when the thread is empty AND nothing is live)
── composer (unchanged from 76f1d8a)
```

The existing result cards become the **last entry in the thread** rather than
free-floating cards. They keep their markup; they move inside the list.

### Entry rendering

One `<ThreadEntry>` component, two rows:

- **The request** — right-aligned or tinted so it reads as the person's turn.
  Show a small mic glyph when `channel === "voice"`, because "I said this" and "I
  typed this" are different memories.
- **The response** — the answer text, then a status line derived from
  `confirmation` + `result`:

| `result` | `confirmation` | Shown as |
| --- | --- | --- |
| `answered` | `not_required` | plain answer, no status chip |
| `applied` | `confirmed` | ok chip + link to the record |
| `proposed` | `pending`, not expired | warn chip + **Confirm / Reject still live** |
| `proposed` | `pending`, expired | neutral chip, "this expired", no actions |
| `rejected` | `rejected` | neutral chip, "you said no" |
| `failed` | any | danger chip + the fallback link |

Reuse `StatusBadge` — do not invent a fifth status vocabulary. The shape+word+
colour rule applies here exactly as it does everywhere else.

## The hard parts, which are where this will go wrong

1. **Expired proposals.** `proposal_expires_at` is real and a stale proposal must
   not offer a Confirm button that will fail server-side. Compute expiry on the
   server at fetch time AND re-check on click; a tab left open overnight will
   otherwise show a live-looking button for a dead proposal.

2. **POPIA erasure.** `20260829130000_erasure_scrubs_audit_location.sql` scrubs
   interaction content. A scrubbed row must render as "this was removed", not as
   an empty bubble that looks like a bug. Decide the copy before building, and
   test against an actually-scrubbed row rather than assuming what one looks
   like.

3. **Farm switching.** The thread is farm-scoped through `has_farm_access`. When
   somebody switches farm with the site switcher, the thread must refetch, not
   persist across the boundary. An exchange about another farm's machine
   appearing after a switch is a privacy problem, not a cosmetic one.

4. **Sign-out.** Nothing about the thread may live in `localStorage`. The
   existing `farmgear:` browser keys are for drafts and tour progress; interaction
   history is somebody's operational record and belongs only in the database,
   where erasure can actually reach it.

5. **Offline.** Offline captures are not in `ai_interactions` until they sync.
   The existing `offlineCaptures` block stays separate and above the thread — do
   not merge them, or a queued capture will look like a completed exchange.

6. **The clarify cycle updates one row.** While a clarification is open, the row
   already exists with `confirmation_status = 'pending'`. If the thread is
   refetched mid-clarification it will appear twice — once from the server, once
   as the live turn. Key the live turn by its interaction id and de-duplicate.

7. **`input_text` can be null.** Voice turns may record no text if retention is
   off. Render the channel and the response rather than an empty request bubble.

## Build order

Each step ends somewhere shippable.

1. **`history.ts` + the type.** Server-only read, explicit columns, request-scoped
   client. Prove it with a test asserting a second user's rows are not returned —
   that is the assertion that matters, and it belongs in the SQL suite where the
   other isolation tests live, not in a mocked TS test. This project's own notes
   record that TS tests mock the Supabase client and therefore assert arguments,
   never reachability.
2. **Render a read-only thread.** No live turn yet, no actions. Ship it; a
   read-only history is useful on its own.
3. **Move the live turn into the thread** as the last entry, with de-duplication.
4. **Re-enable actions on pending entries**, with the double expiry check.
5. **New-request affordance and scroll management.**
6. **Empty, scrubbed, failed and expired states**, each looked at on screen.

## What not to do

- **Do not add a `conversation_id`** until something needs cross-turn reasoning.
- **Do not use the service client** for the read.
- **Do not put history in `localStorage`.**
- **Do not stream.** There is nothing to stream: the turn is a single
  interpretation, not a generated essay, and a fake typing animation over a
  200 ms response is theatre.
- **Do not remove the confirm-before-saving step.** It is the product's best
  idea. Making it *look* like the tool-call confirmation people already know is
  the goal; removing a click is not.
- **Do not shrink the microphone.** Documented 48px touch floor, used in a cab
  with gloves.

## Verification

- SQL suite: a second user's interactions are not visible; a farm you have lost
  access to is not visible.
- Drive it: ask a question, confirm a proposal, reload — the exchange and its
  outcome are still there with the link to the record it created.
- Both themes, and at 430px where the thread and composer share a short screen.
- Six gates, and the shared bundle should not move: this is one list component.
