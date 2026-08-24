# FleetWise public API

The FleetWise API is a server-to-server interface for a farm's approved integrations. It is available on the `done_for_you` plan. It is not a browser API and must not be called with a secret from client-side JavaScript.

## Create a credential

An owner or manager opens **API access** in FleetWise while the correct farm is selected. An RR admin can do the same only while actively supporting that farm.

1. Give the credential the name of the integration.
2. Choose `read`, `write:readings`, or both.
3. Set an expiry date when the provider supports key rotation.
4. Copy the `fwk_...` secret when FleetWise shows it.
5. Store it in the provider's server-side secret manager.

FleetWise stores only a SHA-256 digest and a display prefix. The raw secret is shown once and cannot be recovered. If it is lost or disclosed, revoke it and create another one. Revocation takes effect on the next request.

## Authentication

Use HTTPS and send the secret only in the bearer header:

```http
Authorization: Bearer fwk_your_secret_here
```

Do not put a token in a URL, query string, browser bundle, log, support message, or source repository. A token always resolves to the farm that issued it; the API accepts no `farm_id` parameter.

The base URL is:

```text
https://<your-fleetwise-domain>/api/v1
```

## Read endpoints

The `read` scope enables list and single-record reads for these closed resources:

| Resource | List | One record |
| --- | --- | --- |
| Machines | `GET /machines` | `GET /machines/{id}` |
| Meter readings | `GET /meter-readings` | `GET /meter-readings/{id}` |
| Service plan lines | `GET /service-plan-lines` | `GET /service-plan-lines/{id}` |
| Faults | `GET /faults` | `GET /faults/{id}` |
| Job cards | `GET /job-cards` | `GET /job-cards/{id}` |
| Cost entries | `GET /cost-entries` | `GET /cost-entries/{id}` |

List endpoints accept:

- `limit`: 1-200; default 100.
- `offset`: 0-100000; default 0.
- `machine_id`: available on every resource except `machines`.
- `status`: available on machines, service plan lines, faults, and job cards.
- `from` and `to`: inclusive `YYYY-MM-DD` date bounds.

Unknown or repeated query parameters are rejected. Responses never include farm IDs, QR tokens, assigned user IDs, reporter details, finance details, or internal deletion fields. Every query is scoped to the farm derived from the bearer credential and excludes soft-deleted records.

Example:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $FLEETWISE_API_TOKEN" \
  "https://<your-fleetwise-domain>/api/v1/meter-readings?machine_id=8a300000-0000-0000-0000-000000000001&limit=25"
```

A list response has this shape:

```json
{
  "data": [],
  "pagination": { "limit": 25, "offset": 0, "count": 0, "total": 0 },
  "request_id": "c480e244-ece7-4478-8560-25853ec9b91d"
}
```

## Record a meter reading

`POST /meter-readings` requires the `write:readings` scope, JSON content type, and an idempotency key:

```bash
curl --fail-with-body \
  -X POST \
  -H "Authorization: Bearer $FLEETWISE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: deere-reading-20260820-43231" \
  -d '{"machine_id":"8a300000-0000-0000-0000-000000000001","reading":4323.1,"reading_date":"2026-08-20"}' \
  "https://<your-fleetwise-domain>/api/v1/meter-readings"
```

`reading_date` is optional and defaults to today's date in South Africa. `reading` must be non-negative with at most one decimal place. FleetWise derives `farm_id` from the token and always records `source` as `api`; supplying either field is rejected.

Use a unique 8-128 character `Idempotency-Key` for each logical reading and reuse that key only when retrying the same body. An identical retry returns the original record with `idempotent_replay: true`. Reusing a key for different data returns `409 idempotency_conflict`.

## Status and errors

- `200`: successful read or idempotent write replay.
- `201`: reading created.
- `400`: invalid query, identifier, body, or idempotency key.
- `401`: missing, malformed, unknown, expired, or revoked token.
- `403`: missing scope or the farm plan does not include API access.
- `404`: record or same-farm machine not found.
- `409`: idempotency key reused for different data.
- `413`: request body exceeds 16 KiB.
- `415`: request is not JSON.
- `503`: temporary database/API failure.

Errors are JSON and include a support-safe request ID:

```json
{
  "error": { "code": "invalid_token", "message": "Supply a live FleetWise API token in the Authorization bearer header." },
  "request_id": "c480e244-ece7-4478-8560-25853ec9b91d"
}
```

Treat any `5xx` as retryable with exponential backoff. Retry writes with the same idempotency key. Do not automatically retry `4xx` responses without correcting the request or credential.
