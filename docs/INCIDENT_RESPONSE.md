# FleetWise, incident response

What to do when something breaks in production, in the order to do it. Restores are in
`BACKUP.md`; the scheduled jobs in `CRON.md`; security design in `SECURITY.md`.

---

## 1. How bad is it

| Severity | What it means | Acknowledge | Customer update |
|---|---|---|---|
| **SEV1** | The app or sign-in is down for everyone; payments fail for everyone; one farm can see another's data; data has been lost | 15 minutes, any hour | Within 1 hour, then every hour until fixed |
| **SEV2** | A core job is broken for many farms (job cards, faults, meter readings, offline sync, emails, a scheduled job) with no workaround | 1 hour in support hours | Same working day |
| **SEV3** | One farm, one screen, or there is a workaround | Next working day | When fixed |

Support hours are Monday to Friday, 08:00 to 17:00 SAST. A SEV1 is worked outside them.
When unsure, call it the higher severity and lower it later.

---

## 2. How you hear about it

- **Uptime check** (`.github/workflows/uptime.yml`): every 10 minutes from GitHub; a failed
  run emails the repository owner. A dedicated uptime service with SMS is on the launch list.
- **`https://app.fleet-wise.co.za/api/health`**: `ok`, `problems` (why it answers 503) and
  `warnings`. Warning codes: `error_reports_off` (no error tracker configured, so errors
  reach nobody), `alert_email_unset` (alert emails have no recipient), `email_not_configured`
  (no email can be sent), `payments_unset` or `payments_test_mode` (no Paystack key, or a
  test key, so no real money moves), `site_url_unset` or `site_url_mismatch` (links in emails
  and PDFs point elsewhere), and a scheduled job whose last run had a failed step.
- **Sentry** (`SENTRY_DSN`): every server error and every uncaught browser error, with the
  request id the customer sees on the error screen.
- **Alert email** (`OPS_ALERT_EMAIL`): failed scheduled runs, AI cost alerts, every new
  support request.
- **`/admin/support`**: requests from customers, with the page and request id attached.

---

## 3. The first 15 minutes

1. **Write down the time** you noticed and what you saw. Start a note; it becomes the timeline.
2. **Open `/api/health`.** A `problems` entry says whether it is the database or a scheduled
   job. A clean health with a broken page points at the last deploy.
3. **Was it the last deploy?** Vercel, the project, Deployments. If the trouble started with the
   newest production deployment, use **Instant Rollback** to the one before it. Code rolls back
   safely because migrations only ever add; if a migration itself is the cause, see
   `BACKUP.md` §3.3 before anything else.
4. **Is it a provider?** status.supabase.com, vercel-status.com, resend-status.com,
   status.paystack.com, azure.status.microsoft, status.openai.com. If so, communicate and wait.
5. **Is it one farm?** Open the farm from the Rapid Rise console with a support visit (it is
   logged and shown to the farm). Never change data without saying so on the support request.
6. **Tell customers early** for a SEV1 or SEV2 (section 5), even before the cause is known.

---

## 4. Playbooks

**The site is down or every page errors**
Roll back the last deploy (step 3). Then Supabase: Database, Health, and Logs (Postgres and
API). A paused or over-limit project shows on the project's home page.

**Nobody can sign in**
Supabase, Authentication, Logs. Check URL Configuration (Site URL `https://app.fleet-wise.co.za`,
redirect `https://app.fleet-wise.co.za/auth/callback**`), the custom SMTP settings, and the
email rate limit. Password sign-in still works when emailed links do not.

**Payments are not going through**
Paystack dashboard, Developers, Webhooks: failed deliveries can be resent, and the handler
processes a resent event once only. `/api/health` shows whether the billing job ran.
`/admin/billing` shows every invoice; a payment made outside the app is recorded there.

**Emails are not arriving**
Resend, Logs: a bounce or a domain problem shows there. `email_not_configured` on
`/api/health` means the key or sender is not set. Supabase sends its own sign-in and reset
emails through the SMTP settings, separately.

**A scheduled job failed or did not run**
`/api/health` names it. Each job can be run again by calling its route with
`Authorization: Bearer <CRON_SECRET>`. Read that job's entry in `CRON.md` first: the billing,
recurring and finance steps guard against running twice; check any other step's note before
running it again.

**One farm may be seeing another farm's data**
SEV1. Roll back the last deploy at once, before investigating. Keep the logs (Vercel, and
Supabase API logs, which last only a day on the free plan: export them). Run the isolation
suite (`pnpm db:test`) against a copy. POPIA section 22: if personal information was reached
by someone not allowed it, notify the Information Regulator and the people affected as soon
as reasonably possible. Record what was decided and when.

**Data was deleted or overwritten by mistake**
`BACKUP.md` §3.1. This needs Supabase Pro (daily backups) or point-in-time recovery: on the
free plan there is no backup to restore from. Erasures done for POPIA must be applied again
after any restore (§3.1 step 5).

**Voice or the assistant fails**
Each farm's AI and voice switches are on its AI page; the provider status pages say whether
it is theirs. Farms keep working without either.

---

## 5. Telling customers

Email the owners of the farms affected (all owners for a SEV1). Reply on any open support
request about it. Say what is affected, what still works, and when the next update comes.
Never guess a cause or a fix time out loud.

**First message**
> Fleet Wise: we know that [what is affected] is not working since [time]. [What still works,
> for example: readings and faults captured on a phone are kept and will send when it is
> fixed.] We are working on it and will update you by [time].

> Fleet Wise: ons weet dat [wat geraak word] sedert [tyd] nie werk nie. [Wat nog werk, byvoorbeeld:
> lesings en foute wat op 'n foon aangeteken word, word bewaar en stuur sodra dit reg is.] Ons
> werk daaraan en laat weet jou teen [tyd].

**When it is fixed**
> Fleet Wise: [what was affected] is working again since [time]. [Anything they need to do, or
> "You do not need to do anything."] We are sorry for the trouble. [For a SEV1: We will send a
> short written account of what happened.]

> Fleet Wise: [wat geraak is] werk weer sedert [tyd]. [Enigiets wat hulle moet doen, of "Jy hoef
> niks te doen nie."] Ons is jammer vir die ongerief. [Vir 'n SEV1: Ons stuur 'n kort skriftelike
> verslag van wat gebeur het.]

---

## 6. Afterwards

Within five working days of a SEV1 or SEV2, write a short account and keep it with the
others: what happened, the timeline, who and what was affected (farms, how long, any data),
the cause, what fixed it, and what stops it happening again, each with an owner and a date.
No blame: the question is which check would have caught it. A business customer gets the
account on request.

---

## 7. Who can get in

Every account the product runs on needs at least **two people** with admin access, two-step
sign-in, and a recovery method that does not depend on one phone. Keep this table current.

| Account | What it runs | Admins |
|---|---|---|
| Vercel | The app, its settings and deploys | |
| Supabase | Database, sign-in, files | |
| GitHub | The code, CI, the uptime check | |
| Paystack | Card payments | |
| Resend | Email | |
| Domain registrar and DNS | app.fleet-wise.co.za | |
| Microsoft Azure | Voice | |
| AI Gateway / OpenAI | The assistant | |
| Sentry | Error reports | |
