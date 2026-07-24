# FleetWise — Security posture

**Status:** F8 (NFR-2). This document records FleetWise's security model: what is
**inherited** from the platform (Supabase/Postgres/Vercel), what is **configured** by us
in code and migrations, and what must be **verified** in the live project. Companion
docs: [`POPIA.md`](POPIA.md) and [`BACKUP.md`](BACKUP.md).

---

## 1. Tenant isolation — Row-Level Security is the sole guarantor

Multi-tenant isolation (farm-to-farm and external-workshop) is enforced **only** by
Postgres Row-Level Security, never by application filtering. This is the product's
foundational ground rule.

- **Every business table** carries a `farm_id` and has RLS **enabled *and* forced**
  (`force row level security` — so even the table owner is subject to policy). Policies
  gate `select/insert/update/delete` on `app.has_farm_access(farm_id)`; reads also hide
  soft-deleted rows. See `0101_rls_policies.sql`.
- **Composite foreign keys** `(child_id, farm_id) → parent(id, farm_id)` make it
  structurally impossible for a child row to reference a parent in another farm.
- **Access helpers** live in schema `app` (`0100_rls_helpers.sql`), are `SECURITY
  DEFINER` (so they can read `users`/`workshop_links` without recursing through those
  tables' own RLS), and encode the whole model:
  - `is_rr_admin()` — FleetWise platform staff, cross-tenant (support; logged);
  - `user_farm_id()` / `has_farm_access(fid)` — a farm user reaches their own farm;
  - workshop staff reach a farm only via an **active** `workshop_links` row.
- **Proven by tests.** `supabase/tests/rls_isolation.sql` asserts, for **every** table:
  Farm A sees only Farm A; a workshop linked to A never sees B; revoking a link removes
  access; rr_admin sees across tenants; **anon sees nothing and cannot write**;
  cross-tenant writes are rejected. `pnpm db:test` runs the whole suite against a fresh
  Postgres and fails the build on any violation. Feature migrations each add their own
  section (F1–F13, and F8's data-subject-rights section).

> Do not "help" RLS with `.eq('farm_id', …)` in queries and assume that is the boundary —
> it is a convenience, not the guarantee. The guarantee is the policy.

## 2. Roles & least privilege (database grants)

Defined in `0102_grants.sql`:

- **`anon` → ZERO table/sequence access.** No policies, no grants. Every anonymous query
  is denied at the privilege layer *before* RLS is even consulted. The public QR flow
  (below) never uses `anon` against the DB.
- **`authenticated`** → DML on tables, but RLS then decides row visibility. `audit_log`
  is **read-only** to clients (insert/update/delete revoked) — it is written only by the
  `SECURITY DEFINER` audit trigger.
- **`service_role`** → full access, bypasses RLS. Used **only** in trusted server code
  (see §4).

`SECURITY DEFINER` functions follow a strict rule: `set search_path = public, pg_temp`,
then `revoke execute … from public, anon, authenticated` and grant only where needed
(e.g. a `public.cron_*` wrapper to `service_role`, or a guarded RPC to `authenticated`).
The F8 RPCs (`export_personal_data`, `erase_personal_data`) are granted to
`authenticated` but self-guard to owner/manager-of-that-farm or rr_admin; their internal
helper `app.assert_can_manage_person` is revoked from everyone (callable only from inside
the definers).

## 3. Encryption & credentials (inherited from Supabase/Postgres)

- **In transit:** all client↔Supabase and client↔Vercel traffic is **TLS 1.2+/HTTPS**.
  Postgres connections use SSL; serverless code uses the connection pooler over TLS.
- **At rest:** Supabase-managed Postgres storage and Storage buckets are encrypted at
  rest (AES-256) by the platform; daily backups/PITR snapshots are likewise encrypted.
- **Credentials:** authentication is Supabase Auth (GoTrue). **Passwords are salted +
  hashed with bcrypt** — plaintext passwords never reach our tables or logs. We also
  support magic-link (passwordless) sign-in and email invites. Session tokens are JWTs
  held in httpOnly cookies and refreshed by the session middleware.
- **App profile vs. identity:** `public.users` (app role/farm) is a separate row keyed to
  `auth.users.id`; deactivating (`active=false`) or soft-deleting a profile revokes app
  access even while the auth identity exists.

## 4. Service-role key handling (server-only)

- The service-role key is read from **`SUPABASE_SERVICE_ROLE_KEY`** — deliberately
  **without** a `NEXT_PUBLIC_` prefix, so Next.js can never bundle it into client code.
  `src/lib/env.ts` throws if it is requested and missing.
- `src/lib/supabase/service.ts` (`createServiceClient`) is the single construction point,
  documented "NEVER import into a client component," with `persistSession:false`.
- It is used only in trusted server routes/actions: the **public QR** service routes,
  media uploads, the **nightly cron**, Auth-admin operations (invites, the F8 erasure
  auth-scrub), and other server-side privileged work.
- The anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) is public by design and only ever grants
  what RLS + the `anon`/`authenticated` grants allow.

## 5. Public QR flow — zero anonymous DB access

Field workers use `/m/[token]` with **no login**. The QR encodes an unguessable
per-machine `public_token`. **No anonymous Postgres access exists** (see §2). Every public
submission (report fault, log reading, log service, log fuel) goes through a **service-role
server route/action that first validates the token**, then writes on the worker's behalf.
A leaked or guessed URL can only reach the one machine its token addresses, and only
through the narrow validated actions — never the database directly.

## 6. Auditability & integrity

- **Append-only `audit_log`** (trigger `app_audit`, `0008`) records `insert/update/delete`
  with a before/after `diff`, actor (`auth.uid()`), and `farm_id`, on every business
  table. Clients can read it (farm-scoped) but never write it.
- **Job cards lock after approval** — a trigger blocks any edit/delete of a locked card
  or its lines; later changes are expressed as new records + audit diffs.
- **Soft delete** (`deleted_at`/`deleted_by`) everywhere; reads hide soft-deleted rows.
- **rr_admin cross-tenant access is logged** (`log_admin_farm_access`, and the F8
  data-subject RPCs write `data_subject_export` / `data_subject_erasure` rows).

## 7. Application-layer hardening

- Server-side **authentication guards** (`requireUser`/`requireProfile`/`requireRole`)
  and **entitlement gating** (`requireEntitlement`, F5) enforce access **at the
  route/action**, not merely by hiding UI.
- Server Components by default; secrets never cross to the client; forms post to server
  actions.
- **Web Push** uses self-hosted VAPID (RFC 8291/8188) via Node crypto only — no third
  party (F6).

## 8. Must verify / configure in the live Supabase + Vercel project

- [ ] **Auth → leaked-password protection (HaveIBeenPwned): ENABLE.** The only open item
      flagged by Supabase security advisors historically. Blocks known-breached passwords.
- [ ] Confirm **RLS is enabled + forced on every table** in the live DB (advisors will
      flag any table without RLS). Re-run `pnpm db:test` semantics against prod schema.
- [ ] Rotate and store `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, and VAPID keys as
      encrypted env vars in Vercel/Supabase; never in the repo or client bundle.
- [ ] Set `CRON_SECRET` so `/api/cron/nightly` authenticates (see `docs/CRON.md`).
- [ ] Restrict database network access / use the pooler; keep Postgres non-public where
      possible.
- [ ] Enable **Sentry** (`SENTRY_DSN`) for error observability (NFR-6, in the setup guide).
- [ ] Keep Supabase, Next.js, and dependencies patched; run `pnpm audit` in CI.
- [ ] Confirm all Storage buckets remain **private** (migration `0200`); serve via signed
      URLs only.

## 9. Known limitations (tracked)

- Rate-limiting / WAF beyond Vercel/Supabase defaults is not custom-built.
- "From where" (IP/device) is not yet on the audit trail (FR-1.4 partial).
- Formal load/pen-test not yet performed (NFR-1/§24 production-readiness gate).
