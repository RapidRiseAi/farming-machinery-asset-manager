# FleetWise — Security posture

**Status:** F8 (NFR-2). This document records FleetWise's security model: what is
**inherited** from the platform (Supabase/Postgres/Vercel), what is **configured** by us
in code and migrations, and what must be **verified** in the live project. Companion
docs: [`POPIA.md`](POPIA.md) and [`BACKUP.md`](BACKUP.md).

---

## 1. Tenant isolation — Row-Level Security is the default guarantor

Multi-tenant isolation (farm-to-farm and external-workshop) is enforced by Postgres
Row-Level Security, not by application filtering. This is the product's foundational ground
rule, and it holds for every request carrying a user session.

There are exactly **two** deliberate exceptions, both documented rather than discovered:

1. The narrow `SECURITY DEFINER` RPCs described below. Because their owner can bypass RLS,
   each one repeats tenant, user, role and record-visibility checks inside the same database
   transaction.
2. The **public API** (`/api/v1`), where the caller holds a token rather than a user session,
   so there is no `auth.uid()` for a policy to judge. It is guarded by a single application
   chokepoint instead — see §5b, which states plainly what that does and does not buy.

If you are adding a third, it needs to be argued for here first.

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

## 5b. The public API — the one path RLS does not judge

This section exists because §1 says row-level security is the sole guarantor, and the public
API (`/api/v1`, migration `0508`) is a deliberate, single exception. It is documented here
rather than left to be discovered.

**Why there is an exception.** RLS decides using `auth.uid()`. An API token is not a Supabase
user session, so there is no `auth.uid()` for a policy to judge, and a token holder cannot be
made to look like one without handing the request a way to choose an identity. That approach
was explicitly rejected: `public._f14_probe`, removed from production by migration `0440`,
did exactly that — it let a caller rewrite `request.jwt.claims`, which is the more dangerous
shape precisely because every policy still passes while answering for somebody else. G11 now
asserts that nothing outside the test harness may rewrite those claims.

**What guards it instead.** A single chokepoint in `src/lib/api-tokens.ts`:

- The **credential derives the farm.** No public route accepts a farm id in any form — path,
  query or body — so there is no parameter to tamper with.
- Every service-role query goes through `apiSelect`, which applies the farm and soft-delete
  predicates **before** a route can add its own narrower filters. A route can restrict what it
  reads; it cannot widen it, and it cannot remove those predicates.
- The exposed surface is a **closed resource map** with deliberately small projections, so a
  new table is not reachable by default and adding one is a visible edit.
- Tokens are stored **hashed**; the plaintext is shown once at creation and never again. A
  short prefix is kept so a farm can tell two tokens apart.
- Reachability is gated on the `api_access` entitlement, and routes answer **403** rather than
  redirecting — a 302 to HTML hands an API client a body full of markup.

**The honest limitation.** This path is application-enforced, not policy-enforced. Its
correctness rests on every route going through the chokepoint rather than on the database
refusing. That is why the resource map is closed, why the assertions in
`supabase/tests/public_api_and_qr.sql` test cross-farm reads directly, and why a reviewer
should treat any new query in `src/app/api/v1/**` that does not call `apiSelect` as a defect.

## 5c. Per-user permission grants

Migration `0507` lets a farm grant a named permission to one person on top of their role.
Two properties matter for this document:

- The grants are enforced **in RLS**, as additional permissive policies (suffixed `_perm` so a
  later `create or replace` of a base policy cannot silently take them with it), not in the
  UI. A screen that forgets to check is therefore not a hole.
- They are **additive only**. A grant can widen what one person sees; it can never narrow it,
  and with no grant rows present every persona sees exactly what their role gave them before
  `0507` existed.

A user cannot grant themselves anything, and the grant policies are farm-scoped like every
other table. Note also the invariant on `partners`: rows with `farm_id is null` are the
RR-curated global suggestions, and no farm-level grant may reach them.

**Who may administer a grant is no longer `0507`'s rule.**
`20260820180000_selected_farm_administration.sql` drops and recreates `upg_sel/ins/upd/del`,
replacing `has_farm_access` + the caller's *primary*-farm role with
`app.effective_farm_role(auth.uid(), farm_id)` — the caller's role **on that farm**. It is a
tightening: someone who owns their home farm but is only an operator on a second farm can no
longer administer grants there. The twenty `_perm` policies themselves are untouched, which
is exactly what the `_perm` suffix was for. Read that migration, not `0507`, for the write
rules.

One consequence worth knowing: `upg_sel` no longer hides revoked (soft-deleted) rows from
administrators — only from the grantee. That is deliberate, and `toggleUserPermission` relies
on it to reopen the existing unique row rather than collide with it.

**Defence in depth, deliberately.** Two guards are doubled and a future "remove the redundant
clause" tidy-up would be removing one of two locks: `users.active` is checked in both
`app.is_farm_side()` and `app.has_farm_access()`, and the global-partner exclusion is enforced
both as `farm_id is not null` in the policy and as a null check inside `app.has_permission`.
G30 mutation-tests both pairs; breaking either lock alone changes nothing, which is the point.

**The contractor guard is local, deliberately doubled.** The eleven `_perm` SELECT policies
each call `app.is_farm_side()` directly, as well as reaching it through `app.has_permission`
(migration `20260829130100`). Before that, one remote guard inside one function carried the
whole F16 model for eleven tables that never mentioned it — so someone widening
`is_farm_side` for an unrelated reason had no local signal that eleven contractor boundaries
moved with it.

It changed no visibility, and that is asserted rather than assumed: `app.has_permission`
already returned false for a workshop user, so the added clause is a no-op today. G34 pins
it from both sides — the policies must still gate on the permission (not merely on being
farm-side), a granted *operator* must still gain the wider fleet, and a contractor holding
the same grant must still see nothing. Measured on production across the change: owner
15/54/7/5, operator 1/5/1/1, contractor 4/0/3/4 — identical cell for cell.

This joins the two guards `0507` already doubles: `users.active` is checked in both
`app.is_farm_side()` and `app.has_farm_access()`, and the global `partners` rows are excluded
both by `farm_id is not null` in the policy and by a null check inside `app.has_permission`.
**A future "remove the redundant clause" tidy-up would be removing one of two locks in each
case** — G30 and G34 mutation-test all three pairs, and breaking either lock alone changes
nothing, which is the point.

## 5d. Error reporting (NFR-6)

Errors are reported by speaking Sentry's ingest protocol over `fetch` (`src/lib/observability.ts`),
not by installing the SDK. Security-relevant properties:

- **Env-gated.** With `SENTRY_DSN` unset nothing leaves the server; errors go to the log.
- **Identifiers only.** A report carries the user id and farm id as opaque uuids — enough to
  tell one farm's outage from a general one — and never a name, email, phone number or row
  content.
- **Query strings are dropped**, deliberately. This codebase has put a login credential in a
  query string before (the contractor `action_link`, fixed in the backend/security pass), and
  an error reporter must not become the thing that exfiltrates the next one.
- The browser-facing endpoint `/api/observability` is **unauthenticated by design**, because
  the errors most worth seeing happen on signed-out screens (login, the public QR page, the
  customer document link). It is built for anyone to post to it: every field is length-capped,
  nothing is written to Postgres, and the reported identity is never trusted — what lands in
  the report is what the server knows, not what the caller claimed.

---

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

### Voice assistant boundary

- The Azure Speech master key is server-only. The browser receives a short-lived Speech
  token from `/api/assistant/speech-token` only after same-origin, active-user,
  selected-farm role, plan-entitlement and rate-limit checks. The response is private
  and non-cacheable; the master key is never returned or logged.
- Recognition runs against Azure Speech in `southafricanorth`. Raw microphone audio is
  not stored by FleetWise or sent to the optional LLM. An offline recording stays in
  device IndexedDB until the user explicitly transcribes or discards it, expires after
  seven days, and is cleared when that person signs out.
- Deterministic local parsing is attempted first. Only difficult **transcript text** may
  use Vercel AI Gateway, and only after the database has atomically verified and stamped
  the person's current `voice-ai-v1` consent. Withdrawing consent prevents every new
  model assignment; past evidence remains immutable until the associated personal data
  is erased under the POPIA workflow.
- The model cannot write operational data. It can only populate a private server-held
  proposal. The browser receives human-readable facts plus a proposal ID and must show a
  confirmation card. `apply_assistant_proposal(id, action)` locks that proposal and, in
  one transaction, rechecks its owner, selected farm, effective per-farm role,
  entitlement, expiry, machine visibility and exact JSON schema before applying or
  rejecting it. It accepts no browser-supplied farm, user, machine or tool arguments.
- `voice_captures` and `ai_interactions` are private to their subject and browser-write
  grants are revoked. Their audit trigger deliberately redacts transcripts, prompts,
  replies, tool arguments, audio paths and provider error detail so POPIA erasure does
  not leave another append-only copy.

## 8. Must verify / configure in the live Supabase + Vercel project

- [ ] **Auth → leaked-password protection (HaveIBeenPwned): ENABLE.** The only open item
      flagged by Supabase security advisors historically. Blocks known-breached passwords.
- [ ] Confirm **RLS is enabled + forced on every table** in the live DB (advisors will
      flag any table without RLS). Re-run `pnpm db:test` semantics against prod schema.
- [ ] Rotate and store `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, and VAPID keys as
      encrypted env vars in Vercel/Supabase; never in the repo or client bundle.
- [ ] Set `CRON_SECRET` so `/api/cron/nightly` authenticates (see `docs/CRON.md`).
- [ ] Keep `AZURE_SPEECH_KEY`, `VERCEL_OIDC_TOKEN` / AI Gateway credentials and all
      provider secrets server-only. Verify a production Speech resource and application
      request limits before the pilot; never add these values with a `NEXT_PUBLIC_`
      prefix.
- [ ] Restrict database network access / use the pooler; keep Postgres non-public where
      possible.
- [ ] Set `SENTRY_DSN` to switch error reporting on. The reporting layer itself is built and
      tested (§5d); with no DSN it falls through to the server log, so this is a configuration
      step, not outstanding work.
- [ ] Keep Supabase, Next.js, and dependencies patched; run `pnpm audit` in CI.
- [ ] Confirm all Storage buckets remain **private** (migration `0200`); serve via signed
      URLs only.

## 9. Known limitations (tracked)

- Assistant turns have an atomic per-user database limit and Speech-token requests have
  a bounded per-instance limit. A product-wide distributed WAF/rate-limit policy beyond
  Vercel/Supabase defaults is not yet custom-built.
- "From where" (IP/device) is not yet on the audit trail (FR-1.4 partial).
- The **public API is application-enforced, not policy-enforced** (§5b). Its correctness
  rests on every route going through `apiSelect` rather than on the database refusing. Treat
  any query under `src/app/api/v1/**` that bypasses the chokepoint as a defect.
- Formal load/pen-test not yet performed (NFR-1/§24 production-readiness gate).
