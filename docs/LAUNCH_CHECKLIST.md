# FleetWise launch checklist

Started 2026-10-13 from the launch readiness review (B = blocker, H = high priority).
Two parts: what the founder does or provides, and what engineering builds. Tick items here
as they are done, with the date and the commit or the dashboard where it was verified.

Money: nothing below costs money before launch except the domain. Every paid upgrade is in
"At launch".

---

## Part 1: Founder

### Now, free (or the domain only)

- [ ] **Buy the domain** (e.g. `fleetwise.co.za`) and tell engineering which one. Engineering
      then gives you the exact DNS records to paste.
- [ ] **Vercel, free:** add the domain to the project (Settings, Domains) once the records are
      in. Set `LLM_MODEL=openai/gpt-4.1-mini` (the free AI Gateway tier refuses the current
      model, so every AI answer first pays for a refused call). Set `AI_KEY_SECRET` to 32
      random bytes, base64, marked Sensitive (engineering gives the command; never paste it in
      chat). Optionally `AI_ALERT_EMAIL`.
- [ ] **Resend, free tier:** add and verify the domain (SPF, DKIM and DMARC records), then
      change `EMAIL_FROM` in Vercel to an address on it.
- [ ] **Supabase, free:** under Authentication, URL Configuration, set the Site URL to the
      domain and add `https://<domain>/**` to the redirect URLs. Under Authentication, SMTP,
      turn on custom SMTP with Resend's SMTP details: Supabase's built-in sender is limited to a
      few emails an hour, so invites and password resets fail with more than a handful of users.
- [ ] **Supabase, free:** create a second free project called `fleetwise-staging` (load tests
      and risky migrations run there, never on production). Give engineering its database
      connection string through a local `.env` file, not chat.
- [ ] **Sentry, free Developer plan:** create a Next.js project and set its DSN in Vercel as
      `SENTRY_DSN`.
- [ ] **Uptime monitor, free** (UptimeRobot or Better Stack): monitor `https://<domain>/api/health`
      every 5 minutes, alerting your phone and email.
- [ ] **cron-job.org, free:** a job that calls `https://<domain>/api/push/send` every minute with
      the header `Authorization: Bearer <CRON_SECRET>` (the value already in Vercel; copy it
      there, never into chat). Until this exists, reminders leave only in the nightly run, 25 at
      a time. (After Vercel Pro this moves inside Vercel.)
- [ ] **Paystack:** after the domain is live, update the callback and webhook URLs to the domain
      (Settings, API Keys and Webhooks).
- [ ] **Azure, free tier still:** in the Speech resource, open Cost Management and add a monthly
      budget with an email alert (for example R500), so usage can never surprise you.
- [ ] **POPIA, free:** register the Information Officer with the Information Regulator
      (eServices portal). Accept the data processing terms of Vercel, Supabase, OpenAI,
      Microsoft (Azure), Resend and Paystack (all click-through, free).
- [ ] **Lawyer:** a read of the terms (`src/lib/legal.ts`) and the privacy policy, which must name
      Paris hosting and AI processing abroad and the POPIA section 72 basis.
- [ ] **Phones:** one iPhone and one Android for the real-device test pass (engineering gives a
      30-minute script).
- [ ] **Answer the open decisions** (asked as pop-up questions).

### At launch (spend)

- [ ] **Vercel Pro** (about $20 a month), a few days before launch, not on the morning.
      Engineering then moves the every-minute delivery into Vercel and turns on AI
      zero-data-retention (`ASSISTANT_TRANSCRIBE_ZDR=1`).
- [ ] **Supabase Pro** (about $25 a month): turn on daily backups (Database, Backups), then one
      restore drill on the staging project. Point-in-time recovery can come after launch.
- [ ] **Azure Speech: change the pricing tier from F0 to S0** (Speech resource, Pricing tier). No
      monthly fee: pay per audio hour, which farms are billed for cost-plus. F0 allows ONE live
      recognition at a time, not adjustable; S0 allows 100 by default. The change can take
      several hours, so do it at least a day before launch. Above about 60 people talking at the
      same moment, ask Azure support to raise the limit (a free quota request).
- [ ] **AI Gateway credit** (pay as you go) and set `LLM_MODEL` back to the preferred model. The
      free tier allows 5 requests a minute per model; one question can take up to 6.
- [ ] **Resend paid plan** once sending passes the free tier (3 000 emails a month and 100 a day:
      the daily cap is the one a launch hits first, since sign-in emails go through it too).

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
- [ ] **B9** Two-factor sign-in (authenticator app), scope per the founder's decision.
- [x] **H1** Billing settings: only the seller details readable by farm users.
      2026-10-14: column grants (20261013130000); Rapid Rise's AI page reads the rest with the
      service client. Every billing and AI function runs as its owner (checked on production).
- [x] **H2** Storage: size and file-type limits per bucket; the move check on updates.
      2026-10-14: 20261013140000; the update policy's check written out (it already applied).
- [ ] **H3** Rate limits in the database instead of per-server memory.
- [x] **H6** Content security policy (report-only first); revoke anonymous execute on trigger
      functions.
      2026-10-14: `Content-Security-Policy-Report-Only` with reports logged by
      /api/csp-report; nine trigger functions revoked from anon, and a suite that fails if any
      returns. Enforce the policy once the reports are quiet (rename the header).
- [ ] **B12** The service-worker "buttons stop working" bug: reproduce in the test browser and fix.
- [ ] **H4** Load test: k6 scripts and a synthetic 500-farm seed for the staging project.
- [ ] **Domain readiness:** every URL from `NEXT_PUBLIC_SITE_URL`; manifest, emails and PDFs ready
      for the domain.
- [ ] **H8** Transfer a farm's ownership; move a machine between farms with its history.
- [ ] **H9** Module switches per farm and a simple mode for operators (per the founder's decision).
- [ ] **UX** Weekly owner digest email; empty states that teach; assistant suggested questions.
- [ ] **H5** Keep the click-through test farm out of Rapid Rise's admin totals (removal at launch).

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
