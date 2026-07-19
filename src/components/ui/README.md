# FarmGear UI kit

Design-system primitives for the FarmGear PWA. Tokens live in
`tailwind.config.ts` (brand green scale, warm `sand` neutral scale, traffic-light
`status` tokens, soft shadows, system font stack) and `src/app/globals.css`
(semantic CSS vars, focus-ring, safe-area helpers).

All components are **server-compatible** unless their file starts with
`"use client"`. Client components: `Modal`, `Sheet`, `Toast`, `Tabs`,
`SubmitButton`, `NavLink`, `MoreMenu`.

## Importing — barrel vs. direct

Everything is re-exported from `@/components/ui` (`index.ts`). That's convenient,
but the barrel re-exports the client components too, and Next.js can't currently
tree-shake a mixed barrel: **a Server Component that imports from `@/components/ui`
pulls the kit's whole client chunk (~5 kB gzipped) into that route.**

Guidance:

- **Server Components** (pages, layouts that only use server pieces): import from
  the specific module — `@/components/ui/card`, `@/components/ui/stat`, etc. This
  keeps the route's client bundle flat. The dashboard and app shell do this.
- **Client Components**: import from the barrel or directly — no penalty.
- A one-line follow-up would remove the caveat entirely: add
  `experimental.optimizePackageImports: ["@/components/ui"]` to `next.config.mjs`
  (outside this kit's file ownership).

## Design tokens (cheat-sheet)

- **Brand green:** `brand-50…950`. `brand-600` = primary action (AA on white),
  `brand-700` = deep/hover & headings.
- **Warm neutral:** `sand-50…950`. Body bg `sand-50`, text `sand-900`, secondary
  text `sand-600`, borders `sand-200`.
- **Service status (Scope §4.3):** `status-ok` (green), `status-due` (amber),
  `status-overdue` (red) — all AA as text on white.
- **Shadows:** `shadow-xs | shadow-card | shadow-soft | shadow-pop`.
- **Focus:** `.focus-ring` utility, or the global `:focus-visible` outline.
- **Radii:** friendly — `rounded-lg` (controls), `rounded-xl` (cards),
  `rounded-2xl` (dialogs).

## Components

### Layout / surfaces

- **`Card`** — panel surface. Props: `flush?` (drop inner padding, e.g. for a
  Table), plus `div` props.
- **`CardHeader`** — title row. Props: `action?: ReactNode` (right-aligned).
- **`CardTitle`** — heading. Props: `as?` (element, default `h2`).
- **`Stat`** — KPI tile. Props: `label`, `value`, `delta?`, `tone?`
  (`default|brand|ok|due|overdue`), `icon?`, `href?` (renders as a link with a
  chevron).
- **`EmptyState`** — placeholder. Props: `icon?`, `title`, `hint?`, `action?`.
- **`Skeleton`** / **`SkeletonText`** — loading placeholders. `Skeleton` sized via
  `className`; `SkeletonText` takes `lines?`.

### Data

- **`Table`** — dense table in a horizontal-scroll wrapper. Compose with
  **`Thead` / `Tbody` / `Tr` / `Th` / `Td`**. `Th` takes `sort?: "asc" | "desc" |
  null` to show a sort indicator (sets `aria-sort`; sorting itself is the
  caller's job).
- **`Badge`** — small pill. Props: `tone?`
  (`neutral|brand|ok|warning|danger|info`).
- **`StatusPill`** — traffic-light service pill. Props: `status:
  "ok"|"due_soon"|"overdue"`, `label?` (pass a `t()`-translated string for i18n;
  colour is never the only signal — a text label always shows).

### Forms

- **`Field`** — label + control + hint/error wrapper. Props: `label?`, `htmlFor?`,
  `hint?`, `error?` (shows as `role="alert"`; also wire the control's
  `aria-describedby` to `${htmlFor}-error`), `required?`.
- **`Input`** — text input. Props: `invalid?` + native input props. 44px min
  height, 16px text (no iOS zoom).
- **`Select`** — styled native `<select>` with chevron. Props: `invalid?` + native.
- **`Textarea`** — multiline input. Props: `invalid?`, `rows?` + native.

### Actions

- **`Button`** (server) — Props: `variant?`
  (`primary|secondary|ghost|danger`), `size?` (`sm|md|lg`), `fullWidth?`,
  `loading?` (spinner + disabled), `leftIcon?`, `rightIcon?` + native button
  props. All sizes ≥44px tap target.
- **`buttonVariants({ variant, size, fullWidth, className })`** — class string, for
  styling a `<Link>` as a button: `<Link className={buttonVariants({ variant:
  "primary" })}>`.
- **`SubmitButton`** (client) — submit button wired to `useFormStatus`; shows a
  spinner + disables while the enclosing `<form action={serverAction}>` is
  pending. Props: `variant?`, `size?`, `fullWidth?`, `leftIcon?`, `pendingText?`,
  `disabled?`. Must be inside the `<form>` it submits.

### Feedback

- **`Flash`** (server) — inline alert, no JS. Props: `message?` (renders nothing
  when empty), `tone?` (`success|error|info|warning`). Feed it a
  searchParams-derived message, e.g.
  `<Flash tone="success" message={saved ? t("ui.saved", locale) : undefined} />`.
- **`Toast`** (client) — dismissible, auto-hiding alert. Props: `message`, `tone?`,
  `duration?` (ms, 0 = never), `closeLabel?`, `onDismissed?`.

### Overlays (client)

- **`Modal`** — centered dialog. Props: `open`, `onClose`, `title?`, `closeLabel?`,
  `footer?`, `children`. Focus trap, Esc-to-close, scroll lock, `aria-modal`.
- **`Sheet`** — bottom sheet (mobile-first; used by the nav "More" menu). Props:
  `open`, `onClose`, `title?`, `closeLabel?`, `children`.

### Navigation & disclosure (client)

- **`Tabs`** — accessible tabs (roving focus, arrow keys). Props: `tabs:
  {key,label,content}[]`, `defaultTab?`.
- **`NavLink`** — active-aware nav link (`usePathname`). Props: `item:
  {href,label,icon}`, `variant: "sidebar" | "tab"`. Used by the app shell.
- **`MoreMenu`** — the mobile "More" tab; opens a `Sheet` of overflow nav items +
  a sign-out slot. Props: `label`, `title`, `closeLabel`, `items: NavItemData[]`,
  `signOutSlot: ReactNode` (render the `<form action={signOut}>` server-side and
  pass it in).

### Icons

Hand-rolled inline SVGs in `icons.tsx` (no icon-pack dependency). Named exports
(`DashboardIcon`, `MachinesIcon`, `BellIcon`, `PlusIcon`, `SearchIcon`, …) plus:

- **`Icon`** — render by string name: `<Icon name="dashboard" />` (lets a Server
  Component pass a serializable icon name across the client boundary).
- **`Spinner`** — animated loader used by buttons.

All icons use `currentColor` and size from `font-size` (`text-[1.4rem]` etc.);
they're `aria-hidden` unless given a `title`.

### Utilities

- **`cn(...values)`** — tiny falsy-filtering className joiner (no dependency).
