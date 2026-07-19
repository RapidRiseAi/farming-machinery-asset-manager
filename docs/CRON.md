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
4. `cron_enqueue_weekly_digest` → `app.enqueue_weekly_digest()` — **Mondays only**
   (Africa/Johannesburg). One `weekly_digest` per active farm (Scope §4.7 msg 5). The
   route decides it is Monday; the SQL just enqueues.

Channel is **in-app only** (Stage 1). WhatsApp (Stage 2 / BSP API) is deferred; a later
worker maps queued `notifications` rows onto WhatsApp. Retired/sold and soft-deleted
machines never enqueue.

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
