# FleetWise — Backup, restore & uptime runbook

**Status:** F8 (NFR-4). How FleetWise's data is backed up, how to restore it, the uptime
target, and the restore-drill checklist. Companion docs: [`POPIA.md`](POPIA.md) and
[`SECURITY.md`](SECURITY.md). Infra prerequisites: `docs/FLEETWISE_PROVIDER_SETUP_GUIDE.md` §0.

---

## 1. What must be backed up

| Asset | Store | Backup mechanism |
|---|---|---|
| Application database (all tenant data, `auth.*`, `storage.*` metadata) | Supabase Postgres | **Supabase Pro daily backups + PITR** (§2) |
| Uploaded media (machine/fault/job-card/checklist photos, voice notes, docs) | Supabase **Storage** (private buckets) | Platform-replicated; see §2.3 |
| Schema / migrations | Git (`supabase/migrations/*.sql`) | Source control — the schema is fully reproducible from `0001…` |
| Secrets (service-role key, `CRON_SECRET`, VAPID keys, provider keys) | Vercel + Supabase env | **Not** in backups — recorded in the team password manager |

The migrations in Git are themselves a form of disaster recovery: a brand-new Postgres
can be rebuilt to the exact schema by replaying `supabase/migrations/` in order (this is
what `pnpm db:test` does every run).

## 2. Backup configuration (Supabase)

**Requires Supabase Pro** — the Free tier auto-pauses and has **no** daily backups.

### 2.1 Daily backups
- Project Settings → Database → **Backups**: confirm **daily** logical backups are on.
- Retention: 7 days on Pro (longer on higher tiers / add-ons). Record the actual
  retention here once set: **_retention: ___ days_**.

### 2.2 Point-in-Time Recovery (PITR) — recommended
- Enable **PITR** (add-on) for the production project. PITR lets you restore to **any
  second** within the retention window (typically 7 days), not just the last nightly.
- This is the primary control for "an owner erased/overwrote the wrong thing an hour ago."

### 2.3 Storage (uploaded media)
- Buckets are **private** (migration `0200`); objects are platform-managed and
  redundantly stored by Supabase. Storage is **not** covered by the Postgres PITR
  timeline — treat DB rows and their storage objects as separately recoverable.
- For extra safety on irreplaceable media, schedule a periodic **out-of-band copy** of the
  buckets (e.g. a monthly `supabase storage` export / S3-compatible sync) to a second
  location. Record where: **_offsite copy: ____________**.

### 2.4 Connection strings (for restore tooling / migrations)
- `DATABASE_URL` = pooler (transaction mode) — app/serverless.
- `DIRECT_URL` = direct connection — migrations and restores only.

## 3. Restore procedure (runbook)

> **Restores are destructive and rare.** Only an owner/operator with Supabase project
> admin runs this, and only after confirming the failure mode. Announce a maintenance
> window first (see uptime target §4).

### 3.1 Point-in-time restore (data loss / bad write)
1. **Freeze writes** if feasible (put the app in maintenance / pause the cron by rotating
   `CRON_SECRET`) to stop new data racing the restore.
2. Supabase Dashboard → Database → **Backups / PITR** → choose the **target timestamp**
   just *before* the incident.
3. Restore (Supabase provisions the recovered database). Confirm the restored project URL.
4. **Verify** (see §5 smoke checks) before reopening to users.
5. **Re-apply outstanding POPIA erasures** performed *after* the restore point — a PITR
   rewind un-does anonymisation done later. Cross-check `audit_log` for
   `data_subject_erasure` entries dated after the restore timestamp and re-run
   `erase_personal_data` for each (see [`POPIA.md`](POPIA.md) §4.5).
6. Announce recovery; record the incident (§6).

### 3.2 Full project loss (region/project failure)
1. Create a fresh Supabase project (same region — SA/EU as configured).
2. Replay schema: apply `supabase/migrations/*.sql` in order (or restore from a logical
   backup).
3. Restore data from the most recent daily backup / logical dump.
4. Re-create Storage buckets (migration `0200`) and restore media from the offsite copy
   (§2.3).
5. Repoint the app: update `NEXT_PUBLIC_SUPABASE_URL`, keys, `DATABASE_URL`/`DIRECT_URL`
   in Vercel; redeploy.
6. Verify (§5); re-enable cron (`CRON_SECRET`) and Web Push.

### 3.3 Schema-only rollback
A bad migration is rolled forward with a new **corrective migration** (we do not edit
shipped migrations). Only fall back to a data restore if the bad migration destroyed data.

## 4. Uptime target & availability

- **Target: 99.5% monthly availability** for the production app (≈ 3.6 h/month budget) —
  appropriate for a farm-ops SaaS on a single-region managed stack; revisit upward as the
  customer base grows.
- Built-in resilience: Vercel serverless (auto-scaled, multi-AZ) + Supabase managed
  Postgres. The **PWA + offline queue (F2)** means field capture keeps working through
  short outages and syncs on reconnect, softening user-visible downtime.
- **Planned maintenance** (e.g. a restore) is announced ahead and scheduled off-peak.
- Recovery objectives:
  - **RPO (max data loss): ≤ 24 h** with daily backups; **≈ seconds–minutes** with PITR.
  - **RTO (time to restore): ≤ 4 h** for a PITR restore; ≤ 1 business day for full project
    rebuild.

## 5. Post-restore smoke checks

- [ ] Login works (password + magic-link); a known owner reaches their dashboard.
- [ ] **RLS intact:** Farm A user sees only Farm A; anon is denied (spot-check the
      isolation invariants; `pnpm db:test` against a copy if in doubt).
- [ ] Latest expected rows are present (recent job card, reading, fuel issue).
- [ ] Storage: a signed URL for a known photo resolves.
- [ ] Money triggers correct (a job-card total recomputes); TCO renders.
- [ ] Cron route authenticates with the current `CRON_SECRET`.
- [ ] **Outstanding POPIA erasures re-applied** (§3.1 step 5).

## 6. Restore-drill checklist (run at least quarterly)

A backup you have never restored is a hope, not a backup. Schedule a drill:

- [ ] Pick a **non-production** target (a scratch Supabase project or branch).
- [ ] Restore the latest daily backup **and** a PITR point into it.
- [ ] Time the restore end-to-end; confirm **RTO** is within target (§4).
- [ ] Run the §5 smoke checks against the restored copy.
- [ ] Verify media restore from the offsite copy (§2.3).
- [ ] Confirm the erasure re-application step is understood and works (§3.1 step 5).
- [ ] Record: date, who ran it, restore duration, issues, and fixes. Update this doc.
- [ ] Tear down the scratch project.

**Drill log**

| Date | Ran by | Restore type | Duration (RTO) | Result / notes |
|---|---|---|---|---|
| _tbd_ | | | | first drill after Supabase Pro upgrade |

## 7. Must verify in the live project

- [ ] Supabase project is on **Pro**; **daily backups ON**; **PITR ON**; retention recorded (§2.1).
- [ ] Offsite Storage copy scheduled + location recorded (§2.3).
- [ ] Secrets recorded in the team password manager (not in backups).
- [ ] First **restore drill** completed and logged (§6).
- [ ] Uptime/error monitoring wired (Sentry / status checks — NFR-6).
