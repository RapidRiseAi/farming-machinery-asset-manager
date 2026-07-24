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
| `partners`, `workshops` | Contractor `phone`/`whatsapp`/`email`/`area`/`contact` | Contractors | No (business contact data) |

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
| Cross-border AI (voice intent / RAG) *(deferred)* | transcript text, asset names | **Explicit consent + a signed DPA** (see §5) |
| Security, audit & dispute resolution | `audit_log` | Legal obligation / legitimate interest |

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
processor.** This applies only to the **deferred** Voice-AI / RAG features (LLM
intent-parsing may run in any region behind the adapter). Azure Speech runs in **South
Africa North** regardless. When those features ship, per-user consent is captured with a
timestamp (reusing the `whatsapp_opt_in`-style opt-in pattern) and the DPA is kept on
file. **No personal information leaves South Africa today** — the base product (Supabase
project + Storage) is single-region and no AI processor is wired.

---

## 6. Security & breach

Security controls (RLS as the sole tenant-isolation guarantor, encryption in
transit/at rest, hashed credentials, service-role key handling, the zero-anon-DB public
QR path) are documented in [`SECURITY.md`](SECURITY.md). **Breach notification:** on a
confirmed compromise of personal information we notify the Information Regulator and
affected data subjects as soon as reasonably possible (POPIA §22); `audit_log` and
Supabase logs support scoping the incident.

---

## 7. Operational checklist (must verify in the live project)

- [ ] Supabase Auth: enable **leaked-password protection** (HaveIBeenPwned) — see `SECURITY.md`.
- [ ] Confirm all Storage buckets are **private** (they are, by migration `0200`) and only served via signed URLs.
- [ ] Keep a signed **DPA with Supabase** (sub-processor) on file; add one per AI/WhatsApp processor before enabling those deferred features.
- [ ] Publish a customer-facing **privacy notice** (purposes, rights, contact) derived from §1–§5.
- [ ] Nominate an **Information Officer** (POPIA §55) and register with the Regulator.
- [ ] Run a periodic **erasure/restore drill** and re-apply outstanding erasures after any restore (`BACKUP.md`).
