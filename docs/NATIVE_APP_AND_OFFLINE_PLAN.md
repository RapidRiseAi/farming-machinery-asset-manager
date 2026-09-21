# FleetWise as an installable app that works offline, options and a plan

**Date:** 19 September 2026. **Status:** research and recommendation. Nothing here is built.

**The ask:** a downloadable app with an installation wizard, that works better offline and
syncs reliably when the connection comes back.

**This is a scope change.** `SCOPE.md` §7 says "no app-store builds in v1" and "full offline
mode is explicitly out of scope", and §13 lists store apps and full offline sync as a hard
no. The founder can change that. The decision should be recorded in
`FLEETWISE_FOUNDER_DECISIONS.md` and `SCOPE.md` before a build starts, or the next session
will refuse the work on the scope document's authority. `FLEETWISE_FOUNDER_DECISIONS.md`
#3 already anticipates "Native/Capacitor + on-device models" as a later phase.

---

## 1. What exists today

FleetWise is already an installable PWA with real offline capture. The foundation is sound
and should be extended, not replaced.

| Piece | Where | What it does |
|---|---|---|
| Manifest | `public/manifest.webmanifest` | Standalone display, icons including maskable. Installs to the home screen on Android and iOS, and as a desktop app from Chrome or Edge. |
| Service worker | `public/sw.js` (`fleetwise-v3`) | Network-first navigation with a cached fallback. The role's own pages are pre-warmed (`warm-routes.tsx`), and the cache is dropped when the user or farm changes. Also carries web push. |
| Offline write queue | `src/lib/offline/` | IndexedDB queue, bound to the account, for `log_reading`, `report_fault`, `add_job_line` and `complete_job`. |
| Sync endpoint | `src/app/api/sync/route.ts` | Replays each capture atomically and idempotently, with statuses `applied / duplicate / conflict`. A decreasing meter or a locked job card becomes a conflict, never a silent overwrite. |
| Recovery | `/queue` | Review, download or remove retained rejections and conflicts. |

**What does not work offline:**
- Anything not in those four mutation types, including fuel and pre-start checklists
  (`FEATURE_GAP_REVIEW_2026-09-19.md` §1.3).
- Any page not already cached. Cached pages are HTML snapshots from the last visit, not
  live data.
- Any form that posts a server action.

**Release gate 2** of the 11 September audit, a real Android and iPhone offline trial, has
still not been run.

---

## 2. The constraint that decides everything

The app is **server-rendered**: React Server Components read Supabase on the server, and
forms post server actions. A native app bundle is static files, and Next.js refuses to
export server actions statically ("Server Actions are not supported with static export").
So there are really **two separate projects**:

- **Distribution**: an installer or store listing. It can wrap the existing hosted app
  almost unchanged. It is cheap, but by itself it adds no offline ability. A wrapped app is
  exactly as offline-capable as the PWA inside it.
- **Offline-first**: the screens that must work without signal need their data on the
  device and must render from it. That is a client-side data layer. It is the expensive
  part, and it is the same work whichever wrapper is chosen.

Rebuilding every screen natively would double maintenance for no gain. Billing, reports,
accounting and settings are office work done with signal. Only the **field surfaces** need
offline: driver home, the machine page, QR capture, readings, faults, fuel, pre-start
checks, and a mechanic working a job card.

---

## 3. Options

### 3.1 Distribution: getting an installer or store listing

| Target | How | What the user gets | Notes |
|---|---|---|---|
| **Android, Play Store** | Trusted Web Activity via Bubblewrap / PWABuilder → `.aab` | A real Play Store app. It runs the PWA full-screen in Chrome, with offline exactly as the PWA. | The cheapest real "app". Needs Digital Asset Links on the domain. PWABuilder packages only from its web UI and its service had outages in 2026, so use Bubblewrap from CI instead. |
| **Windows, installer** | (a) **MSIX** via PWABuilder, through the Microsoft Store or sideloaded with App Installer. (b) **Tauri 2**, which bundles a classic **NSIS `setup.exe` wizard** or a **WiX `.msi`**, with an auto-updater plugin. | (a) A modern signed install. (b) The "Next → Next → Install" wizard asked for. | (b) is the literal wizard, but around the hosted web app it is mostly cosmetic unless paired with §3.2. Either way, buy a code-signing certificate or SmartScreen will warn every farmer. |
| **iPhone** | Safari → Add to Home Screen. Web push works for home-screen apps since iOS 16.4. | Near-app behaviour. | An App Store listing that only wraps the website risks rejection under Apple's minimum-functionality rule (4.2). Only pursue iOS native with Phase 3. |
| **macOS** | Chrome/Safari "install", or Tauri. |, | Low demand for a farm fleet tool. |

### 3.2 Offline-first: keeping field data on the device

| Approach | How reads work | How writes work | Fit for FleetWise |
|---|---|---|---|
| **A. Extend F2 with a "field pack"** (custom) | The device pulls the signed-in user's field data **through PostgREST with their own session**, so **RLS stays the only authorisation layer**, including the cost-masked projections. It is stored in IndexedDB (or SQLite under Capacitor). Delta sync uses `updated_at` cursors; soft delete (`deleted_at`) is already everywhere, so deletions sync for free. | The existing idempotent `/api/sync`, extended with more event types. | **Best fit.** It reuses proven code and keeps one source of authorisation (CLAUDE.md: "RLS is the *sole* guarantor"). The cost is building delta pulls per table. |
| **B. PowerSync** | Postgres logical replication → SQLite on the device, partitioned by **Sync Rules**. | The app uploads through its own backend, which can call the existing RPCs as the user. | Mature: JS Web, React Native, Flutter, Kotlin and Swift SDKs are GA. **Capacitor is beta and Tauri alpha.** The catch is that Sync Rules are a **second authorisation layer** to keep in step with RLS, role visibility and cost masking. That is exactly the "screen and engine disagree" risk CLAUDE.md warns about. A hosted service with its own pricing and data-residency questions (POPIA). |
| **C. Electric** | Read-path "shapes" streamed from Postgres. Authorisation is added by proxying shape requests through our own route. | None built in; our own API. | Workable, but still a second authorisation path. Electric announced it is joining Databricks (August 2026), so its roadmap is less certain. |
| **D. Wrapper only** | Whatever the PWA caches. | F2 as today. | Satisfies "downloadable", not "works offline". |

---

## 4. Recommendation

**Phase 0, decide and measure (a few days).**
Record the scope change. Run the audit's release-gate-2 trial on a mid-range Android and an
iPhone to find what actually fails in the field today. Agree the exact list of field
screens that must work offline.

**Phase 1, finish offline in the web app (≈ 2-3 weeks).**
This is where the reliability gain is, and every later phase reuses it.
- Add `log_fuel` and `submit_checklist` (and any other field capture) to the queue.
- Build the **field pack** (option A): a local read model of the user's machines, service
  lines, open faults, checklist templates and job cards. The field screens render from it
  when offline, and it stays fresh through `updated_at` delta pulls.
- Request persistent storage (`navigator.storage.persist()`) so Android does not evict
  it, and use Background Sync where the browser supports it.
- Keep offline writes as **events** (readings, draws, faults, checklist results), not edits
  of shared rows. Events do not conflict, and that is why F2's conflict rules are simple;
  keep it that way.
- Sync status visible on every field screen, as it is for the queue today.

**Phase 2, distribution (≈ 1 week plus store review).**
- **Play Store** listing via Bubblewrap (TWA), built in CI.
- **Windows**: MSIX through the Microsoft Store. If a classic setup wizard matters to the
  buyer, use a **Tauri 2 NSIS installer** with the updater plugin instead. Either way needs
  a code-signing certificate.
- **iPhone**: keep home-screen install, with the existing `/install` page as the guide.

**Phase 3, native field app, only if Phase 1 device tests show the browser is not enough.**
Triggers: storage eviction, no reliable background sync, or camera/voice limits. Then build
a **Capacitor** app of the field screens only, bundling the Phase-1 client and moving the
local store to SQLite. Adopt PowerSync's Capacitor SDK at that point **only if** it has
reached GA and its Sync Rules can be generated from, or tested against, the same visibility
rules as RLS. Otherwise keep option A. **≈ 4-8 weeks.** It brings native push, background
work and an App Store listing that passes review.

---

## 5. Things that must hold on every path

- **POPIA on the device.** The field pack is personal and farm data held on a phone.
  Clear it on sign-out, account switch and farm switch, as the service worker already does
  for cached pages. Never include cost columns a role cannot see: pull through the masked
  projections, not the raw tables.
- **One authorisation source.** Every read runs as the signed-in user, so RLS decides.
  Any sync engine that needs its own rules needs a test that pins them to RLS, on the model
  of `billedUnits` ↔ `billing_billable_units`.
- **Money is never last-writer-wins.** Costs, job-card totals and billing stay online-only
  or go through the locked, audited paths that already exist.
- **Idempotency on every write.** The existing retry key and `duplicate` status are what
  make an automatic retry safe on a dropped connection. Every new mutation type gets them.

---

## 6. Accounts and costs to set up (check current prices at purchase)

- Google Play developer account (one-off fee).
- Windows code-signing certificate (annual), and a Microsoft Store listing if MSIX goes
  through the Store.
- Apple Developer Program (annual). Only needed in Phase 3.
- PowerSync, only if chosen in Phase 3: hosted-plan pricing and data region.

---

## Sources

- Next.js static export limits: <https://nextjs.org/docs/app/guides/static-exports>,
  <https://github.com/vercel/next.js/discussions/67503>
- PowerSync + Supabase: <https://docs.powersync.com/integrations/supabase/guide>;
  SDK maturity: <https://docs.powersync.com/client-sdks/overview>
- Electric writes model: <https://electric-sql.com/docs/guides/writes>;
  comparison and the Databricks news:
  <https://kanopylabs.com/blog/electric-sql-vs-powersync-vs-livestore-local-first>
- PWABuilder Android packaging (TWA via Bubblewrap):
  <https://github.com/pwa-builder/pwabuilder-google-play>; 2026 packaging outage:
  <https://github.com/pwa-builder/PWABuilder/issues/5303>; CLI limits:
  <https://github.com/pwa-builder/pwabuilder/issues/5470>
- Tauri Windows installers and updater: <https://v2.tauri.app/distribute/windows-installer/>,
  <https://v2.tauri.app/plugin/updater/>
