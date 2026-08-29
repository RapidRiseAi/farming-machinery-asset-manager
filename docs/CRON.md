# Nightly cron — service dues, notifications, digest

The route `GET /api/cron/nightly` runs the nightly maintenance pass. It uses the
service-role Supabase client (trusted server code, bypasses RLS) and calls, in order:

1. `cron_recalc_all_due` → `app.recalc_all_due()` — recompute every machine's service
   dues. Meter readings recompute on write; this catches **calendar-based** dues that
   drift with no new reading (Scope §4.3).
2. `cron_enqueue_service_notifications` → `app.enqueue_service_notifications()` —
   in-app `service_due_soon` / `service_overdue` rows on status transitions, with a
   **weekly** re-notify while overdue (Scope §4.7 msgs 1–2).
3. `cron_enqueue_stale_meter_nudges` → `app.enqueue_stale_meter_nudges()` — one
   `stale_meter` digest row per farm whose metered machines have readings older than
   the threshold (Scope §4.3 / §4.7 msg 6).
4. `cron_enqueue_fuel_anomalies` → `app.enqueue_fuel_anomalies()` — fuel leak/theft
   anomalies vs each asset's rolling baseline (deduped, F4).
5. `cron_enqueue_expiry_notifications` → `app.enqueue_expiry_notifications()` —
   `warranty_expiring` / `warranty_expired` / `licence_expiring` / `licence_expired`
   reminders honouring per-farm lead thresholds (`warranty_lead_days`,
   `warranty_hours_lead`, `licence_lead_days`), quiet hours, and a **weekly** re-notify
   while expired (F6 / FR-4.7 / FR-13.3).
6. `cron_enqueue_work_request_reminders` → `app.enqueue_work_request_reminders()` —
   chases `quoted` / `invoiced` work requests still outstanding, weekly, deduped from the
   notification queue itself rather than a new column (F13).
7. `cron_enqueue_aarto_nomination_reminders` → AARTO nomination deadlines (G2).
8. `cron_enqueue_document_reminders` → expire stale quotes, chase overdue invoices (G2).
9. `cron_generate_recurring_invoices` → standing invoices whose date has come round (G8).
   Idempotent: it keys on the period it last raised, so a double-fired night, a retry and
   the partner's own "raise it now" all go through the same guard and cannot bill twice.
10. `cron_generate_recurring_expenses` → costs that repeat (G19). Same idempotency shape.
11. `cron_enqueue_low_stock` → parts at or below their reorder point (0451).
12. `cron_enqueue_stock_shortfall` → parts the next N days of scheduled services need but
    the shelf does not have (0503). This engine and the one above are **order-independent**:
    0503 replaced 0451's so that an item which is both low and short raises the shortfall
    line only, whichever runs first — one shelf, one sentence a week.
13. `cron_enqueue_weekly_digest` → **Mondays only** (Africa/Johannesburg). One
    `weekly_digest` per active farm (Scope §4.7 msg 5). The route decides it is Monday; the
    SQL just enqueues.
14. **Scheduled report delivery** (`runDueReportSchedules`) — renders and emails any report
    schedule now due (0506). A TypeScript step rather than an RPC, because it renders the
    report and sends mail; it runs AFTER the database steps so every attachment reflects the
    same final state a person would see on /reports.
15. **Web Push delivery** (`deliverPush`) — for every queued row that is now deliverable
    (past its quiet-hours `deliver_after`) and not yet pushed, deliver a signed VAPID push
    to each recipient's subscribed devices, honouring the per-user `notify_push` toggle.
    No-ops gracefully when the VAPID env keys are unset (see `.env.example`).

**A failed step is now reported, not swallowed.** Each engine's error is captured to the
observability layer (`NFR-6`, env-gated on `SENTRY_DSN`; otherwise the server log) and the
pass **continues** — step 7 failing must not stop steps 8 through 15. Until this was added,
a broken engine could stay broken for weeks: the failure went only into this route's JSON
response body, which is returned to Vercel's scheduler and read by nobody.

In-app is the always-on channel. **Web Push** (F6) is self-hosted (VAPID, no external
provider) and layered on top of the same `notifications` rows. WhatsApp (Stage 2 / BSP
API) is deferred; a later worker maps queued `notifications` rows onto WhatsApp.
Retired/sold and soft-deleted machines never enqueue.

Per-user preferences (FR-14.3) gate delivery: `users.notify_inapp` decides whether a row
is enqueued at all; `users.notify_push` decides whether it is pushed; per-user
`quiet_hours_start` / `quiet_hours_end` override the farm window.

## Schedule

`vercel.json` runs the route at **03:00 UTC = 05:00 SAST** daily:

```json
{ "crons": [ { "path": "/api/cron/nightly", "schedule": "0 3 * * *" } ] }
```

05:00 SAST is the end of quiet hours, so held notifications become deliverable right as
the farm's day starts, and the Monday digest lands before the 06:00 morning read.

## Authentication

The route **requires** `Authorization: Bearer ${CRON_SECRET}` and returns `401`
otherwise (no secret configured also returns `401`).

- **Vercel Cron:** set a `CRON_SECRET` environment variable in the Vercel project.
  Vercel Cron then attaches `Authorization: Bearer $CRON_SECRET` to every invocation
  automatically — no per-cron config needed. This is the intended production path.
- **External pinger** (cron-job.org, GitHub Actions, an uptime monitor): send the same
  `Authorization: Bearer <secret>` header.
- Vercel also sets an `x-vercel-cron` header on scheduled invocations. We do **not** rely
  on it for auth (it can be spoofed by anyone hitting the URL); the bearer secret is the
  gate. If you ever run without `CRON_SECRET` in a throwaway preview, the route stays
  locked (401) rather than open — set the secret to enable it.

Manual trigger (e.g. local verification):

```bash
curl -s http://localhost:3000/api/cron/nightly \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Response shape:

```json
{ "ok": true, "ranAt": "2026-07-20T03:00:01.123Z",
  "steps": { "recalc_all_due": "ok", "service_notifications": "ok",
             "stale_meter_nudges": "ok", "weekly_digest": "skipped (not Monday SAST)" } }
```

## Settings keys read

Per-farm thresholds live in `farms.settings` (jsonb). The engine reads the **live UI
convention** (integer hours / days):

| Key | Default | Used by |
|---|---|---|
| `due_soon_hours` | `25` | due engine (0202) — hours before due = "due soon" |
| `due_soon_days` | `14` | due engine (0202) — days before due = "due soon" |
| `stale_reading_days` | `30` | stale-meter nudge — max reading age before "outdated" |
| `quiet_hours_start` | `20` | quiet-hours gate — start hour (0–23, SAST) |
| `quiet_hours_end` | `5` | quiet-hours gate — end hour (0–23, SAST) |

For forward-compatibility the quiet-hours helper also accepts time-string aliases
`quiet_start` / `quiet_end` (e.g. `"20:00"`), and the stale nudge accepts
`stale_meter_days`, but the settings UI writes the integer-hour/day keys above.

## Quiet hours & the `deliver_after` column

Non-urgent enqueues created **inside** a farm's quiet window (default 20:00–05:00 SAST)
get `notifications.deliver_after` set to the next window end; outside the window it is
`NULL` (deliver immediately). Quiet hours are disabled if `start == end`.

**In-app centre contract:** hide rows where `deliver_after > now()`. A row is
"deliverable" when `deliver_after IS NULL OR deliver_after <= now()`. Unread state is
`read_at IS NULL`; set `read_at = now()` when the user opens it. Index
`notifications_user_unread_idx` supports the `(user_id, unread)` listing.
