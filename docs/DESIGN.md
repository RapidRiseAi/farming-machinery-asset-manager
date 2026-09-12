# FleetWise design system

Source of truth for colour, type and interaction. Derived from
**FleetWise Official Colour Palette** (internal brand reference).

---

## 1. The brand anchors

Seven colours. Pinned to exact hex, never altered.

| Role | Colour | Hex | Token | Use |
|---|---|---|---|---|
| Primary | FleetWise Green | `#00572C` | `brand-600` | Branding, headings, navigation, buttons, large sections |
| Accent | FleetWise Gold | `#EAA50C` | `gold-500` | CTAs, important numbers, selected states, highlights |
| Dark | FleetWise Black | `#000000` | `sand-950` | Dark grounds, premium sections, logo background |
| Light base | Warm Cream | `#F7F3E8` | `sand-50` | Main light background |
| Pure light | White | `#FFFFFF` | `white` | Text on dark, cards, clean space |
| Body text | Charcoal | `#242824` | `sand-900` | Long-form text instead of harsh pure black |
| Muted neutral | Warm Grey | `#E6E2D7` | `sand-200` | Borders, dividers, secondary backgrounds |

**Brand rule:** green dominant, gold as the *single* accent, neutrals supporting.
Keep gold deliberate so it stays visually important. No additional brand accent
colours.

### Why there are more than seven values

Two anchors cannot do the job the brand assigns them, at an accessible contrast:

- **Gold is 1.92:1 on cream.** It cannot carry text. It is a *fill* — black on
  gold is 9.89:1. `gold-600` `#936505` is the same hue darkened until it clears
  4.5:1, so "important numbers" can be gold *and* legible.
- **Warm Grey is 1.17:1 on cream.** A lovely surface tint, an invisible border.
  `sand-300` is the shade that reaches the 3:1 WCAG SC 1.4.11 requires of a
  control boundary.

A darker shade of an anchor is not a new accent. Nothing here introduces a hue
that isn't in the palette, with one deliberate exception noted in §4.

---

## 2. Neutral ramp — what each step is *allowed* to do

The ramp travels from the warm yellow of the cream to the faint green cast of
the charcoal (`#242824` has more green than red or blue) — the brand's own two
ends, joined rather than replaced by a generic grey.

Ratios measured on the cream ground `#F7F3E8`. On white cards each is ~11% higher.

| Token | Hex | On cream | May be used for |
|---|---|---|---|
| `sand-50` | `#f7f3e8` | — | Page ground |
| `sand-100` | `#efeadc` | — | Raised surface, hover |
| `sand-200` | `#e6e2d7` | 1.17:1 | **Decorative only** — card edges, dividers, secondary surfaces |
| `sand-300` | `#8f8b7f` | 3.07:1 | **Control borders** — inputs, selects, secondary buttons |
| `sand-400` | `#716e64` | 4.60:1 | Placeholder text, decorative icons |
| `sand-500` | `#5d5a52` | 6.21:1 | **Secondary text** — hints, metadata, table headers |
| `sand-600` | `#484640` | 8.51:1 | Emphasised secondary |
| `sand-700` | `#393832` | 10.61:1 | — |
| `sand-800` | `#2e2d29` | 12.43:1 | — |
| `sand-900` | `#242824` | 13.49:1 | **Body text** |
| `sand-950` | `#000000` | 18.94:1 | Dark grounds |

`sand-500` is the important one: it is the app's default secondary text and
carries ~418 usages. It now clears AA at small sizes, which it did not before.

---

## 3. Using gold well

Gold is the single accent and it loses its force if it is everywhere.

**Do**
- One gold CTA per screen at most — the action you actually want taken.
- Important *numbers*: the figure the screen exists to communicate (a total
  outstanding, an overdue count, this month's spend). Use `text-gold-600`.
- Selected state: an active tab, the chosen filter, the current step.
- A thin gold rule or left-edge to mark the one thing needing attention.

**Don't**
- Gold as body or secondary text.
- Gold at `gold-500` on any light ground as text — it is 1.92:1. Fill only.
- More than one gold emphasis competing in a viewport.
- Gold for *status*. Status has its own scale (§4).

**Gold fill recipe:** `bg-gold-500 text-sand-950` — 9.89:1, and the only correct
way to render a gold button.

---

## 4. Status colours

Functional, not brand accents (Scope §4.3). Two of the three come from the
palette:

| Token | Hex | On cream | Meaning |
|---|---|---|---|
| `status-ok` | `#00572c` | 7.89:1 | FleetWise Green — fine, done, current |
| `status-due` | `#8a5e05` | 5.14:1 | A shade of FleetWise Gold — due soon |
| `status-overdue` | `#b3201f` | 6.03:1 | Overdue, fault, destructive |

`status-overdue` red is the **one deliberate exception** to "no additional
colours". It is a safety signal on a product about heavy machinery, it is
never used as chrome, and no other hue means "stop" to a driver.

Status is always **shape + word + colour**, never colour alone — see
`components/ui/badge.tsx`.

---

## 5. The scale flips — that is how dark mode works

`sand-*` carries the app's entire neutral vocabulary: ~1,500 usages of
`text-sand-500`, `bg-sand-50`, `border-sand-200` across 445 files. Fixed hex
made every one of them light-only, which is *why* there was no dark theme —
fixing it at the call sites would have been ~1,500 edits.

So the scale itself is defined as CSS variables and **flips per theme**. A step
is a **role** — distance from the page ground — not an absolute lightness:

| Step | Light | Dark | Duty (identical in both) |
|---|---|---|---|
| `sand-50` | `#f7f3e8` cream | `#141714` | page ground |
| `sand-200` | `#e6e2d7` warm grey | `#272c27` | decorative edge / card |
| `sand-300` | `#8f8b7f` | `#6d6b62` | control border ≥ 3:1 |
| `sand-400` | `#716e64` | `#8f8b7f` | placeholder ≥ 4.5:1 |
| `sand-500` | `#5d5a52` | `#a2a097` | secondary text ≥ 4.5:1 |
| `sand-900` | `#242824` charcoal | `#f7f3e8` cream | body text ≥ 4.5:1 |

Every dark step was solved numerically against the dark **card** surface (the
demanding case) to the same ratio its light twin owes. So `text-sand-500` means
"the readable secondary colour in whatever theme is showing" — in both, with no
call-site change.

**`brand` does NOT flip.** A green button is the brand's green in both themes.
Only the green used *as text* moves, via `text-brand-ink` (brand-700 in light,
brand-300 in dark) — the deep `#00572C` is 7.89:1 on cream and **1.27:1** on
near-black. Use `bg-brand-tint` for a chip ground, never `bg-brand-50`.

## 5b. Semantic surface tokens

Use these, not raw sand values, for anything that must survive a theme change:

| Class | Custom property | Light | Dark |
|---|---|---|---|
| `bg-surface` | `--surface` | white | `#1d211d` |
| `bg-surface-raised` | `--surface-raised` | cream | `#272c27` |
| `bg-surface-sunken` | `--surface-sunken` | `#efeadc` | `#141714` |
| `text-ink` | `--ink` | charcoal | Warm Cream |
| `text-ink-muted` | `--ink-muted` | `sand-500` | `#b8b6af` |
| `text-ink-subtle` | `--ink-subtle` | `sand-400` | `#969388` |
| `border-edge` | `--edge` | `sand-300` | `#8f8b7f` |
| `border-edge-soft` | `--edge-soft` | Warm Grey | `#53524a` |

Defined in `src/app/globals.css`. They are stored as space-separated RGB
channels so Tailwind's `<alpha-value>` works — `bg-surface/60` composites.

### Dark theme

FleetWise Black is a sanctioned brand ground ("dark backgrounds, premium
sections"), so dark mode is an on-brand treatment rather than an inversion:
near-black carrying the charcoal's green cast, Warm Cream as the text, and
**gold promoted to lead accent** because it sings on black (7.68:1) where the
deep green cannot.

Three states are handled: `prefers-color-scheme` for the default "system"
setting, plus `[data-theme="dark"]` / `[data-theme="light"]` so an explicit
choice wins in either direction. **Only tokens are redefined — never a
component rule.** A colour whose only definition sits inside a `[data-theme]`
block will not apply in the un-stamped state.

---

## 6. Type scale

One scale, nine steps, line-height and tracking paired with each. Before this
there were 32 distinct sizes in use, 24 of them arbitrary `text-[1.05rem]`
one-offs — four within 0.15rem of each other.

`text-2xs` · `xs` · `sm` · `base` · `lg` · `xl` · `2xl` · `3xl` · `4xl`

**Never add an arbitrary `text-[…rem]`.** If a size seems missing, the answer is
almost always the nearest step.

Digits that line up in a column get `.tnum` (tabular figures) — money, meter
readings, quantities.

---

## 7. Non-negotiables

These were each a measured defect. Don't reintroduce them.

1. **No `maximum-scale`.** Pinch-zoom stays available (WCAG 1.4.4).
2. **48px minimum touch target** on phones; controls may step down only at `sm:`.
3. **Never colour alone** for meaning — always pair with a word or a shape.
4. **Every image** goes through `<Photo>`: intrinsic dimensions, lazy by
   default, real alt text.
5. **Every table** uses the kit's `Table/Thead/Tr/Th/Td` — `Th` supplies
   `scope="col"` and `aria-sort`, which hand-rolled tables were missing on 67
   header cells.
6. **Every form error** names its field (`Field error=`, `aria-invalid`), not
   just a banner at the top of the page.
7. **Every user-facing string** goes through `t()`. No raw English in a
   redirect, a Flash or an aria-label.
8. **No stock Tailwind colours** (`green-500`, `red-50`, `blue-700`, `gray-*`).
   The palette above is the whole palette.
9. **No token that isn't defined.** Tailwind emits *nothing* for an unknown
   class, silently. `status-warn` and `status-bad` were used 19 times across 13
   files and defined in no version of the config — including on the 60-day
   column of the debtors ageing, which exists to say "this is getting late".

---

## 8. The gates

None of the above is enforceable by the existing checks: `tsc` reads
`text-sand-500` as a valid string, ESLint has no opinion on a 3.65:1 ratio, and
`next build` succeeded with pinch-zoom disabled for every user of the product.
Two scripts close that gap. Both are mutation-tested — each rule was verified to
actually fire before being trusted.

```bash
pnpm design:lint      # palette, type scale, gold misuse, images, tables,
                      # undefined tokens, viewport, manifest + a 12-case
                      # contrast contract on the tokens themselves
pnpm errors:check     # every error code the app can emit resolves to a
                      # translated sentence, in BOTH languages
pnpm i18n:parity      # en/af key parity
```

Run them with `typecheck`, `lint` and `build`. `design:lint` reports 0
violations as of this pass, down from 291.
