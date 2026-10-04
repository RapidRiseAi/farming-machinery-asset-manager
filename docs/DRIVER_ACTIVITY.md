# Driver activity and managed tracking integrations

Requested by the founder on 3 October 2026. This supersedes the no-login QR flow
and the tracking exclusion in the original v1 scope. Implemented in the working
tree; the migration and application must be released together.

## Manual workflow

- `/driver/activity` is linked from the driver home, account profile, team list,
  individual team members and the vehicle QR page.
- A farm member selects a vehicle and starts driving. Arrive records a named stop;
  Depart closes it. Finish closes the session and any open stop. Optional phone
  coordinates require the person's explicit browser permission.
- Owners and managers can select a driver and record updates on their behalf,
  including the actual event time in SAST. Capture time and capturing account are
  retained separately. Drivers see only their own sessions; managers see their farm.
- One active session per vehicle and per driver is enforced by unique database
  indexes. Commands serialize writes, reject overlapping sessions and out-of-order
  events, and prevent invalid arrival/departure sequences. A stale session dialog
  cannot close a newer session. Ending a session remains possible for a manager
  after a driver or vehicle is deactivated.
- Stop duration uses arrival to departure, or session end; an open stop uses the
  current time when the page is rendered. Refresh to update the elapsed time.
  The timeline shows the latest 50 events per session. All stop events contribute
  to durations, even when a tracker produces more events than the API row limit.
- Manual locations are recorded observations, not continuous/background GPS.

## QR access

Anonymous visitors and people without active membership receive the same branded
gate, without vehicle identity, photo, readings or capture controls. Options are
log in, sign up for Fleetwise and discover Fleetwise. Signing up does not join the
vehicle's farm: the manager must invite the person. Existing employee invitations
and activation remain the account-creation path for farm staff.

Signed-in farm members receive vehicle-specific problem, reading, fuel (where the
plan permits) and driver-activity actions. Maintenance, inspection and paperwork
links appear when their existing vehicle permissions permit those records. A
supplier or inspector needs a farm-member account with suitable permissions for
this QR flow; a workshop link alone does not grant this farm-members-only entry.
Existing contractor workflows and access remain separate.

The token identifies the vehicle, but is no longer an authorization credential.
`resolve_member_qr` checks current membership. `record_member_qr` repeats that
check inside the capture transaction and derives identity from the authenticated
account. The old capture functions remain service-role-only for compatibility.
The public fault endpoint also checks same-origin provenance and membership.
Fault retries retain a per-attempt receipt, so a lost response or media retry does
not create a second fault. A receipt cannot be reused with changed capture fields.
Old anonymous offline drafts return `capture_needs_review` instead of being adopted
by a different account. These private routes are not cached by the service worker;
the new cache version removes old cached QR pages when it activates.

## Quoted hardware service

Hardware connections are **not customer self-service**. Only an active Fleetwise
`rr_admin` can configure them at `/admin/driver-integrations` (linked from Farms).
Farm owners/managers can read connection status and open an email to request a
quote; no message is sent automatically.

1. Agree a quote and the provider adapter's scope.
2. Choose the farm and add a disabled connection: tracker, key tag, camera, engine
   sensor or other. Save the generated 256-bit bearer token securely. Only its
   SHA-256 hash is stored; the raw value is displayed once in the setup form.
3. Map each external device ID to a vehicle, and each external driver/key-tag ID
   to a farm employee. IDs are scoped to one connection. Reusing an ID explicitly
   replaces the mapping; cross-farm mappings are rejected.
4. Configure the provider adapter to send the normalized contract below.
5. Add the approved quote reference and activate. Disabled connections cannot
   ingest events. Activation requires a quote reference in both the command and
   table constraint. Staff can disable the connection or rotate its token.
6. Verify a complete start, arrival, departure and end sequence with the chosen
   provider before treating that integration as commissioned.

There are no brand-specific adapters, camera/video ingestion, facial recognition,
device polling or geofencing yet. An adapter translates its provider's callbacks
and identifies the driver; an engine signal alone must not invent a driver.
Manual activity remains independent of this paid service.

## Provider adapter contract

`POST /api/integrations/driving`, HTTPS in deployment.

Header: `Authorization: Bearer <connection-token>`.

```json
{
  "event_id": "provider-event-123",
  "machine_id": "external-device-id",
  "driver_id": "external-key-tag-or-driver-id",
  "kind": "arrive",
  "occurred_at": "2026-10-03T10:15:00+02:00",
  "location": "Grain depot",
  "lat": -25.7,
  "lng": 28.2
}
```

Kinds: `start`, `arrive`, `depart`, `end`, `engine_on`, `engine_off`, `location`.
The location name is required for `arrive`. Coordinates are optional but must be
supplied together. Machine and driver IDs are the mapped external IDs, not internal
UUIDs. Requests cannot specify a farm. JSON bodies are limited to 16 KiB.

Start creates a driving session. Subsequent events require the same active driver
and vehicle. Event times must not go backwards within a session. Equal timestamps
retain their recorded sequence (for key-tag and ignition signals in the same second). Send events in
chronological order; late/out-of-order events receive a conflict for the adapter
to reconcile. Engine off records an engine observation; it does not automatically
close a stop or session. The adapter decides when an authenticated key-tag logout
or other reliable signal becomes `end`.

Successful response: `{ "ok": true, "event_id": "<internal-event-uuid>" }`.
Repeating the same external event ID with the same payload returns the existing
event. Reusing the ID with a changed payload is rejected. Retry transient 503s with
backoff and the same event ID; do not retry a 409 unchanged indefinitely.
401 means invalid/missing token, 403 means farm access unavailable, 409 means a
disabled connection, missing mapping or invalid event sequence, and 400 means
invalid JSON/schema. Disable takes effect on subsequent ingestion transactions.

## Release and verification

Apply `20261003142805_driver_activity_and_secure_qr.sql` before releasing the app.
It is additive; no existing RPC signature is removed. Existing QR stickers remain
valid. Before release, communicate that drivers now need accounts and an online
session, and invite staff who previously used anonymous capture.

- `node scripts/migrate_check.mjs --suite` validates migrations and database suites.
- `supabase/tests/driving_activity.sql` tests tenancy, identities, RLS, transitions,
  duplicate deliveries, device mappings, staff activation and membership revocation.
- `npm test` includes stop-duration tests.
- `node scripts/check_driver_http.mjs` tests a running local build without writing
  data: guest gate, login return path and unauthenticated endpoint refusals.
- Run an authenticated browser/phone check on a staging database with this migration
  before release. No real hardware provider has been connected or commissioned.
