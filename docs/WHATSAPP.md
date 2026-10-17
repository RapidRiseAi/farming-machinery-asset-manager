# Fleetwise WhatsApp integration

Status: production text pilot activation, 16 October 2026.
Runtime code `c9e4fe4` is deployed at `https://app.fleet-wise.co.za`; the production
flag is `WHATSAPP_ENABLED=1` (live activation deployment `dpl_CmCS8z9CWMGbNrTLsBHz75XPn2aZ`). Real Meta delivery
has not yet been tested. The original disabled-release evidence remains below.
The founder's October 16 screenshots confirm a saved webhook, the `messages` field
subscription, both utility templates Active, and successful Meta app publishing.
The account-level Subscribe webhooks toggle was requested on; its final state has not
been independently checked. The minute scheduler is active and HTTP-verified; the
founder must connect his own number before the controlled live pilot can proceed.

## Disabled release verified on 16 October 2026

- Applied `20261015175415_whatsapp_channel.sql` to project `nmqtcvdwtyggxjjgtnzm`.
  The MCP migration ledger records the same SQL as `20261016075622_whatsapp_channel`.
  Do not apply it again under the repository timestamp; use the existing object probe.
- CI run `38869943650` passed the PostgreSQL 16 suite and every app quality/build gate
  on `5ab1e00`. Local checks passed 632 app tests, all 44 SQL suites and 209 migrations.
- On the production domain: login 200, unauthenticated account 307 to login, link POST
  401, webhook GET without verification credentials 403, disabled webhook POST 503,
  and cron without its bearer secret 401. No customer messages were sent.
- Live checks confirmed RLS and denied direct anon/authenticated access on all four
  delivery/link tables; worker RPCs are service-only and account RPCs reject anon.
  The new role resolver preserves `rr_admin_unlocked()` and the real/test-account fence.
- Advisor comparison added only the expected notices for two private queue tables
  without browser policies and four narrowly authorized SECURITY DEFINER account RPCs.
  Existing security-definer masking-view and other advisory findings are unchanged.
- A browser session was unavailable, so real-phone linking and signed Meta events
  remain unverified. The original checkout's uncommitted work was preserved; the
  release was built in `C:/projects/.fleetwise-whatsapp-launch`.

The verified callback is `https://app.fleet-wise.co.za/api/whatsapp/webhook`.
The initial pilot account is the founder's active test owner on Weltevrede Boerdery
(Complete plan); live membership/entitlement eligibility was checked. Real-phone
linking must still be completed by that signed-in account and its WhatsApp owner.
The corrected pilot login is `therandomneon+owner@gmail.com`. Its existing AI notice
acknowledgement and processing consent were checked. No links, challenges or inbox
messages existed immediately before activation.

## Supabase scheduler

`20261016083512_whatsapp_scheduler.sql` installs hosted `pg_cron` and `pg_net`, creates
`fleetwise-whatsapp-minute` paused, and a daily seven-day cleanup of its own cron history.
Plain PostgreSQL CI skips this optional managed infrastructure; the real hosted install
must be verified separately. `20261016150056_whatsapp_scheduler_permissions.sql` adds
best-effort restrictions for installations where the migration role owns the extension.

Production uses a dedicated Sensitive `WHATSAPP_CRON_SECRET` in Vercel, also stored as
`fleetwise_whatsapp_worker_secret` in Supabase Vault. The Vault URL secret
`fleetwise_whatsapp_worker_url` points to the canonical `/api/cron/whatsapp` endpoint.
The job contains secret names only. The original `CRON_SECRET` remains accepted by
the route but is not given to this scheduler. No unrelated cron credentials were changed.

Hosted pg_net is owned by `supabase_admin`: the project's `postgres` role cannot revoke
its managed schema/table/function grants. The `net` schema is NOT exposed by the Data
API (verified HTTP 406/PGRST106); never expose it, because queued request headers include
the dedicated bearer. Vault denies anon/authenticated secret reads. The extension-in-public
advisor notice describes its installation metadata; its networking objects live in `net`.

On October 16, deployment `dpl_4KKPKd1rRmeZ2C1HxQAgBmXFNmZP` accepted the dedicated
credential with HTTP 200. Both a manual Vault-backed request and the first scheduled
run at 15:12 UTC returned HTTP 200 with disabled/zero counters; cron history also showed
success. `fleetwise-whatsapp-minute` is active every minute. The permission migration
is recorded by the hosted ledger as `20261016150134_whatsapp_scheduler_permissions`.

For subsequent releases, check an authenticated HTTP request
with messaging disabled, then activate only `fleetwise-whatsapp-minute`. Check both
cron history AND `net._http_response` status: a successfully queued HTTP request alone
does not prove worker success. Pause the job through Supabase Cron if repeated calls fail.
References: [Supabase scheduling](https://supabase.com/docs/guides/functions/schedule-functions)
and [Cron history retention](https://supabase.com/docs/guides/cron/quickstart).

## Setup completed on 15 October 2026

- The founder reports Meta business verification complete. The production number is
  registered and billing is added; the system-user token and app credentials are saved
  as production secrets in Vercel.
- `app.fleet-wise.co.za` is the application domain. The founder updated Supabase's
  Site URL and added `https://app.fleet-wise.co.za/auth/callback`; the existing callback
  addresses are retained during the transition.
- The imported ES256 key is current in Supabase. Its public key matches the local
  private key; a short-lived delegated token received HTTP 200 with an empty result
  from the Data API, while a deliberately corrupted signature received HTTP 401.
- Both English utility templates have been submitted. Approval is still to be checked.
  Their static button targets `https://app.fleet-wise.co.za/notifications`.
- Vercel contains all WhatsApp variable names in Production, with credentials marked
  Sensitive and the feature flag set to `0` in the founder's dashboard.

The release is based on production commit `9ee011a`, including the newer admin
verification and test-account rules. The previously unapplied migration was moved to
`20261015175415_whatsapp_channel.sql` so fresh installs and production apply it after
those rules. It preserves the admin verification check and fences both new linking
tables against mixing real and test accounts.

## What is possible

Employees can opt in to notifications, ask the Fleetwise assistant questions, and
prepare and confirm its supported records over WhatsApp. Web and WhatsApp call the
same `runAssistantTurn` and `confirmAssistantProposal` functions: same routing,
model, tools, per-farm AI budget, consent/notice checks, proposals and database commands.
This is one agent with two channel adapters.

The existing agent supports fleet questions, reporting faults, recording readings
and recording completed services, subject to the person's role. Other app workflows
already open a Fleetwise page instead of executing in the agent. WhatsApp preserves
that behavior. Reusing the agent does not make every Fleetwise screen a chat command.
WhatsApp interaction records carry `channel=whatsapp` and appear in the user's existing
assistant history, scoped to that user and farm.

First version: one Fleetwise-owned WhatsApp Business Platform number, one linked
account and selected farm per personal number. English and Afrikaans agent responses
and account settings are supported; transport instructions and the initial approved
notification templates use English. Employees can reconnect through the app to change
the selected farm. Switching the app's farm selector does not redirect WhatsApp.

Voice notes, photos, documents, group chats and username-only/BSUID-only identities
are not implemented in this pilot. Unsupported media receives a link to the app;
messages without a phone identity are ignored. Users must share their phone number
for linking. Voice/media adapters can call the existing transcription and media
workflows later; they are not a second agent. The pilot does not provide complete
input-format parity with the web app.

## Platform feasibility and constraints

Meta's current terms restrict making general-purpose AI the primary product on
WhatsApp. Our interpretation is that an assistant limited to operating Fleetwise is
ancillary to the fleet-management service. This is not a guarantee of Meta approval:
describe the actual employee use case during onboarding and confirm its acceptance
before a customer launch. Do not market this as a general-purpose WhatsApp chatbot.
[WhatsApp Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms).

Recipients must opt in; business-initiated notifications require approved templates.
Free-form replies are allowed within 24 hours of the user's message. Pricing and
template classification are determined by Meta; no per-message price is assumed here.
Automated chats must offer a route to a person; HELP/HUMAN/SUPPORT links to `/help`.
[WhatsApp messaging policy](https://whatsappbusiness.com/policy/).

## Identity and isolation

1. In Account > WhatsApp, an authenticated employee enters their own international
   number and independently opts in to notifications and/or the assistant.
   South African local numbers (082...), +27, 0027, and printed +27 (0) forms are
   normalized to the same provider identity. Other countries need a country code.
   Spaces, brackets, dots and hyphens are accepted; letters and extensions are rejected.
   The normalized number is displayed before and after preparation. Pending form fields
   are locked; Start again deliberately replaces a request instead of accidental re-clicks.
2. The server resolves the current farm, checks active membership and the existing
   WhatsApp plan entitlement (Complete or Done for You), and creates a random 256-bit
   linking challenge. Only its SHA-256 hash is stored, with a ten-minute expiry.
   Linking is limited to five requests per user per hour.
3. The employee sends the prepared LINK message to Fleetwise. Meta's raw-body HMAC
   signature, business account ID, receiving phone ID, token hash and exact sender
   number must all match. Neither display name nor a phone typed into chat is trusted.
4. The employee returns to their signed-in Fleetwise session and confirms the link.
   An active number cannot belong to two accounts, and links cannot be reassigned
   to another person through the assistant. Challenges are single-use.
5. The worker resolves identity from that verified link and creates a 60-second
   `authenticated` user JWT using an imported ES256 signing key. It includes the
   specific link and farm. It never supplies the service-role client to agent reads
   or operational confirmation commands. The existing agent still uses its narrow
   server-side bookkeeping for interaction and AI usage records.
6. Restrictive RLS policies, the legacy view access helper and confirmation checks
   validate the live link, user, farm, plan, membership and assistant authorization.
   A revoked primary membership cannot recover through a legacy profile fallback.
   Operator machine assignments and field visibility remain enforced by the existing
   policies. RR administrators and external workshop identities cannot link in this pilot.
   Pending confirmations and clarifications are discarded when the person's access
   changes; previously prepared details cannot bypass their current permissions.
7. Confirmation refers to a specific server-held proposal and requires
   `CONFIRM <reference>` or `REJECT <reference>`. The shared database function locks
   and checks ownership, farm, role, expiry and idempotency before applying a change.

Assistant authorization lasts 12 hours and can be renewed from the signed-in account.
The number link expires after 30 days and requires the linking flow again. STOP or
Disconnect revokes notifications and assistant access. Notification-only consent
does not permit assistant queries. Unlinked senders receive no account information.

A WhatsApp account is still possession-based: someone with an unlocked phone or
access to that WhatsApp account can act during the authorization window. This design
does not prove who is holding the phone and is not WhatsApp MFA. Use personal numbers,
enable WhatsApp's two-step verification, and disconnect lost/shared devices. Billing,
role changes and other unsupported privileged commands stay in the authenticated app.
If the threat model requires fresh authentication on every write, add in-app approval
instead of treating possession of a linked WhatsApp account as sufficient.

Transport tables have RLS and no browser grants. Message text/replies are cleared after
30 days by the worker; short-lived clarification state is cleared after 15 minutes.
Message IDs remain for deduplication; linked records retain their normal retention.
Operational records and AI interaction retention follow Fleetwise's existing policy.
Phone numbers are access-controlled personal data, not separately encrypted fields.
Include Meta, the AI providers and this retention in the published privacy notice and
data-processing arrangements before launch. Do not send credentials in this chat.

## Notifications and delivery

Job-card mechanic assignments and fault assignments enqueue employee notifications
transactionally, only when the assignee changes. The worker also forwards new
addressed in-app notification events for people who opted in. WhatsApp consent does
not depend on the in-app toggle for the central farm-alert enqueue functions.

Notifications use minimal static text and an authenticated Fleetwise link. They do
not put machine names, costs or fault descriptions on a phone's lock screen. Only
events created after linking are eligible, with current recipient membership,
consent, expiry and assignment checked again before delivery. Quiet hours are
honored when notifications enter the WhatsApp queue.

The webhook writes inbound events before acknowledging receipt. Meta message IDs
deduplicate retries. A leased queue serializes each conversation; the webhook schedules
one pass and an authenticated cron drains any backlog. No message can select a user
or farm from its contents.

Provider sends use atomic `queued/ready -> sending` transitions. If a send times out
or the process crashes after Meta accepts it, the state may be `failed` or `sending`
with unknown delivery. These are intentionally not retried automatically: an ambiguous
POST is not evidence of non-delivery. Delivery-status webhooks update known provider
IDs. Inspect failed/unknown rows before an operator retries; do not bulk reset them.
This is a pilot delivery policy, not an exactly-once network guarantee or a full
operations dashboard. Add bounded retries for confirmed transient refusals and an
operations UI before high-volume rollout.

## Setup the founder needs to complete

1. Create or use the Fleetwise Meta business portfolio and a Meta developer app with
   the WhatsApp Business Platform product. Register a Fleetwise-owned number capable
   of receiving the registration verification code. A dedicated number is easiest;
   do not assume an existing WhatsApp app number can simply be reused without Meta's
   migration/coexistence process. Complete the business verification, display-name,
   billing and app access steps requested by your Meta dashboard.
2. Start with Meta's test number and authorized test recipients. Obtain the WhatsApp
   Business Account ID, phone-number ID, app secret and a server-side system-user
   access token with the necessary WhatsApp messaging access. Select a supported
   Graph API version from the app dashboard. Use separate test/production resources.
3. Submit two utility templates, with **no dynamic variables** and a **static** URL
   button pointing to `https://<Fleetwise-domain>/notifications`:
   - `fleetwise_assignment`: "A work item has been assigned to you in Fleetwise.
     Open Fleetwise to view the details. Reply STOP to disconnect WhatsApp."
   - `fleetwise_notification`: "You have a new work notification in Fleetwise.
     Open Fleetwise to view it. Reply STOP to disconnect WhatsApp."
   These are proposed texts, not pre-approved templates. Meta may require changes
   or a different classification. Set the environment names and language to the
   approved versions. Add approved Afrikaans templates before bilingual notifications.
4. Prepare a dedicated EC P-256 private JWK, securely store it, and import it into
   Supabase Auth's signing-key configuration. Keep its `kid` identical in the server
   environment and Supabase. Follow Supabase's current import/activation process,
   preserve existing valid keys and sessions, and test the delegated token against
   this project's Data API before enabling the channel. Never expose the private
   JWK in a browser, repository, log or message. Never substitute a service-role key.
   [Supabase JWT signing-key instructions](https://supabase.com/docs/guides/auth/signing-keys).
5. Apply `20261015175415_whatsapp_channel.sql` through the established migration
   process after running the SQL suites. Deploy the app with `WHATSAPP_ENABLED=0`.
   Set the server-only variables documented in `.env.example`, including a random
   webhook verification token and the private JWK. Set `NEXT_PUBLIC_SITE_URL` to
   the canonical HTTPS Fleetwise origin. Do not point a preview at production Meta
   resources or give a preview the production signing key.
6. Configure the Meta webhook callback as
   `https://<Fleetwise-domain>/api/whatsapp/webhook`, enter `WHATSAPP_VERIFY_TOKEN`,
   and subscribe the app/WABA to the `messages` webhook field. GET verification can
   run with the feature disabled. Enable the flag in the test deployment when ready
   to receive signed POSTs. The webhook validates the signature against the original
   payload as shown in [Meta's signature example](https://github.com/fbsamples/whatsapp-api-examples/blob/main/signature-validation-with-webhooks-payloads/app.py).
7. Configure the Supabase scheduler above every minute to GET
   `/api/cron/whatsapp` with `Authorization: Bearer <WHATSAPP_CRON_SECRET>`.
   Existing nightly Vercel cron jobs alone do not provide timely task notifications.
   This uses the existing Supabase project without changing the Vercel hosting plan.
8. Finish the privacy/data-processing review, then enable `WHATSAPP_ENABLED=1` for a
   controlled opted-in pilot. Complete the live tests below before inviting wider use.

## Pilot acceptance checks

Operator diagnosis: GET `/api/cron/whatsapp?check=configuration` with the same worker
bearer runs read-only Meta subscription/phone checks, without draining queues or sending.
The credential never appears in output. The response reports subscribed app IDs, whether
the configured phone ID belongs to the WABA, and whether its number matches the configured
business phone. Meta error output is reduced to HTTP status and numeric error code.
App-secret proof also checks that the access token and app secret belong together.
Look for app `1630168065215465` in production's subscriptions. If morePages is true,
absence on the first page is not conclusive. This check does not prove inbound delivery.

Webhook logs contain fixed event codes only: received, signature rejected, payload
rejected, no matching account/phone, link verified/not matched, or processing failed.
Never log a LINK token, message body, sender number, provider response or credential.
The account UI distinguishes an expired/replaced request, an unverified message,
a number already linked elsewhere, and the five-attempt hourly limit.

- Two real test accounts on different farms, plus an operator limited to an assigned
  machine. Each links from Account > WhatsApp and proves their own number.
- Wrong number, forwarded LINK code, expired challenge and another logged-in user
  cannot complete a link. A number already linked to another user is refused.
- Assign a job and a fault. The opted-in employee receives exactly the intended
  template; unlinked and opted-out employees do not. Reassign before send and confirm
  the old assignee receives no assignment alert.
- Ask the same fleet question through the app and WhatsApp. Verify equivalent results
  and compare AI usage ledger attribution. Try another farm/machine/user ID in chat.
- Report a fault, answer its clarification, inspect the proposal and confirm. Repeat
  the same Meta webhook and confirmation: only one operational record is created.
- Deactivate the member, downgrade the plan, expire the assistant grant and send STOP
  while messages are queued. No subsequent protected answer or change is permitted.
- Wait past the 24-hour window; no free-form reply is attempted. Template sends still
  use active consent. Verify `sent`, `delivered`, `read` and `failed` callbacks.
- Stop a worker during processing and during a provider send. Check queue recovery,
  ambiguous-send handling and that another account's conversation is never reused.
- Confirm HELP reaches a staffed support channel and test the app on a real phone.

Local automated checks cover HMAC tampering, business/number routing, JWT signature
and claims, reply-window bounds, reference-bound confirmations, linking ownership,
RLS isolation, membership removal, operator visibility, queue leases, replay and STOP.
They do not replace the live provider/signing-key acceptance tests above.
