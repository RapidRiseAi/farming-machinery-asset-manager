# FleetWise launch checklist

Started 2026-10-13 from the launch readiness review (B = blocker, H = high priority).
Two parts: what the founder does or provides, and what engineering builds. Tick items here
as they are done, with the date and the commit or the dashboard where it was verified.

Money: nothing below costs money before launch except the domain. Every paid upgrade is in
"At launch".

---

## Part 1: Founder

The founder works from a tickable copy of this part (a private claude.ai page with the same
steps, where to click and how to check each one). Keep the two in step when either changes.
Facts below were read from the accounts on 2026-10-14.

### Now, free (or the domain only)

- [ ] **Your real admin login: team@rapidriseai.com** (decided 2026-10-14). It is Rapid
      Rise's only admin. Sign in with the temporary `RR_ADMIN_PASSWORD` from `.env.local`;
      FleetWise makes you set up two-step first (scan the QR code with two devices). Then
      change the password on the Account page to one only you know and delete the line from
      `.env.local`. The therandomneon personas stay for testing (`DEMO_PASSWORD`); the test
      admin persona has no admin powers and says so when it signs in.
- [ ] **GitHub secret scanning and push protection** (repository Settings, Code security),
      free for public repositories: GitHub refuses a push carrying a key or password.
- [ ] **Buy the domain** (e.g. `fleetwise.co.za`, auto-renew on) and tell engineering which one.
      Engineering then gives you the exact DNS records for Vercel and Resend.
- [ ] **Vercel, free:** set `OPS_ALERT_EMAIL` (failed scheduled runs and AI alerts are emailed
      there; nothing has reached anyone so far, including the Gateway's low-credit alert of
      2026-10-06). Set `AI_KEY_SECRET` to 32 random bytes, base64, marked Sensitive (never
      changed afterwards: keys sealed under one value cannot be opened with another). Set
      `LLM_MODEL=openai/gpt-4.1-mini`: the free AI Gateway tier refuses the configured
      `openai/gpt-5.4-mini`, so every AI answer first waits for a refused call. Redeploy after
      each change.
- [ ] **cron-job.org, free:** `CRON_SECRET` is Sensitive in Vercel and cannot be copied, so
      generate a new value, set it in Vercel, redeploy, and give cron-job.org the same value as
      `Authorization: Bearer <value>` on a job calling `https://<domain>/api/push/send` every
      minute. Until this exists, reminders written in the day wait for the nightly run. (After
      Vercel Pro this moves inside Vercel.)
- [ ] **Uptime monitor, free** (UptimeRobot or Better Stack): `https://<domain>/api/health`
      every 5 minutes, alerting phone and email.
- [ ] **Sentry, free Developer plan:** a Next.js project; its DSN in Vercel as `SENTRY_DSN`.
- [ ] **Resend, free tier:** add and verify the domain (SPF, DKIM and DMARC records), then
      change `EMAIL_FROM` in Vercel to an address on it.
- [ ] **Supabase, free, SMTP:** password resets and emailed sign-in links are sent by Supabase
      (`resetPasswordForEmail`, `signInWithOtp`); invites already go through Resend. Supabase's
      built-in sender delivers only to the Supabase team's own addresses, a few an hour, so turn
      on custom SMTP with Resend's details (Authentication, Emails, SMTP Settings) and raise the
      email rate limit. Check with a reset to an address outside the team.
- [ ] **Vercel and Supabase, after the domain:** add the domain in Vercel (Settings, Domains) and
      set `NEXT_PUBLIC_SITE_URL=https://<domain>`; in Supabase, URL Configuration, set the Site
      URL to the domain and add `https://<domain>/**` to the redirect URLs. Tell engineering,
      who then checks emails, PDF links, the installed app and the payment return page.
- [ ] **Supabase, free:** a second project, `fleetwise-staging`, in the same region (load tests
      and risky migrations run there, never on production). Its connection string goes into
      `.env.local` as `STAGING_DATABASE_URL`, never into chat.
- [ ] **Paystack (test mode):** the test webhook URL becomes
      `https://<domain>/api/billing/paystack/webhook`. The payment return page is sent with
      every payment from `NEXT_PUBLIC_SITE_URL`, so no callback URL is needed in the dashboard.
- [ ] **Azure, free tier still:** a monthly budget with alerts at 80% and 100% (Cost Management,
      Budgets), so voice usage can never surprise you.
- [ ] **POPIA, free:** register the Information Officer with the Information Regulator
      (eServices portal). Accept the data processing terms of Vercel (including the AI
      Gateway), Supabase, Microsoft (Azure), OpenAI, Resend and Paystack before real users join.
- [ ] **Lawyer:** a read of the terms (`src/lib/legal.ts`) and the privacy policy, which must name
      Paris hosting, AI and voice processing abroad, the POPIA section 72 basis, lapsed farms
      read-only for 90 days then closed, and that farms can download all their data.
- [ ] **Phones:** one iPhone and one Android for the real-device pass (engineering gives a
      30-minute script). Optional: `SUPPORT_WEBHOOK_URL` for support cases into RapidRise OS.

### Launch week (spend, a few days before, never on the morning)

- [ ] **Vercel Pro** ($20 a month per seat, $20 of usage included; Hobby is non-commercial).
      Engineering then moves the every-minute delivery into Vercel (delete the cron-job.org job
      after) and turns on AI zero-data-retention (`ASSISTANT_TRANSCRIBE_ZDR=1`).
- [ ] **Supabase Pro** ($25 a month; daily backups kept 7 days, $10 compute credit): check the
      backups (Database, Backups), then one restore drill into the staging project.
      Point-in-time recovery (about $100 a month) can come after launch.
- [ ] **Azure Speech: change the pricing tier from F0 to S0** (Speech resource, Pricing tier), at
      least a day early so voice can be tested on it. No monthly fee: pay per audio hour, billed
      to farms cost-plus. F0 allows ONE live recognition at a time, not adjustable; S0 allows
      100 by default, raised by a free quota request.
- [ ] **AI Gateway credit** (pay as you go; the free credit was $4.84 on 2026-10-14) and set
      `LLM_MODEL` back to `openai/gpt-5.4-mini` or whatever engineering recommends then. The
      free tier allows 5 requests a minute per model; one question can take up to 6.
- [ ] **Resend Pro** ($20 a month, 50 000 emails, no daily cap): the free tier's 100 emails a day
      is what a launch day passes first.
- [ ] **Paystack live:** business verification, then the live secret key as
      `PAYSTACK_SECRET_KEY` (Production only) and the live webhook URL; redeploy. Pay a small
      real invoice with your own card and refund it; engineering confirms the live event and the
      settled invoice.
- [x] **Today's farms:** decided 2026-10-14: all four are test farms, marked and walled off
      from real ones (see the account-safety entry in Part 2). Nothing to do at launch: real
      farms sign up fresh, in Paystack live mode.
- [ ] **Final check on the domain:** engineering runs every automatic test and the
      click-through against it; you run the phone script; pick the hour.

### Launch day

- [ ] Uptime monitor and alert inbox open; any alert goes to engineering at once.
- [ ] Follow the first sign-up end to end with engineering watching the server side.
- [ ] Support address: farms see `team@rapidriseai.com` as support and billing address today.
      To change it to one on the domain, tell engineering (there is no admin field for it yet).

### After launch

- [ ] Enforce the content security policy after a week of reports (engineering summarises first).
- [ ] Supabase compute: Small (about $15 a month, less the $10 credit) if the load test or real
      use shows connections or CPU running high.
- [ ] Point-in-time recovery once real data is worth it.
- [ ] WhatsApp (decided: after launch); debit orders through a second provider (decided: later).

---

## Part 2: Engineering (no founder input needed)

Order: correctness and security first, then load, then product.

- [x] **B8** Patch Next.js to 15.5.27 or later, the AI SDK packages (undici), sharp; full test run.
      2026-10-13: next 15.5.27, ai 7.0.138, @ai-sdk/openai 4.0.92, overrides sharp 0.35.5,
      undici 7.30.0, source-map-js 1.2.2; `pnpm audit --prod` clean, 579 tests, build.
- [x] **B7** One shared paging reader and database-side totals; fix the SARS diesel logbook,
      reports, machines list lifetime costs, dashboard, machine page and PDF packs; a test that
      fails on any uncapped read of a growing table.
      2026-10-13: `readAll`/`readByIds`, four database totals, statements and scheduled
      reports pageable; also fixed the farm data export (10 of 17 tables missing), the
      journal CSV, expenses/orders figures over their newest 200 only. Guard test in
      `src/lib/supabase/read-all.test.ts`. Migrations 20261013090000 to 20261013120000.
- [x] **Taps, release 1 (screen):** every file link one download per tap with a sentence on
      failure; every server-action submit locked; dialogs and row menus cannot close mid-save
      and lock their siblings; every uncaught browser error reported; "Sent" only when sent.
      2026-10-18: `scripts/spam_check.mjs` (real taps, 4x slow CPU) and guard tests.
- [x] **Taps, release 2 (server):** a request id (claim) on every create, send and payment
      that can be repeated; PayFast ITN answers 503 on our own failures so it retries.
      2026-10-20: `request_claims` + `runOnce` on 26 actions (recurring invoices and lines,
      payments, refunds, quote to invoice (also refuses a second conversion), stage bills,
      lines, notes, documents, expenses, recurring expenses, fuel, stock, orders, machines,
      imports, invites, report schedules, readings, contractor links), the two email routes
      (and Resend's idempotency key), checklists, API tokens, QR captures (`p_client`);
      emailed-link accept/decline/paid guarded. Proven by `spam_check.mjs` check 6.
- [ ] **Taps, release 2 follow-ups (medium):** work-request media capture id; assistant turn,
      transcribe and voice-session ids (AI spend on a retry); activation "Pay" resuming an
      attempt already in flight; contractor vehicle sync claim; service template unique per
      machine. (The recurring invoice generator locks its schedule since 2026-10-27.)
- [x] **Taps, release 3 (errors):** server actions report what they catch and never put a
      raw database message in the address bar; reads that fail stop pretending to be empty.
      2026-10-20: `errorCode` on 109 redirects (refusals keep their words, our failures are
      reported and said as "try again"); `must`/`mustAll` on the report data (CSV, workbook,
      scheduled emails), VAT, statements, supplier statements, documents, dashboard, machines,
      driver home, billing and the plan lookups; money writes checked (banking undo, expense
      paid/delete/receipt, PO receive, recurring toggles, saving a card restores the old
      default, receipt and failure-notice releases, erasure's auth scrub, sign-up terms,
      contractor connect); client fetches time out; error screens for the public and sign-in
      areas, "Try again" refetches. Swept as eight personas: no page fails for any role.
- [x] **Taps, release 4 (honest reads, finished):** 2026-10-27, every remaining page read
      goes through `must`/`mustAll`/`soft` and its writes are checked. Found by it: checklist
      templates and report schedule recipients were broken on production by ambiguous
      embeds (fixed; `scripts/embed_check.mjs`); malformed ids and stale filters crashed
      pages (`lib/ids`; `scripts/address_sweep.mjs` visits every dynamic route and every
      search parameter with nonsense); every database failure was reported as "[object
      Object]" (`asReportable`); an Auth outage sent signed-in people to sign-in; a
      contractor re-asking a farm that disconnected them reached nobody (and now starts
      with no extras); a half-made partner connection looked connected; a failed webhook
      lookup made Paystack's redelivery a no-op. A refused dialog save comes back with what
      was typed; push toggle, speech-token, checklist copies, vehicle sync and the
      activity log's slow policy (3.9 s to 0.16 s) are done.
- [ ] **Errors follow-ups:** a form that fails on a dropped connection could queue offline
      (needs the online path's request id in the offline envelope); the address sweep's
      accounts (`SWEEP_ACCOUNTS`, `SWEEP_PASSWORD` in `.env.local`) are not in CI.
      **Founder:** set `OPS_ALERT_EMAIL` and a `SENTRY_DSN` in Vercel; read from the
      account again on 2026-10-27, neither is set (nor `AI_ALERT_EMAIL`,
      `SUPPORT_WEBHOOK_URL`, `AI_KEY_SECRET`), so every report reaches only Vercel's log
      stream.
- [ ] **Follow-ups from B7:** the farm export is one in-memory JSON response (a very large
      farm could pass a function's response limit: stream it or split it); the accounting
      summary sums journal lines in the page (move it into SQL); five older SQL suites are not
      run by CI's `run.sh` (ai_usage_invoicing, assistant_farm_data, assistant_fuel_proposal,
      fuel_tank_balances, team_invites).
- [x] **B3** Error tracking wired to Sentry when `SENTRY_DSN` is set; `/api/health` for the
      uptime monitor; alert email when a nightly job fails.
      2026-10-14 (0efd5e3, live): error reporting was already wired without the SDK
      (`src/lib/observability.ts`); `/api/health` answers 503 for a database outage or a
      scheduled route that did not start or never finished; a failed step emails
      `OPS_ALERT_EMAIL` (or `AI_ALERT_EMAIL`). Founder: set one of those in Vercel.
- [x] **B4** Notification delivery: drain more than 25 per run within a time budget; works with
      an external every-minute scheduler now and a Vercel cron after Pro (the vercel.json change
      waits for Pro: Hobby refuses sub-daily schedules).
      2026-10-14 (0efd5e3, live): `drainNotifications` in /api/push/send and the nightly run.
      Functions run on fluid compute with a 300 s limit (read from the project settings).
- [x] **B9** Two-factor sign-in (authenticator app), scope per the founder's decision.
      2026-10-14: `/mfa/setup`, `/mfa/verify`, the account page row; the database refuses Rapid
      Rise's powers without the code (20261014100000). Founder: the next visit asks you to set
      up an authenticator app (Google or Microsoft Authenticator).
- [x] **H1** Billing settings: only the seller details readable by farm users.
      2026-10-14: column grants (20261013130000); Rapid Rise's AI page reads the rest with the
      service client. Every billing and AI function runs as its owner (checked on production).
- [x] **H2** Storage: size and file-type limits per bucket; the move check on updates.
      2026-10-14: 20261013140000; the update policy's check written out (it already applied).
- [x] **H3** Rate limits in the database instead of per-server memory.
      2026-10-14: `public.rate_limit_take` (20261014090000) behind the in-memory check, in the
      speech-token and transcription routes; fails open.
- [x] **H6** Content security policy (report-only first); revoke anonymous execute on trigger
      functions.
      2026-10-14: `Content-Security-Policy-Report-Only` with reports logged by
      /api/csp-report; nine trigger functions revoked from anon, and a suite that fails if any
      returns. Enforce the policy once the reports are quiet (rename the header).
- [x] **Published passwords** (found 2026-10-14, not in the original review): the demo
      personas' and the click-through owner's passwords were in this public repo, and the
      accounts exist on production, Rapid Rise's only admin among them.
      2026-10-14: all fifteen rotated (founder's decision), sessions ended, new values in
      `.env.local` only; scripts and the demo seed read them from there;
      `src/lib/committed-passwords.test.ts` guards it.
- [x] **Account safety** (found 2026-10-14, not in the original review): test accounts walled
      off from real ones (`is_test` on farms, workshops and accounts; triggers on every row that
      ties them together), a test account never Rapid Rise, test farms kept to the trial AI
      amount and to test inboxes, and one answer to "is this Rapid Rise" in the app (admin
      actions had checked only the role, then used the service key past B9).
      2026-10-14: 20261014120000; `test_account_fence.sql` (ten mutations caught).
- [x] **B12** The service-worker "buttons stop working" bug: reproduce in the test browser and fix.
      2026-10-15: reproduced (26 s rising to 57 s over twelve loads, flat bypassed); warming
      made single-flight with a 30-minute cool-down at low priority, RSC requests out of the
      worker; now 2 to 3 s, flat. `scripts/sw_check.mjs`. One look on a real phone remains.
- [ ] **H4** Load test: k6 scripts and a synthetic 500-farm seed for the staging project.
- [ ] **Domain readiness:** every URL from `NEXT_PUBLIC_SITE_URL`; manifest, emails and PDFs ready
      for the domain.
- [ ] **H8** Transfer a farm's ownership; move a machine between farms with its history.
- [ ] **H9** Module switches per farm and a simple mode for operators (per the founder's decision).
- [ ] **UX** Weekly owner digest email; empty states that teach; assistant suggested questions.
- [x] **H5** Keep the click-through test farm out of Rapid Rise's admin totals (removal at launch).
      2026-10-14: `farms.is_test` (20261014110000); all four production farms marked (the founder
      confirmed each is a test). Left out of the admin farm count, the billing console's totals and
      its not-paying list, and the AI revenue total (AI cost keeps them: that is money spent);
      badged where listed. Also fixed: the click-through run marked EVERY farm's open help
      requests resolved (only the test farm had any). Follow-up: Rapid Rise's all-farms
      dashboard still sums test farms (needs a database total, not an id list).

### Founder decisions (2026-10-13)

| Decision | Answer | Engineering consequence |
|---|---|---|
| Two-factor sign-in | Required for Rapid Rise staff; offered to owners | B9 enforces aal2 for `rr_admin`; enrolment on the account page for everyone |
| Trial | None: pay at sign-up, as today | Nothing to build |
| Lapsed subscriptions | Read-only for 90 days, then closed | `lapsed_grace_days` 30 to 90; the farm is read-only in that window, never deleted |
| Founding Farmer offer | None at launch | `billing_promo_codes` stays empty |
| Simple operator mode | Before launch | H9 is a launch item |
| WhatsApp | After launch | Codex's pilot stays out of the launch build |
| Debit orders | Later. Paystack's Direct Debit is Nigeria-only, so it needs a second provider (e.g. Netcash DebiCheck) | Nothing now |
| Unused part of a month after a downgrade | A credit on the next invoice | Credit model for mid-period reductions in the billing engine |
