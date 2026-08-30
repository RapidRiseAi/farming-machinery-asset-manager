# FleetWise — POPIA compliance posture

**Status:** F8 (NFR-3). This document is the authoritative record of how FleetWise
handles personal information under South Africa's **Protection of Personal Information
Act, 2013 (POPIA)**. It covers the personal-data inventory, lawful bases, retention &
deletion policy, cross-border processing stance, and the data-subject rights we
implement. Companion docs: [`SECURITY.md`](SECURITY.md) (security posture) and
[`BACKUP.md`](BACKUP.md) (backup/restore).

> **Roles under POPIA.** RapidRise AI (FleetWise) is the **operator** (processor) for a
> farm's data; each **farm is the responsible party** (controller) for the personal
> information of its team and drivers. Farm owners/managers exercise data-subject
> requests on behalf of their people through the in-app tools described below; FleetWise
> staff (rr_admin) act only in a support capacity, and every cross-tenant access is
> logged.

---

## 1. Personal-information inventory

Everything in the product is tenant-isolated by `farm_id` and Row-Level Security (see
[`SECURITY.md`](SECURITY.md)). The personal information we hold:

| Where | Fields | Data subject | Special/sensitive? |
|---|---|---|---|
| `public.users` | `name`, `email`, `phone`, `language`, `whatsapp_opt_in`, `role`, `farm_id`/`workshop_id` | Team members, contractors, RR admins | No (contact data) |
| `auth.users` (Supabase Auth) | email, hashed password, magic-link tokens, last-sign-in | Same accounts | No (credential data — hashed) |
| `usage_logs` (AARTO) | `driver_user_id` **or** free-text `driver_name`, `machine_id`, `occurred_on`, `meter_reading` | **Drivers** (incl. non-account operators named at capture) | No — but legally retained (see §4) |
| `faults` | `reported_by` / free-text `reporter_name`, optional `lat`/`lng` at report time | Reporter | Location is low-sensitivity, permission-gated |
| `meter_readings`, `job_cards`, `cost_entries`, `attachments`, `notifications` | `by_user` / `mechanic_user_id` / `approved_by` / `created_by` / `user_id` (who did what) | The acting user | No |
| `attachments` (photos/voice/docs in private Storage) | May **incidentally** contain faces, number plates, or a voice note | Whoever appears/speaks | Treat as possibly identifying |
| `audit_log` | `user_id`, `entity`, before/after `diff` | The acting user | Internal integrity record (see §4.4) |
| `audit_log` **(location)** | `ip`, `geo_country`, `geo_region`, `geo_city`, `user_agent` | The acting user | Attributing a change to a place and a device, for dispute resolution and detecting account misuse — see §5.2 |
| `partners`, `workshops` | Contractor `phone`/`whatsapp`/`email`/`area`/`contact` | Contractors | No (business contact data) |
| **Error reports** (NFR-6) — *transmitted, never stored by us* | Stack trace, route path, and the acting user's and farm's **opaque uuids**. Deliberately never: name, email, phone, row content, or query strings. | The acting user | No — see §5.1 |

**Not collected (Scope §13 — hard out of scope):** GPS/telemetry tracking, biometric
identifiers, ID/passport numbers, banking/card data (billing is deferred; when it lands
it runs through Paystack — card data never touches our servers), and any
crop/livestock/labour records.

---

## 2. Purpose & lawful basis (POPIA §11)

| Purpose | Personal info used | Lawful basis |
|---|---|---|
| Provide the service (accounts, invites, RBAC) | `users`, `auth.users` | Contract / consent |
| Assign work & accountability (who logged/serviced what) | actor ids across tables | Legitimate interest of the farm |
| **AARTO driver nomination** (who drove vehicle X on date D) | `usage_logs` | **Legal obligation** (AARTO Act) |
| Reminders & alerts (service-due, expiry, fuel anomaly) | `users` contact + prefs | Consent / legitimate interest |
| WhatsApp messaging *(deferred)* | `phone`, `whatsapp_opt_in` | **Explicit opt-in consent**, timestamped |
| Optional cross-border AI for unresolved voice intent *(implemented; production enablement pending)* | difficult transcript text, locale and current date | **Explicit consent + a signed DPA** (see §5) |
| Security, audit & dispute resolution | `audit_log` | Legal obligation / legitimate interest |
| **Where a change came from** (FR-1.4) | `audit_log.ip` + coarse geo + user agent | **Legitimate interest** (§11(1)(f)) in answering "who approved this, and was that really them". The interest is the data subject's too: the owner disputing a change and the employee wrongly accused both need it. See §5.2 for the minimisation that balances it. |

Data minimisation: we ask only for what a farm-machinery manager needs. Money is stored
as integer cents ex-VAT; no card/bank details are held.

---

## 3. Data-subject rights & how we implement them

POPIA gives data subjects the rights of **access**, **correction**, and **deletion**.

### 3.1 Access (Data Subject Access Request)
A farm owner/manager (or rr_admin) can **export everything we hold on a person** as a
JSON file from **Team → per-person → Export data**. Backed by the guarded RPC
`public.export_personal_data(uuid)` (migration `0350`), which returns the profile plus
every record the person authored or is the subject of (usage logs, meter readings,
faults reported, job cards, cost entries, attachments, notifications, and their audit
actions). Download route: `GET /team/export?user=<id>`.

### 3.2 Correction
Profile fields (name, email, phone, language, notification prefs) are editable in-app by
the person and by their farm owner/manager (Team + Alerts → Preferences). Structural
history is immutable by design (append-only audit + job-card lock); corrections are made
by adding new records, preserving the trail.

### 3.3 Deletion / erasure (done as **anonymisation**)
**Team → per-person → Erase personal data** anonymises a person on request. Backed by
`public.erase_personal_data(uuid, text)` (migration `0350`):

- clears the directly-identifying fields in `users` — `name` → `[erased]`, `email` →
  null, `phone` → null, `whatsapp_opt_in` → false;
- **deactivates** the account (`active = false`) and **soft-deletes** it
  (`deleted_at`/`deleted_by`), so it can never sign in again;
- nulls the free-text **name copies** elsewhere (`usage_logs.driver_name`,
  `faults.reporter_name`);
- the server action additionally scrubs the residual email in `auth.users` and bans
  re-login;
- writes a `data_subject_erasure` entry to `audit_log` as proof of the erasure.

**Why anonymise rather than hard-delete.** `users.id` is referenced (ON DELETE RESTRICT)
by maintenance, cost, and AARTO records. A hard `DELETE` would either fail or destroy the
farm's operational and legally-required history. POPIA §14 permits **de-identification**
as the means of giving effect to erasure, and permits **retention where another law
requires it**. We therefore anonymise the identity in place and keep the now-de-identified
structural history. The `id`, once anonymised, resolves only to `[erased]`.

**Access control.** Both RPCs are `SECURITY DEFINER` with a single guard: rr_admin (any
person, cross-tenant, **logged**) **or** an owner/manager of the *subject's own farm*.
Execute is **revoked from `anon`** and the internal guard `app.assert_can_manage_person`
is revoked from `public`/`anon`/`authenticated`. A user cannot erase their own account
through the RPC (prevents self-lockout of the last owner). These properties are proven in
`supabase/tests/rls_isolation.sql` (F8 section): anon-deny, farm-scoping (cross-farm
raises), rr_admin cross-tenant + logging, and post-erase anonymisation.

---

## 4. Retention & deletion policy

Default principle: **keep personal information only as long as the purpose or a law
requires**, then de-identify.

| Data category | Retention | On erasure request |
|---|---|---|
| Account profile (`users`, `auth.users`) | Life of the account | Anonymised + deactivated immediately (§3.3) |
| **AARTO driver-usage logs** (`usage_logs`) | **Retained under legal obligation** (traffic-fine nomination windows); the *identity link* is de-identified on erasure, the event is kept | `driver_name` nulled; row kept, de-identified via the anonymised `users` row |
| Maintenance / fault / cost / fuel history | Life of the asset + reasonable dispute/warranty/tax window | Kept, de-identified (actor id points at `[erased]`) |
| Attachments (photos/voice/docs) | Life of the parent record | Parent soft-delete cascades; a specific media item can be soft-deleted on request |
| Notifications | Rolling operational window | User's queue de-identified with the account |
| Voice transcripts / assistant proposals | Operational support and dispute window; private to the subject | Text and tool payloads scrubbed, records soft-deleted |
| Offline raw voice audio (device IndexedDB only) | Until explicit transcription/discard, sign-out, or seven days at the latest | Cleared from that browser; never stored in FleetWise Postgres/Storage |
| **`audit_log`** | Retained for integrity/legal-obligation | **Kept** — see §4.4 |
| Backups (Supabase PITR) | Rolling window (see [`BACKUP.md`](BACKUP.md)) | Anonymisation propagates as the window rolls forward; documented exception below |

### 4.4 The audit-log exception (documented choice)
`audit_log` is **append-only** and records the before/after `diff` of every change,
including the erasure itself (which by definition captures the old identifying values in
its `diff`). We **retain** the audit log because:
- it is our integrity and dispute-resolution record (a legitimate-interest / legal
  basis), and POPIA §14 allows retention for such purposes;
- it is strictly access-controlled — farm-scoped RLS, **zero `anon` access**, no client
  write path — so the residual identifiers are not exposed.

This is the deliberate, documented boundary of "erasure": the *operational* surfaces are
fully de-identified; the *tamper-evident audit trail* is preserved. If a regulator or a
specific legal instruction requires purging audit diffs for an individual, that is a
manual, logged super-admin operation performed against the database directly.

### 4.5 Backups
Point-in-time-recovery snapshots necessarily contain pre-erasure values until the
retention window rolls past the erasure date. This is standard and acceptable under
POPIA; restores are rare, controlled, and re-application of the erasure is part of the
post-restore checklist in [`BACKUP.md`](BACKUP.md).

---

## 5. Cross-border processing (founder decision)

Per `docs/FLEETWISE_FOUNDER_DECISIONS.md` (#2): **cross-border AI processing is permitted
with (a) explicit user consent and (b) a signed Data Processing Agreement (DPA) with each
processor.** Voice AI now uses two deliberately separate paths:

- Azure Speech STT/TTS runs against the dedicated **South Africa North** resource. The
  browser receives a short-lived token; the Azure master key never leaves the server.
- Deterministic Afrikaans/English parsing stays inside FleetWise. Only when it cannot
  resolve a transcript may the optional Vercel AI Gateway/model path run. The database
  must first stamp active, unwithdrawn `voice-ai-v1` consent on a private interaction
  row. Users can withdraw that consent; Azure Speech and deterministic parsing continue
  to work without it.

The raw live recording is not retained by FleetWise. When offline, raw audio remains in
that signed-in farm context's browser IndexedDB, is uploaded to Azure only after an
explicit user action, and expires after seven days. FleetWise stores the transcript,
interpretation metadata and confirmed result for audit/support, under private per-user
RLS; its audit trigger deliberately excludes transcript, prompt, response, tool arguments
and provider error detail so erasure can actually remove that content. Before enabling
the optional LLM in production, record DPAs for Vercel Gateway and the selected underlying
model provider and include them in the processor register.

---

## 5.1 Error reporting (NFR-6)

**Off unless configured.** With `SENTRY_DSN` unset — the default — nothing leaves the server
and errors go to the application log, which is a sub-processor question already covered by
the hosting arrangement rather than a new one.

When a DSN is set, an error report crosses to that provider. What it carries is deliberately
minimal, and the reasoning is worth stating because the temptation runs the other way:

- **Opaque identifiers only.** The acting user's uuid and their farm's uuid, which is what
  answers "is this one farm's outage or everybody's". No name, email, phone or row content.
- **Query strings are dropped.** Not merely unused — removed before the report is built.
  This codebase has put a login credential in a query string before (the contractor
  `action_link`, since fixed), and an error reporter must not become the thing that
  exfiltrates the next one.
- **The reported identity is never trusted.** The browser-facing endpoint accepts anonymous
  reports by design, because the errors most worth seeing are on signed-out screens; what
  lands in the report is what the server knows, not what the caller claimed.

Because a report can leave South Africa depending on the DSN, the §5 rule applies: a DPA with
the provider is required before enabling it in production, and the choice of region should be
made at that point.

---

## 5.2 Where a change came from (FR-1.4, migration `0510`)

`audit_log` records who and when. It now also records, on authenticated writes, the request
IP, a coarse country/region/city derived from it by the hosting edge, and the user agent.

### Minimisation — what is collected, and what deliberately is not

POPIA §10 is the reason this is a short list.

**Collected:** request IP (`x-forwarded-for`, first hop); coarse geo derived from it by the
edge — country, region, city; user agent, capped at 300 characters.

**Deliberately not collected:**

- **Browser geolocation (GPS).** This is an audit trail, not a tracker. Asking a driver's
  phone for coordinates to record that they saved a meter reading fails minimisation before
  it fails anything else, and would need a consent this product has no reason to ask for.
- **Latitude and longitude**, though the edge offers them. City is the coarsest granularity
  that still answers the question a human is actually asking — *was that from the farm office
  or from somewhere nobody recognises?* Coordinates answer a different question.
- **Anything on the public QR flow.** That path is anonymous and writes through service-role
  routes; it is not an authenticated action and has no `auth.uid()` to attribute anything to.

### Accuracy — this is a signal, not evidence

This governs how the data may be used, so it is stated rather than assumed.

> Every one of these values is **supplied by the requesting client and can be forged**. The
> product stores them beside a correctly-attributed action and never acts on them: no access
> decision, no visibility rule and no notification reads them — asserted structurally in
> `supabase/tests/rls_isolation.sql`, section G33, against both `pg_policies` and function
> bodies. The identity itself still comes from `auth.uid()`. A wrong city beside a correct
> name is the worst a forged value can produce.
>
> They must therefore **never be the sole basis for a disciplinary or legal conclusion**, and
> a data subject disputing one should be told what it is: an approximation from an IP
> address, not a record of where a person was.

### Retention, access and erasure

Retention is `audit_log`'s, unchanged — the documented audit-log exception in §4.4. No
separate rule and no separate deletion path.

A DSAR bundle discloses these fields automatically, because `public.export_personal_data`
already returns the subject's `audit_log` actions and those rows now carry location. That is
correct: it is the subject's own data and they are entitled to see what was recorded about
where they were believed to be. No change to the RPC was needed or made.

**Erasure clears the location columns.** Founder decision, August 2026, implemented in
migration `20260829130000`. `public.erase_personal_data` nulls `ip`, `geo_country`,
`geo_region`, `geo_city` and `user_agent` on the **subject's own** audit rows.

The reasoning, because the §4.4 exception pulls the other way and someone will ask: that
exception exists to protect the **integrity record** — the diff, the entity, the timestamp,
the actor link — and a legal-retention argument rests on those. None of them needs an IP
address. An IP is simultaneously the most identifying field in the row and the least
load-bearing, so on an explicit erasure request it is exactly the field that should go. The
action itself stays correctly attributed, to a now-anonymised actor.

Only the subject's own rows. An audit entry recording somebody *else* acting — against this
person or otherwise — carries that other person's location, which is not the subject's to
erase. The count is reported in the `data_subject_erasure` compliance entry and in the RPC's
return value, so an operator can show what was cleared. Proven in `rls_isolation.sql` §G34,
including that erasing one person leaves another person's location intact and that the audit
diff itself survives.

---

## 6. Security & breach

Security controls (RLS as the default tenant-isolation boundary, explicitly guarded
atomic RPCs, encryption in transit/at rest, hashed credentials, service-role key
handling, the zero-anon-DB public QR path) are documented in
[`SECURITY.md`](SECURITY.md). **Breach notification:** on a
confirmed compromise of personal information we notify the Information Regulator and
affected data subjects as soon as reasonably possible (POPIA §22); `audit_log` and
Supabase logs support scoping the incident.

---

## 7. Operational checklist (must verify in the live project)

- [ ] Confirm the hosting edge geo headers are reaching the database (the columns are
      null, not wrong, when they are not).
- [ ] Confirm nobody has built a report, alert or access rule that reads `audit_log.ip`
      or the geo columns. G33 asserts the database side; this is the application-side
      half of the same promise.
- [ ] Decide the erasure question in §5.2 (scrub `ip`/`user_agent` on erasure, or keep
      the §4.4 audit-log exception as it stands).

- [ ] Supabase Auth: enable **leaked-password protection** (HaveIBeenPwned) — see `SECURITY.md`.
- [ ] Confirm all Storage buckets are **private** (they are, by migration `0200`) and only served via signed URLs.
- [ ] Keep a signed **DPA with Supabase** on file; before production Voice AI, add Azure,
      Vercel AI Gateway and the selected model provider to the processor/DPA register.
- [ ] Confirm the Voice AI consent wording/version (`voice-ai-v1`), withdrawal path,
      seven-day offline-audio expiry and data-subject export/erasure flow on real devices.
- [ ] Publish a customer-facing **privacy notice** (purposes, rights, contact) derived from §1–§5.
- [ ] Nominate an **Information Officer** (POPIA §55) and register with the Regulator.
- [ ] Run a periodic **erasure/restore drill** and re-apply outstanding erasures after any restore (`BACKUP.md`).
