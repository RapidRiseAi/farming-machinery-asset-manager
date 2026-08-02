# Handoff: FleetWise UI/UX upgrade

## Overview

A complete UI/UX rebuild of the FleetWise farming machinery asset manager
(`RapidRiseAi/farming-machinery-asset-manager`). Twenty-two screens covering every
route in `src/app/(app)/` and all six account types — owner, farm manager, mechanic,
driver/operator, external contractor, and Rapid Rise staff — plus the token-gated public
QR flow that needs no login.

The goal set by the client: make the system usable by farmers and workers who are not
computer literate, on both phone and desktop, **without changing how the backend works**.

Two artefacts:

- `FleetWise Redesign.dc.html` — the designs. 22 screens, each with a desktop treatment,
  a mobile treatment, empty and populated states, and a per-screen audit column.
- `FleetWise UX Audit.dc.html` — the written report. 176 findings graded
  critical / serious / polish, six genuine code defects, and nine repeating patterns.

## About the design files

**These are design references created in HTML — prototypes showing intended look and
behaviour, not production code to copy.** They are Design Components (`.dc.html`) that
open in a browser; they use inline styles and a small runtime, neither of which belongs
in the target codebase.

The task is to **recreate these designs inside the existing Next.js application**, using
its established patterns: React Server Components, server actions, Tailwind CSS with the
tokens already defined in `tailwind.config.ts`, and the component set in
`src/components/ui/`. Do not port the HTML. Read it for layout, hierarchy, copy, spacing
and behaviour, then build the equivalent in Tailwind.

## Fidelity

**High fidelity.** Colours, typography, spacing, tap targets and copy are all final and
deliberate. Every colour is taken unchanged from the repo's own `tailwind.config.ts`.
Recreate faithfully.

The one intentional change to the visual system is typography: the app currently uses a
system font stack, which renders inconsistently across the mid-range Androids this runs
on. The designs use **Instrument Sans** with tabular figures so hour meters and Rand
amounts align in columns. Adopting it is a `next/font` change plus one line in the
Tailwind config. If you'd rather not, keep the system stack and enable
`font-variant-numeric: tabular-nums` on numeric cells — that is the part that matters.

---

## Build order

Do not build screen by screen. Most of the 176 findings are instances of nine patterns
that live in shared components. Fix the components and a large share of the audit
resolves everywhere at once.

### Phase 0 — the six code defects (do first, independent of any design work)

These are bugs, not opinions. Each is confirmable in minutes and two cause real harm today.

| # | File | Defect | Fix |
|---|---|---|---|
| 1 | `src/app/(app)/onboarding/page.tsx` | Step 1 and step 3 share the condition `done: machines > 0`, so "put QR stickers on" ticks itself when the first machine is added | Give step 3 its own condition — labels printed, or an explicit acknowledgement |
| 2 | `src/app/(auth)/login/**`, public QR pages | Every `t()` call is made without a locale, because language lives on the profile and no profile is loaded pre-auth. A bilingual product opens in English for every Afrikaans farm | Device-level locale (cookie or `Accept-Language`) for pre-auth pages, plus a visible toggle |
| 3 | `src/app/(app)/admin/farms/actions.ts` | `impersonateFarm` calls the audit RPC, redirects with `?entered=1`, and does nothing else. No farm context is set — staff believe they are inside a customer account when they are not | Either set a farm-context cookie and log an `exit` action, or rename the button to what it does |
| 4 | `src/app/(app)/inbox/**` | `acceptQuote` and `approveInvoice` commit real money from a `size="sm"` submit with no confirmation, millimetres from a link and three icon buttons | Confirmation sheet naming the amount and comparing quote to bill |
| 5 | machine detail, `src/app/(app)/team/**` | Machine delete fires directly from the button. POPIA `erasePerson` — permanent, bans the login — is a `variant="ghost" size="sm"` behind a browser `confirm()` | Confirm dialog stating what is lost; type-to-confirm for erasure |
| 6 | `src/app/(app)/machines/import/import-client.tsx` | Header failure renders `{t("machines.err.name_required")} — {t("machines.previewTitle")}`, producing "Name is required — Preview" | Its own message naming the columns that couldn't be found |

Separately, and worth a security review rather than a design one: `/partners` renders a
freshly-minted contractor login URL as copyable plain text on screen, where it stays until
the next navigation. See S17.

### Phase 1 — shared components (highest leverage; ~60% of the audit)

All in `src/components/ui/`.

1. **`badge.tsx` — status needs shape + word + colour.** The machines list currently
   renders all six machine statuses as `tone="neutral"`, so a broken machine and a working
   one are identical rows. The job-card list maps six statuses onto three tones, collapsing
   reported / open / in progress into one blue. Give every state its own colour *and* a
   shape cue *and* plain wording — the app is used in sunlight, by colour-blind users, on
   cracked screens. Fixes findings across machines, work, faults, contractor, inbox, fines.

2. **A real `ConfirmDialog`.** One component with: a plain-language question, a statement
   of what will be lost ("this also hides 7 job cards and 31 readings"), an optional
   type-to-confirm, and a clearly secondary escape. Retires every "no confirm" finding in
   the audit — there are fourteen.

3. **`field.tsx` / `input.tsx` — kill placeholder-as-label.** Ten inputs on the public QR
   page have no `<label>` at all; both login email boxes, the contractor money fields and
   the parts inline editor are placeholder-only. The question vanishes the moment the user
   types, which hurts exactly the users this product is for.

4. **`empty-state.tsx` — split it in two.** Empty is sometimes the *good* outcome (no
   faults, nothing in the inbox, bench clear) and sometimes an incomplete setup (no
   machines, no service plan). Those need opposite treatments: a green "you're all caught
   up" versus an encouraging first-run prompt with a ghost preview of the filled state.

5. **A formatting layer.** The database currently shows through in 21 places:
   `{current_reading} {meter_type}` printing "184320 km", `vat_rate_bps` asking a farmer
   for 1500, `<Badge className="capitalize">{u.role}</Badge>` rendering "Rr_admin",
   `updated_at.slice(0,10)` and `toLocaleDateString("en-ZA")` printing ISO dates. Build:
   thousands separators, unit words, relative dates ("2 days ago"), role labels, and a
   VAT display that speaks percent while the column keeps basis points.

6. **Filter chips replacing submit-to-filter forms.** Four screens (machines, work
   requests, parts, job cards) open with a card of dropdowns and a *Search* button that
   eats the first screen on a phone and does nothing until submitted. Chips apply on tap
   and write the same URL params the forms did — no server change.

7. **Buttons: 48px, verb-first, icon *and* word.** Never icon-only. One primary action per
   screen, matched to the real decision. Red reserved for destruction — not for "overdue".

### Phase 2 — the daily loop (five screens)

In order: **farm home → machines list → job card → owner inbox → QR/driver flow.**
These are what people touch every day. Each already resolves against Phase 1 components,
so the work here is layout and copy.

### Phase 3 — everything else

Machine detail, costs & reports, diesel, contractor portal, work list, fines, people,
settings, alerts, partners, add machine, import, daily checks, parts, checklist builder,
admin console, driver home, login, onboarding, RR template library.

---

## The nine repeating patterns

Read Part 2 of the audit document for the full write-up. In short:

1. **The database is showing through** (21) — column names, enum values and raw numbers reach the screen untranslated.
2. **Everything has equal weight** (14) — nine cards on the dashboard, twenty on machine detail, all the same size, all always open, in schema order.
3. **Numbers with nothing to do** (12) — counters that state a problem without offering the action; "2 Overdue" opening a report rather than the two machines.
4. **Placeholder-only form fields** (10).
5. **Submit-to-filter forms** (4).
6. **Status by colour alone, or no colour at all** (9).
7. **Server strings shown as user copy** (7) — `?error=Invalid+login+credentials` visible in the page and the address bar.
8. **Photos treated as decoration** (7) — real schema work (`primary_attachment_id`, batch-signed URLs) spent on 36px thumbnails; the dashboard never used the photo at all.
9. **Destructive actions styled quietly** (14) — and inversely, *Add a part* styled primary while *Save the job card* was secondary.

---

## Two decisions the client must approve

Everything else in this package is UI-only. These two change behaviour:

1. **Impersonation state** (S10). The support-mode banner cannot exist without a
   farm-context cookie set on enter and cleared on leave, plus a second
   `log_admin_farm_access(…, 'exit')` call so the log shows duration.
2. **Where an operator lands** (S11). `requireRole` currently redirects every denied user
   to `/dashboard?error=forbidden` — so a driver lands on a page of Rands the farm can
   explicitly switch off for operators, and `error=forbidden` is never rendered as
   anything a person can read. Needs a role branch on the post-login redirect and on the
   `requireRole` fallback. One line each, no new permissions.

---

## Design tokens

All colours are the repo's existing Tailwind tokens — do not introduce new ones.

**brand** (green): `#f1f8f2 #dcefdf #bbdfc2 #8fc89d #5aa971 #2f8b4e #15803d #166534 #14532b #123f23`
Primary action `#15803d`, hover `#166534`, dark chrome `#123f23`.

**sand** (warm neutral): `#faf9f7 #f4f2ed #e9e5dd #d8d2c7 #b3ab9d #8a8173 #6b6356 #514a3f #383229 #26221c`
Page `#faf9f7`, borders `#e9e5dd`, body text `#514a3f`, headings `#16130e`.

**status:** overdue `#dc2626` on `#fef2f2` with text `#b91c1c`; due-soon `#b45309` on
`#fffbeb` with text `#92400e`; ok `#15803d` on `#f1f8f2` with text `#166534`.

**Type:** Instrument Sans. Page title 25–27px/700/-0.022em · section 16–17px/700 ·
body 14–15px/400–500 · meta 12.5–13.5px. Mobile question headings 25px/700.
All numerals `font-variant-numeric: tabular-nums`.

**Radius:** 8–10px controls · 12–14px cards · 16–18px mobile cards · 999px pills.
**Tap targets:** 48px minimum on mobile, 40–44px desktop. Slide/print text never below 24px.
**Shadow:** `0 1px 2px rgba(16,24,20,0.05)` cards · `0 1px 3px rgba(16,24,20,0.14)` primary buttons.

## Copy tone

Plain and warm, like a person talking. "Nothing needs you today", not "No results".
"What's broken?", not "Fault description". "Make a job card", not "Create". Never expose
enum values, column names or bookkeeping vocabulary — the diesel page said
"Purchased · Delivered · Attributed · Issued" for what is really "came in" and
"went into machines".

Afrikaans is at parity and several driver-facing screens are shown in Afrikaans
deliberately, because invites default to `language: "af"`.

## Assets

No image assets are bundled. The designs use `<image-slot>` placeholders wherever a
machine photo belongs; in the real app these are the existing signed-URL attachments via
`primary_attachment_id`. All icons are inline SVG at 1.85–2.2 stroke width — match them to
the existing set in `src/components/ui/icons.tsx`.

## Files in this bundle

- `FleetWise Redesign.dc.html` — 22 screens with per-screen audit columns
- `FleetWise UX Audit.dc.html` — the written report, printable to PDF
- `doc-page.js`, `image-slot.js` — runtime for the two files above
- `github.md` — repo association and the screen-to-source map

Open either `.dc.html` in a browser. The redesign file is a pan-and-zoom canvas: each
screen is a numbered section (S01–S22) with desktop, mobile and audit side by side.

## Screen map

Every screen traces to the source it was built from — see the table in `github.md`.
