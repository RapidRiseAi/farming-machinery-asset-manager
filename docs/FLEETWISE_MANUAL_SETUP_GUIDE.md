# FleetWise — Manual Setup & Operations Guide

Everything you need to do **by hand** to stand up FleetWise and test it end-to-end,
**except** provider activation/runtime verification for Voice AI, and the still-deferred WhatsApp and subscription-charging features —
those live in [`FLEETWISE_PROVIDER_SETUP_GUIDE.md`](FLEETWISE_PROVIDER_SETUP_GUIDE.md) and
are intentionally out of scope here. The entire base product works manually without them.

> **Reading order:** if you just want to click around, do §1 (create the DB), §2 (seed the
> demo accounts) and §3 (run the app), then log in with the credentials in §4. Everything
> after that is deploying it properly and running it day-to-day.

---

## What you'll need (all have free tiers — none are the "3 providers")

| Account | Why | Cost |
|---|---|---|
| **Supabase** | Postgres database + Auth + file storage | Free to start; **Pro (~$25/mo)** later for daily backups (see `BACKUP.md`) |
| **Vercel** | Hosts the web app | Free (Hobby) works; Pro for teams |
| **GitHub** | Source of the code Vercel deploys | Free |
| A machine with **Node 20+** and **pnpm** | Run migrations/seeds & local dev | Free |

You do **not** need Azure, Meta/WhatsApp, or Paystack for anything in this guide.

---

## 1. Create the database (Supabase)

1. **Create a project** at [supabase.com](https://supabase.com) → New project. Pick a region
   close to your users (e.g. `eu-west` / South Africa-adjacent). Save the database password.
2. **Apply the schema.** The schema is the ordered SQL files in `supabase/migrations/`
   (`0001_…` … `0371_…`). Two ways:
   - **Supabase CLI (recommended):** `supabase link --project-ref <ref>` then
     `supabase db push`. This applies every migration in order.
   - **By hand:** open the **SQL editor** in the Supabase dashboard and paste/run each file
     in `supabase/migrations/` **in filename order**, top to bottom. Don't skip any.
3. **Storage buckets.** The migrations create the app's private buckets (machine photos,
   fault photos/voice, job-card photos, fuel, checklist photos, etc.) and their access
   rules. Confirm under **Storage** that they exist after the migrations run. *(Optional
   cleanup: delete the unused `menu-media` bucket if present.)*
4. **Security advisors.** Dashboard → **Advisors**. Clear anything flagged. In
   **Authentication → Providers → Email**, turn **on** "Leaked password protection"
   (POPIA/NFR-2 hardening).

> **Already have an older FleetWise/FarmGear project?** It may be several migrations behind
> (early versions had no contractors, fuel, budgets, etc.). Bring it up to date by applying
> **only the migrations it's missing**, in order — or, if it holds nothing but demo data,
> the cleanest path is to **reset and re-apply all migrations** (`supabase db reset` on a
> local copy, or drop the `public` schema and re-run) then re-seed with §2. Do **not**
> re-run migrations that already applied; `create table` will error on ones that exist.

---

## 2. Seed the demo data + loginable accounts

Run these **in order** in the Supabase **SQL editor** (they use the privileged `postgres`
role, so they can create `auth.users` and bypass RLS):

1. **`supabase/seed/demo_farm.sql`** — creates the *Weltevrede Boerdery* demo farm: 12
   machines with real histories, fuel, service plans, faults, job cards, checklists,
   partners and two work requests. Idempotent (skips if already seeded).
2. **`supabase/seed/demo_accounts.sql`** — turns every demo user into a **real,
   password-loginable account**, adds **one contractor account per contractor type**, a
   **second farm** (Rooikoppies Plaas) for cross-farm testing, and extra work requests.
   Idempotent. **Every account's password is `FleetWise!demo1`.**

> `demo_accounts.sql` is **hosted-Supabase only** — it sets encrypted passwords and email
> identities that the local RLS test shim doesn't have. For local RLS testing use
> `pnpm db:test` / `pnpm db:seed` instead (those don't create loginable accounts).

---

## 3. Run the app

### Local (fastest for testing)
```bash
pnpm install
cp .env.example .env.local     # then fill in the values from §5
pnpm dev                       # http://localhost:3000
```
Point `.env.local` at the **same Supabase project** you seeded — login is handled by
Supabase Auth in the cloud, so local dev logs into the real demo accounts.

### Or deploy to Vercel — see §6.

---

## 4. Demo login credentials

All passwords: **`FleetWise!demo1`**. (Change or delete these before any real use.)

### Farmer-side — *Weltevrede Boerdery* (Complete plan → every feature unlocked)
| Role | Email | What to test |
|---|---|---|
| **Owner** | `danie@weltevrede.example` | Everything: dashboard, reports, inbox, settings, team, partners, admin-of-own-farm. Also has a 2nd farm → **site switcher**. |
| **Manager** | `piet@weltevrede.example` | Same as owner minus a few owner-only settings. |
| **Mechanic** | `johan@weltevrede.example` | Job cards, faults, service kits, parts, checklists. |
| **Operator** | `thabo@weltevrede.example` | **Per-role visibility** — sees only the *Groen John Deere* (the machine assigned to them). |
| **Operator** | `sipho@weltevrede.example` | Operator with no assigned machine (contrast). |

### Platform admin
| Role | Email | What to test |
|---|---|---|
| **RR admin** | `admin@fleetwise.dev` | `/admin/farms` — create farms, set plans/billing, usage stats, logged impersonation, global template/parts/partner libraries. |

### Contractors — one per type (each logs into the **aggregated contractor dashboard** `/contractor`)
| Type | Email | Notes |
|---|---|---|
| **Mechanic** | `tj@tjservice.example` | Linked to **both** farms → dashboard aggregates across Weltevrede + Rooikoppies. Plan: **pro** (client-analytics unlocked). |
| **Auto electrician** | `sparky@voltauto.example` | Has an open "alternator" request. |
| **Parts supplier** | `sales@agripartsdepot.example` | Has a **quoted** parts request; parts-catalogue shortcut. Plan: pro. |
| **Panel beater** | `info@panelworx.example` | Has a "quote" request (door dent). |
| **Tyre** | `fitment@karootyre.example` | Has an **in-progress** request. |
| **Towing** | `dispatch@bolandtow.example` | Recovery contractor. Plan: pro. |
| **Other / handyman** | `general@doall.example` | Generic contractor view. |

### Second farm — *Rooikoppies Plaas* (Professional plan)
| Role | Email | Notes |
|---|---|---|
| **Owner** | `hendrik@rooikoppies.example` | 3 vehicles; one request out to the TJ mechanic (cross-farm). |

**Suggested test flow:** log in as **Danie** → create a work request from a machine's
"Get something done" card to a contractor → log in as that **contractor** (`/contractor`)
→ view/quote it → back as **Danie** → the quote appears in `/inbox` "Needs your action" →
accept it. That exercises the whole farmer↔contractor loop.

---

## 5. Environment variables

Set these in **`.env.local`** (local) and in **Vercel → Project → Settings → Environment
Variables** (production). Full annotated list is in `.env.example`.

| Variable | Where to get it | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API | Public |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API | **Server-only secret.** Never expose to the browser. Powers public-QR routes + admin ops. |
| `NEXT_PUBLIC_APP_NAME` | You | `FleetWise` |
| `NEXT_PUBLIC_SITE_URL` | You | `http://localhost:3000` locally; your Vercel URL in prod. **QR codes encode this** — must be the public URL in prod. |
| `CRON_SECRET` | You (`openssl rand -hex 32`) | Guards the nightly cron route. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` / `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | `node scripts/gen-vapid-keys.mjs` (§7) | Web push. If unset, push just no-ops (in-app alerts still work). |

---

## 6. Deploy to Vercel

1. Push the repo to GitHub (already done if you're reading this in the repo).
2. Vercel → **New Project** → import the repo. Framework auto-detects **Next.js**.
3. Add **all** the env vars from §5 (Production + Preview).
4. Deploy. Then set `NEXT_PUBLIC_SITE_URL` to the assigned domain and **redeploy** so QR
   codes and magic links point at the live URL.

---

## 7. Web Push keys (VAPID) — no provider needed

```bash
node scripts/gen-vapid-keys.mjs
```
Copy the four printed values into `.env.local` **and** Vercel (§5). Redeploy. Then, in the
app, open the **alert centre** and toggle **push on** to subscribe a device. Nightly alerts
(service due, licence/warranty expiry, fuel anomalies, work-request reminders) will deliver
as push notifications in addition to in-app.

---

## 8. Supabase Auth configuration

Dashboard → **Authentication → URL Configuration**:
- **Site URL:** your Vercel domain (e.g. `https://fleetwise.vercel.app`).
- **Redirect URLs:** add both `https://<your-domain>/auth/callback` and
  `http://localhost:3000/auth/callback` so magic-link / invite / contractor login URLs work.
- Email provider is built in (password + magic link). Optionally customise the email
  templates under **Authentication → Templates**.

---

## 9. Nightly cron (alerts & reminders)

`vercel.json` already schedules `/api/cron/nightly` daily at 03:00 UTC. On Vercel:
1. Ensure `CRON_SECRET` is set (§5). Vercel Cron sends it as a Bearer token automatically.
2. Confirm the cron shows under **Project → Settings → Cron Jobs** after deploy.
3. To run it manually for testing:
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/nightly`

Full details in [`CRON.md`](CRON.md). The nightly job recomputes service-due, sends
due/overdue + licence/warranty expiry + fuel-anomaly + work-request-reminder notifications
(honouring each farm's quiet hours), and delivers queued web-push.

---

## 10. Post-deploy smoke test (10 minutes)

Log in as each and confirm:
- **Owner (Danie):** dashboard KPIs render; `/reports` shows data and **Download CSV /
  Excel** work; `/inbox` shows a quote "Needs your action"; the **site switcher** flips
  between Weltevrede and Rooikoppies.
- **Operator (Thabo):** the machines list shows **only** the Groen John Deere.
- **Contractor (TJ):** `/contractor` lists requests from **both** farms; open one, add a
  quote/invoice, upload a proof photo.
- **RR admin:** `/admin/farms` lists both farms with plan/billing controls.
- **Public QR:** open a machine → QR sheet → scan it (or open `/m/<token>`) → the anonymous
  "log a fault / log fuel" page loads with **no login** and can submit.

---

## 11. Day-to-day manual operations (with real, non-demo data)

Everything below is done **in the app**, no code:

- **Add your farm & vehicles:** RR admin creates the farm and sets its plan; the owner adds
  vehicles (`/machines/new`, incl. photo, finance, warranty, licences), or **bulk-imports**
  from CSV.
- **Invite your team:** `/team` → invite by email (owner/manager/mechanic/operator). They
  get an email invite; workers who only capture faults/fuel can use the **no-login QR page**.
- **Connect contractors:** `/partners` → add or adopt a suggested partner → **Connect**.
  FleetWise creates their login and hands you a **magic login URL** to send them (copy, or
  share via the WhatsApp/email buttons). They log straight into their contractor dashboard.
- **Print QR stickers:** each machine → **QR** → print → stick on the vehicle. Re-print via
  **Re-issue QR** if a sticker is lost/damaged (invalidates the old one).
- **Service plans, job cards, faults, fuel, checklists, work requests, budgets, fines** —
  all captured in-app; see the in-product flows and `SCOPE.md`.
- **Reports & exports:** `/reports` → filter by period/site → **CSV** (per family), **Excel**
  (one workbook, all families) or **print to PDF**.

---

## 12. Admin, security & POPIA (manual toggles)

- **RR admin console** (`/admin/farms`): create/suspend farms, set plan + billing period,
  see usage, curate global libraries (service templates, parts catalogue, suggested
  partners, checklist templates), and impersonate a farm (logged in the audit trail).
- **POPIA data-subject rights** (`/team`): per person, **Export data** (downloads a JSON
  bundle) and **Erase personal data** (anonymises, keeping legally-required records). See
  [`POPIA.md`](POPIA.md).
- **Security posture:** RLS is the sole tenant-isolation guarantor (proven by
  `supabase/tests/rls_isolation.sql`). Keep the **leaked-password protection** on, keep the
  **service-role key server-only**, and review [`SECURITY.md`](SECURITY.md).
- **Backups:** upgrade Supabase to **Pro** for daily backups + PITR; run the restore drill
  in [`BACKUP.md`](BACKUP.md).

---

## 13. Provider-controlled activation and deferred features

These are activated or tracked through [`FLEETWISE_PROVIDER_SETUP_GUIDE.md`](FLEETWISE_PROVIDER_SETUP_GUIDE.md):

| Feature | Provider | Status |
|---|---|---|
| **Voice AI** (Afrikaans/English speech capture/readback) | Azure AI Speech + optional Vercel AI Gateway | Implemented — migrations, deployment and real-device E2E/POPIA sign-off remain |
| **WhatsApp alerts & inbound** | Meta WhatsApp Cloud API | Deferred — in-app + push channels work now; `deliver_after` queue ready |
| **Card billing / charging** | Paystack (ZA) | Deferred — plans, tiers, asset-count & price display work; no charging |

Everything else in FleetWise works **fully, manually, today**.
