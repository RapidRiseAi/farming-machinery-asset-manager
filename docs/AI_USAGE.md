# AI and voice usage

How FleetWise measures, limits and (in the next release) bills what voice and AI cost, per
farm and per person. Founder decisions of 2026-10-03, recorded as decision 10 in
`docs/FLEETWISE_FOUNDER_DECISIONS.md`.

## The decisions

1. **AI help is on by default.** The AI hearing of a hard voice request and AI answers for a
   hard request run for everyone who has seen the notice; anyone can switch them off.
   Legal basis: service necessity (POPIA s11(1)(b)), with the notice satisfying s18. The
   recording leaves South Africa, so the Vercel, Microsoft and OpenAI data agreements
   (s72) must be signed **before real users join**.
2. **Billed at cost plus a margin.** Provider cost in USD, at the day's ECB rate, plus the
   margin a platform admin sets (default 30%), excluding VAT.
3. **Owner limits that hold.** A monthly limit per farm (and optionally per person). At the
   limit voice AND AI pause; typing and every form keep working. The owner is told at 80%
   and when the limit is reached, and can raise it on the spot.
4. **A farm's own OpenAI key.** Linked by the owner; its use is recorded and shown, never
   billed by FleetWise. ChatGPT subscriptions cannot be linked (no API access).

## What costs money (prices read 2026-10-04)

| Source | Runs in | Price | A typical request |
|---|---|---|---|
| Azure live recognition, continuous language ID | browser, South Africa North | $1.00/audio hour + $0.30 enhanced add-on | 6 s: $0.0022 |
| Azure fixed-language recognition (the second hearing) | browser | $1.00/audio hour | 4 s: $0.0011 |
| Azure neural speech (spoken replies, read-back) | browser | $15 per million characters | 120 characters: $0.0018 |
| AI hearing: openai/gpt-4o-transcribe | server, Vercel AI Gateway (or OpenAI directly on a farm's own key) | tokens: audio in $6, text in $2.50, text out $10 per million (about $0.006/minute of audio, plus the machine-name prompt) | 4 s: about $0.001 |
| AI hearing fallback: microsoft/mai-transcribe-2 | server, Gateway | $0.10/audio hour | 4 s: $0.0001 |
| AI answers: LLM_MODEL (for example openai/gpt-5-mini) | server, Gateway | $0.25 in, $2.00 out per million tokens | about $0.001 |

Per request, Azure voice costs more than the AI hearing. Sources: Azure retail prices API
(`southafricanorth`, Azure Speech S1 meters), the Gateway's public model list
(`https://ai-gateway.vercel.sh/v1/models`, field `pricing`), frankfurter.app (ECB).

## Keeping AI use low (measured)

The 90 saved test recordings replayed with the app's own easy/hard rule and server fusion:

| Hard-turn hearings | Right | Wrong | Paid calls per hard turn |
|---|---|---|---|
| Azure only (live and the second pass) | 72% | 1% | 0 |
| plus gpt-4o-transcribe | 96% | 0% | 1 |
| plus MAI and gpt-4o in parallel (until 2026-10-04) | 96% | 0% | 2 |

So the AI hearing is one call: gpt-4o-transcribe, with MAI started only when gpt-4o fails or
has not answered in 3 seconds. Same accuracy, half the calls. Only hard turns are heard by
AI, and the LLM runs only when the free paths cannot answer (next section).

## The assistant reads the farm (2026-10-08)

Until this release the AI saw only the words of a hard request, so "what did we spend on
diesel last month?" got an apology. Now:

- **Free first** (`routing.ts` `routeWantsAgent`, `topics.ts`). Help, navigation and the
  plain lists the local reads answer ("show open faults", "which machines need a service")
  cost nothing. The agent is asked only when a question needs fuel or money, a sum, a
  comparison, a period, a reason or a follow-up, or when nothing local understood it. When
  AI is off, paused, rate limited or failing, a question the local paths understand still
  gets their answer, as before.
- **The agent** (`agent.ts`). One run of `generateText` with tools, at most four steps,
  temperature 0. The prompt carries a line per machine the person can see, and the numbers
  for the question's topic AND period, worked out on the server (`questionPeriod`: "this
  month", "last month", "in August", "vanjaar", "the last 3 months"), so most answers take
  one model call. Read tools cover fuel, costs, one machine in full, the service plan,
  faults, job cards, work requests and (roles that may) quotes and invoices.
- **Numbers from the database** (`20261005130000`). `assistant_fuel_summary`,
  `assistant_fuel_consumption` (the /fuel interval method) and `assistant_cost_summary` (the
  cost ledger the reports read) add up on the person's own session, by machine or by month
  so a result never reaches PostgREST's 1 000-row cap. An operator counts only their own
  machines' draws; a role that may not see money gets litres and no rand.
- **It never writes.** `propose_fault_report`, `propose_meter_reading` and
  `propose_completed_service` stop the run and become the same draft the parser makes; the
  existing card and tap save it.
- **Diesel by voice** (2026-10-09, `20261009090000`). "I put 80 litres in the bakkie",
  "gooi 90 liter diesel in die bakkie": the parser makes a `log_fuel` draft for nothing
  (litres plus a fuel word or a filling verb, never a question); otherwise the agent's
  `propose_fuel_draw`. The tank is the farm's only one, the one named, or the next
  question; litres are asked when missing. A draft has eleven keys, or thirteen with
  `litres` and `tankId` (only a draw may give them values), and the confirmed draw goes
  through `record_fuel_issue`, the Fuel page's writer, with no cost, exactly like a draw
  typed there without one.
- **Metering.** One hold per run, sized for four steps (prompt, data, tool results, output
  ceilings); settled once with the run's total tokens and the Gateway cost summed over its
  steps. Measured on the click-through farm with gpt-4.1-mini: one step, about 2 500 input
  tokens, about 2 s of model time, about 2.5 cents a question billed.
- **Consent.** The notice and consent texts say the farm records an answer needs go to the
  model (only what the person can see). Acknowledgements are stamped `ai-on-default-v2`
  (`20261008090000`); anyone who acknowledged v1 sees the new notice once.

## How it is built

**The ledger** (`supabase/migrations/20261004100000_ai_usage_metering.sql`). Every paid
attempt takes a **hold** (`ai_reservations`) before the provider is called, on the
credential it will really use, and is **settled** into `ai_usage` afterwards: units,
the provider's true cost, the rate and margin used, the amount billed (clamped to the
hold, so a limit is never passed), the outcome and latency. Failed calls are rows too, so
failure rates come from the same table the bill does. `ai_usage` is a money record: no
UPDATE except stamping the invoice once, no DELETE; POPIA erasure pseudonymises the person's
users row and keeps the id, as everywhere else.

- One lock per farm serialises every hold, so two people cannot both spend the last rand.
- A hold is an upper bound of what its call can consume (`lib/ai-usage/hold-units.ts`): an
  AI hearing holds its audio, its machine-name prompt and a transcript allowance; an AI
  answer holds the prompt and the output ceiling. A bound that turns out too low shows up
  as rows clamped to their hold, which the nightly job flags (`holds_clamped`).
- Only a call that answered is billed. A call cut off after it was sent (the server's
  deadline, or the other hearing won) records its estimated cost for `/admin/ai` and bills
  nothing; a call refused before any work costs nothing.
- Every unsettled hold counts against the month, however old; nothing frees budget by
  expiring. The nightly sweep settles what the server or the browser never finished.
- The month is the calendar month in Africa/Johannesburg for every farm. Billing periods
  were rejected: an annual plan would make the "monthly" limit yearly, and a period the
  generator has not advanced would make the cap read zero.
- Until a farm has paid us money (net payments above zero, not an invoice's status: a 100%
  promotion marks an invoice paid with nothing received) its limit is the trial limit
  (R50), which nobody can raise; then the default is R200 and owners may set up to R5 000
  (a platform admin above that). All four values live on the audited `billing_settings` row.
- The owners (home-farm owners and owners by membership) are told at 80% and when the
  limit is reached, once per month and limit, by the database itself
  (`app.ai_notify_owners`), in the same transaction that sets the flag: whichever path
  settled or refused (an AI call, a voice report, a token request, the nightly sweep), the
  notice cannot be lost.
- Rapid Rise support use on a customer farm is recorded as `internal`: never billed, never
  counted against the farm's limits, and not listed on the owner's page.

**Voice.** Azure runs in the browser on a token that works for the whole Speech resource
for about ten minutes, so Azure itself cannot enforce a budget and the server cannot see
what a token is used for. So **every Azure token opens a voice session**: the speech-token
route holds budget for a session (up to two minutes of audio and 1 500 characters, shrunk
to what the month has left, down to ten seconds) before it asks Azure for a token, and
refuses a farm whose voice is off or whose month is spent. An app that does not meter
(an installed copy of an older build, which sends no version) gets no token at all and is
told to update. The current app adopts the token's session and opens more as each fills
or reaches nine minutes old (`/api/assistant/voice-session`), releasing the old one first
and making do with a session the server shrank to the month's last budget; it reports
cumulative use within two seconds of every use and every 30 seconds (a recognition still
running included), and closes the session with a final report when the app is hidden or
the page closes (beacons; `/api/assistant/voice-usage`), so an open session's hold never
lingers against the month after the app is put away. The database clamps every report to
the session's maximum (not to the time since it opened: an offline recording is
recognised from a file faster than it was spoken) and settles a session that never
reported at its full maximum. A report to a session that is already closed is answered
410, and the app opens another.

Voice amounts are therefore `client_bounded`, and it is worth being plain about the limit
of that: an honest app is measured, but a tampered one that takes a token and reports
little or nothing can use Azure beyond what it reports, because the token is not limited
by its session. What bounds it: tokens are capped per person (30 an hour, 150 a day, far
above real use, since the app reuses a token for eight and a half minutes); the nightly job
flags anyone who took ten or more tokens in a day with almost no use reported
(`voice_underreported`); and the monthly reconciliation against the Azure bill (release B)
is the backstop. Moving speech synthesis and clip recognition to the server (release B)
leaves only live recognition in the browser.

**The AI hearing** (`/api/assistant/transcribe`): the clip must be exactly the recorder's
format (PCM, 16 kHz, mono, 16-bit) and is billed for the length its data really has, so a
forged header cannot shrink the bill. Each attempt is held and settled on its own; provider
calls run on the server's own deadline, counted from the request's arrival, and settle in
`after()`, so a dropped connection still writes the row. Once a hearing is in, the other
attempt is cancelled.

**AI answers** (the turn route): the model and credential are resolved before the consent
permit row and the hold; `maxRetries: 0` everywhere, so one hold covers one call. The call
runs on the server's deadline, never the browser's connection (closing the page cannot make
a paid answer free), and the hold is settled exactly once: a storage error after the call
is the route's own failure, never a second, free settlement. A refusal returns
`code: "ai_paused"` with the reason, shown as a calm notice, and typing keeps working.
When the Gateway refuses the configured model outright on the platform's account (no access
on this plan, an unknown model; seen in production on 2026-10-05, when `LLM_MODEL` named a
model the free tier refuses and every hard request answered "AI help is unavailable"), the
answer falls back to `LLM_FALLBACK_MODEL` (default `openai/gpt-4.1-mini`) with a hold of its
own, and a `gateway_auth` health event opens at once with the Gateway's reason, so the
founder sees it on `/admin/ai` the same day rather than after a night of failures.

**Gateway options** on every call on the platform's credential: `tags` (`farm:<id>`,
`feature:<name>`) for the monthly spend report. The person's id is not sent to the Gateway;
the ledger already attributes use. A farm's own key never rides on a Gateway request.

**A farm's own key** is checked with one token of gpt-4o-mini on the farm's account (listing
models answers 200 even for an account with no credit), sealed with AES-256-GCM under
`AI_KEY_SECRET` with the farm id bound in, and readable only by the service role. It is
used **at OpenAI directly** (`lib/ai-usage/openai-direct.ts`), never through the Gateway's
request-scoped BYOK, which documents that a request whose own credentials fail may fall
back to the platform's (and zero data retention skips such keys altogether): that would put
the farm's use on Rapid Rise's account with no hold, no bill and no limit. Directly, a
refused key is just a failed call: the owner is told once, and AI help either pauses (the
default; the backup hearing pauses too) or carries on billed on ours (the owner's choice).
An own-key hearing is settled on the tokens OpenAI reports; an own-key answer asks OpenAI
not to store the conversation. The key covers OpenAI models only: voice, and the backup
hearing (Microsoft's model, used only when OpenAI is slow or fails), stay on the farm's
FleetWise bill. A key that cannot be read (a database error, `AI_KEY_SECRET` missing, or a
value sealed under another deployment's secret, which each sealed value names by a short
secret id) fails closed: AI is skipped, never quietly billed on ours, and nothing is marked;
only a value sealed under this very secret that still will not open is marked broken and
its owner told. Use one `AI_KEY_SECRET` for every deployment that shares the database (a
Preview with its own would refuse every farm's key until it is the same). Errors are
reduced to a code before anything is logged: an AI SDK error carries the request body,
which holds the key.

**AI on by default** (`20261004095000_ai_notice_and_default.sql`). A new profile still
starts with AI processing off; the notice is the default's switch. Its main button, "Got
it", keeps AI on; "Switch off" turns it off. `ai_notice_seen_at` is personal (only the
person sets it, the database stamps it, it cannot be unset), and every hold for an AI
feature refuses until it is set, whatever a client does. The microphone and hands-free
mode wait for the notice online (an offline recording stays on the phone, and AI cannot
hear it until the notice is seen); on a farm whose owner switched AI off there is no
notice, no consent card and nothing to switch per person. Someone who had switched AI off
stays off: the notice tells them so, "Got it" only records that they were told, and
switching on is its own explicit button. "Got it" counts once (a second device still
showing the notice switches nothing on); "Switch off" always counts. The evidence names
the text actually shown: `ai-on-default-v1` once the notice is seen (someone already on
under an earlier text is moved to it then), `voice-ai-v1` for a switch-on without it (the
previous build's card), and the old build's v2 upgrade never overwrites the notice's.

**Failure detection.** Every call's outcome is classified from the provider's error type,
code and status (`lib/ai-usage/outcome.ts`; OpenAI's 429 `insufficient_quota` is an
exhausted account, not a burst). The nightly job counts the last day in the database
(`ai_ops_window`), opens one health event per problem and alerts the founder (the
observability layer, and email to `AI_ALERT_EMAIL` when set): a model failing more than
25% of at least 8 calls in a day (platform credential only, so one farm's broken key is not
an outage; an answer the model gave but that could not be used is the request's difficulty
and is not counted, though its cost is recorded), more than 5% of a model's rows clamped to
their hold, voice taken without being reported (above), Gateway credit refused or below
`AI_GATEWAY_LOW_CREDIT_USD` (default $5), a price or rate outside 25% of the last one (held
for a person on `/admin/ai`), and a model with no price on file. A farm key that no longer
opens under `AI_KEY_SECRET` is marked and its owner told once, as a refused key is.

**Releasing and rolling back.** Apply the migrations first (`scripts/apply_pending.mjs`
probes each for something only its final version has), then deploy. The previous build
keeps working while the migrations are in and the deploy is pending. A rollback past this
release is NOT clean once people have seen the notice: their evidence names the notice
(`ai-on-default-v1`), which the previous build does not know, so its AI hearing stops for
them and its wider-consent card fails to save (and its voice is unmetered again). Roll
forward instead, or ship a hotfix to the previous build that treats `ai-on-default-v1` as
covering the recording. Never let the trigger rewrite `ai-on-default-v1` to `voice-ai-v2`:
that would replace the notice's evidence with an older text.

**Invoicing** (`20261010090000_ai_usage_invoicing.sql`). Off until Rapid Rise sets
`billing_settings.ai_billing_starts_on` on `/admin/ai` (a date cannot be in the past; empty
stops it). From that day:

- **Completed months only**, Johannesburg's calendar month, in arrears. The running month
  is never billed, so the invoice shows what the owner's page showed for that month.
- **On the plan invoice.** The nightly generator stamps every unbilled completed month onto
  the period invoice while it is a draft (`app.billing_attach_ai_usage`): rows by UPDATE ...
  RETURNING, so what is summed is what was stamped, and `ai_usage_guard` allows one stamp
  ever. The header carries the ex-VAT amount (`ai_usage_ex_vat_cents`); the derive trigger
  adds VAT at the invoice's own rate and adds it to the total after the discount (a
  discount is a price on the plan, not on the provider's bill). A line (sort 10) shows it.
- **On its own** (kind `ai_usage`, `app.generate_ai_usage_invoices`, a cron step after the
  period invoices and before the charges) for a farm no period invoice reaches this month:
  an annual plan, a price on application, grace, a farm past its plan. Only once its
  unbilled use reaches `ai_min_invoice_cents` (R50 ex VAT by default); less waits. Never a
  trial or an unfinished sign-up: their use goes on the first invoice. A farm with no
  subscription row has no card: its use stays on the ledger, visible by farm here.
- **Who used it** is frozen on the invoice (`ai_usage_people`: name, voice seconds, AI
  requests, ex-VAT amount) and printed on the invoice and receipt PDFs below the plan,
  discount and AI rows, which add up to the total. A voided invoice keeps its rows: voiding
  forgives that use.
- **The renewal notice** quotes the discounted plan (it quoted the list price) at the price
  the generator will use (it read the active version, not a grandfathered pin), and while
  AI use is invoiced says "plus your AI and voice use (R... so far)".

`supabase/tests/ai_usage_invoicing.sql` covers all of this, mutation-checked.

## Screens

- **`/settings/ai`** (owner and Rapid Rise, for the selected farm): this month's spend
  against the limit, with holds for calls in progress; use and cost by person (everyone on
  the farm, by home farm or membership), with own limits; AI help and voice on or off for
  the farm; the farm's own OpenAI key. Every change is a dialog. Owners read what was used
  and billed, never the provider cost, rate or margin (those columns have no grant).
- **`/admin/ai`** (Rapid Rise): provider cost against billed, by farm, summed in the
  database (`ai_admin_month`); the margin and the day's rate (both changeable); when AI
  use starts to be invoiced and the smallest AI-only invoice; health events; the prices in
  force.
- **`/billing`**: an AI-only invoice is named as one; a plan invoice says how much AI use
  it includes.
- **The assistant**: the notice on first use (a different one for someone who switched AI
  off); a paused or switched-off message as a calm notice instead of an error; a footer
  switch to turn AI help back on.

## Not built yet

- A margin change taking effect from the next month with notice to owners.
- Monthly reconciliation against the Gateway spend report and the Azure bill, and a
  nightly flag for voice sessions whose reports are implausibly low for the tokens issued.
- A daily canary call.
- Moving Azure speech synthesis and clip recognition to the server, so voice is measured
  server-side and only live recognition stays in the browser.

## Founder actions

- Decide when farms start paying for AI and voice use and set the date on `/admin/ai`
  (Invoicing). Until then nothing is billed. Use before the date is never billed, so a date
  in a new month, announced to owners beforehand, is the clean start. Check the smallest
  AI-only invoice (R50 ex VAT) at the same time.

- Sign the data agreements with Vercel, Microsoft and OpenAI before real users join.
- Move Vercel to Pro (Hobby is non-commercial and refuses zero data retention; set
  `ASSISTANT_TRANSCRIBE_ZDR=1` after).
- Add AI Gateway credit (the free tier allows 5 requests a minute per model).
- Move Azure Speech to S0.
- Set `AI_KEY_SECRET` (32 random bytes, base64, Sensitive) before any farm links a key, and
  optionally `AI_ALERT_EMAIL`.
