# FleetWise UI kit

Design-system primitives for the FleetWise PWA. Tokens live in
`tailwind.config.ts` (brand green scale, warm `sand` neutral scale, traffic-light
`status` tokens, soft shadows, system font stack) and `src/app/globals.css`
(semantic CSS vars, focus-ring, safe-area helpers).

All components are **server-compatible** unless their file starts with
`"use client"`. Client components: `Modal`, `Sheet`, `Toast`, `Tabs`,
`SubmitButton`, `NavLink`, `MoreMenu`, `PageInfo`, `ClearResultParams`.

## Two rules every screen follows

1. **A screen shows what IS; a button asks for what is NEW.** Fields to fill go in
   a `DialogForm`; a row's actions go in an `ActionMenu` titled with the row; more
   to read goes in a `Disclosure`; values are stated with `Fact`/`FactList`.
2. **One filled primary action per screen.** It is the thing the screen exists to
   start, and it lives in `PageHeader`'s `actions`. Everything else is
   `variant="secondary"` (or `ghost`, or an item in an `ActionMenu`): a card's or a
   row's own action is never filled, because ten green "Make a job card" buttons
   under one green "Report a fault" leave nothing to look at first. One action has
   one name: pick the existing key rather than coining a synonym. On a phone the tab
   bar already owns "Report a fault", so a page does not repeat it as a green button
   below `lg`.

## Page structure

Every page is `PageContainer` > `PageHeader` > content. Server components; import
them by direct path in a page (`@/components/ui/page-header`).

```tsx
import { PageContainer, PageHeader } from "@/components/ui/page-header";

<PageContainer size="wide">
  <PageHeader
    title={t("machines.title", locale)}
    lead={t("machines.lead", locale)}
    infoKey="machines"
    locale={locale}
    actions={<NewMachineDialog ... />}
  />
  <Flash tone="success" message={sp.saved ? t("ui.saved", locale) : undefined} />
  ...
</PageContainer>
```

- **`PageContainer`**, the page's width and vertical rhythm. Props: `size?`
  (`"narrow" | "default" | "wide"`, default `"default"`), `className?`. Every size
  is **left-aligned**, so the title never moves sideways between screens; on a
  phone all three are full width. Children are spaced `gap-6` (24px), which is the
  space under the header: do not add your own margin or `space-y-*` around it.

  | size | max width | use it for |
  |---|---|---|
  | `narrow` | `max-w-2xl` | settings, account, form-like screens, a short single record |
  | `default` | `max-w-4xl` | detail pages, the books (money, VAT, expenses, banking), reading |
  | `wide` | none | lists, tables, boards, calendars, dashboards |

  Do not invent a fifth width (`max-w-3xl`, `5xl`, `6xl`) on a page.

- **`PageHeader`**, the top of every screen. Props: `title` (the page's one h1),
  `lead?` (one sentence under it), `meta?` (a short fact on the line under the
  title: a date, a count), `badge?` (a `StatusBadge`), `infoKey?` + `locale`
  (renders "What is this?"), `actions?` (at most one filled primary, see the rule
  above), `back?: { href, label }`, `titleId?`, `className?`.
  Layout: back link; the h1 alone at full width, wrapping within itself; one quiet
  line with badge, meta and "What is this?"; the lead; actions on the right from
  `sm`, and on a phone their own full-width row under the text. "What is this?"
  never shares the title's row, so it cannot squeeze or wrap the title on a 360px
  phone, and it keeps its word (no icon-only controls in this product).

- **`BackLink`**, chevron plus the place's name at the 48px floor. Props: `href`,
  `label` (name the place, "Job cards", not "Back"), `className?`. `PageHeader`'s
  `back` renders it; use it directly only outside a header.
- **`backHref(from, fallback)`** (plain function, `back-href.ts`), to keep a list's
  filters on the way back: link rows with `?from=<list URL>` and pass
  `back={{ href: backHref(sp.from, "/jobcards"), label }}`. It honours only a
  same-origin path (one leading `/`, no backslash, no control character), so the
  parameter cannot become an open redirect.
- **`PageInfoButton`** (server), the "What is this?" trigger and panel for a
  `pageInfo.<infoKey>Title/What/Does/Note` key set. Props: `infoKey`, `locale`,
  `className?` (placement only). Quiet (no border, muted ink), icon and word, 48px
  hit area; the panel keeps the walkthrough re-entry. Prefer `PageHeader`'s
  `infoKey`, which places it.

## Importing, barrel vs. direct

Everything is re-exported from `@/components/ui` (`index.ts`). That's convenient,
but the barrel re-exports the client components too, and Next.js can't currently
tree-shake a mixed barrel: **a Server Component that imports from `@/components/ui`
pulls the kit's whole client chunk (~5 kB gzipped) into that route.**

Guidance:

- **Server Components** (pages, layouts that only use server pieces): import from
  the specific module, `@/components/ui/card`, `@/components/ui/stat`, etc. This
  keeps the route's client bundle flat. The dashboard and app shell do this.
- **Client Components**: import from the barrel or directly, no penalty.
- A one-line follow-up would remove the caveat entirely: add
  `experimental.optimizePackageImports: ["@/components/ui"]` to `next.config.mjs`
  (outside this kit's file ownership).

## Design tokens (cheat-sheet)

- **Brand green:** `brand-50…950`. `brand-600` = primary action (AA on white),
  `brand-700` = deep/hover & headings.
- **Warm neutral:** `sand-50…950`. Body bg `sand-50`, text `sand-900`, secondary
  text `sand-600`, borders `sand-200`.
- **Service status (Scope §4.3):** `status-ok` (green), `status-due` (amber),
  `status-overdue` (red), all AA as text on white.
- **Shadows:** `shadow-xs | shadow-card | shadow-soft | shadow-pop`.
- **Focus:** `.focus-ring` utility, or the global `:focus-visible` outline.
- **Radii:** friendly, `rounded-lg` (controls), `rounded-xl` (cards),
  `rounded-2xl` (dialogs).

## Components

### Layout / surfaces

- **`Card`**, panel surface. Props: `flush?` (drop inner padding, e.g. for a
  Table), plus `div` props.
- **`CardHeader`**, title row. Props: `action?: ReactNode` (right-aligned).
- **`CardTitle`**, heading. Props: `as?` (element, default `h2`).
- **`Stat`**, KPI tile. Props: `label`, `value`, `delta?`, `tone?`
  (`default|brand|ok|due|overdue`), `icon?`, `href?` (renders as a link with a
  chevron), `size?` (`lg` default, `md` for money in a tight grid), `valueKind?`
  (`number` default, `text` for a word value such as "Nothing waiting", set at a
  readable size instead of KPI size), `valueClassName?`.
- **`StatGrid`**, the one grid for a row of `Stat` tiles. Props: `columns?`
  (`2 | 3 | 4`, default 4), `className?`. Two columns on a phone, never more, and a
  lone last tile spans the row. Never hand-roll `grid-cols-3` around tiles: it forced
  pages wider than a 360px phone.
- **`EmptyState`**, placeholder. Props: `icon?`, `title`, `hint?`, `action?`.
  Presets: **`AllClear`**, **`GetStarted`**, and **`NoMatches`** for a filtered list
  that came back empty (`title`, `hint?`, `action?`, or `clearHref` + `clearLabel`
  for a secondary "Clear filters" link).
- **`FilteredEmpty`**, chooses between them: `filtered` true renders `NoMatches`
  (same props), otherwise its `children` (what an unfiltered empty list shows). Feed
  it `filterState()` (below) so an active filter never reads as "all clear".
- **`Skeleton`** / **`SkeletonText`**, loading placeholders. `Skeleton` sized via
  `className`; `SkeletonText` takes `lines?`.
- **`PageSkeleton`** (server-only, `./page-skeleton`, not in the barrel), a route's
  `loading.tsx`. Props: `shape?` (`list|detail|form|board|table`), `rows?`. Announces
  "Loading" in the device language.

### Data

- **`Table`**, dense table in a horizontal-scroll wrapper. Compose with
  **`Thead` / `Tbody` / `Tr` / `Th` / `Td`**. `Th` takes `sort?: "asc" | "desc" |
  null` to show a sort indicator (sets `aria-sort`; sorting itself is the
  caller's job). `stacked` restacks rows as labelled cards below `lg` (give every
  `Td` a `label`). The scroller is `relative`, so an `sr-only` label in a cell
  scrolled out of view stays clipped instead of widening the page.
- **`Badge`**, small pill. Props: `tone?`
  (`neutral|brand|ok|warning|danger|info`), `wrap?`. A pill never wraps by default
  (`whitespace-nowrap`); pass `wrap` for the rare long label that must. `StatusBadge`
  takes the same `wrap`.
- **`DateText`** (server), a date inside a real `<time>`. Props: `value` (ISO string,
  date-only string or `Date`; empty renders "-"), `locale`, `format?`
  (`auto|relative|day|dayTime|month`), `className?`. Pinned to Africa/Johannesburg;
  the exact date sits in `title`. Never print `created_at.slice(0, 10)`.
- **`StatusPill`**, traffic-light service pill. Props: `status:
  "ok"|"due_soon"|"overdue"`, `label?` (pass a `t()`-translated string for i18n;
  colour is never the only signal, a text label always shows).

### Forms

- **`Field`**, label + control + hint/error wrapper. Props: `label?`, `htmlFor?`,
  `hint?`, `error?` (shows as `role="alert"`; also wire the control's
  `aria-describedby` to `${htmlFor}-error`), `required?`.
- **`Input`**, text input. Props: `invalid?` + native input props. 44px min
  height, 16px text (no iOS zoom).
- **`Select`**, styled native `<select>` with chevron. Props: `invalid?` + native.
- **`Textarea`**, multiline input. Props: `invalid?`, `rows?` + native.
- **`Checkbox`** (server), a labelled checkbox row, the whole row the target (48px on
  a phone). Props: `label`, `hint?`, `className?` + every native checkbox prop; pass
  `id` and the hint becomes the box's description. Do not hand-roll a checkbox row.
- **`SearchField`** (client), search as you type, written to the URL. Props:
  `label` (aria-label and placeholder), `clearLabel`, `name?` (`"q"`),
  `defaultValue?`, `placeholder?`, `action?`, `keep?` (params the no-JS submit
  carries), `resetParams?` (default `["page"]`), `debounceMs?` (300), `className?`.
  Still a real GET form without JavaScript.
- **`FilterBar`** (client), one filter control for a list. Props: `path`, `search`,
  `groups: FilterGroup[]`, `filtersLabel`, `clearLabel`, `searchField?` (`{ label,
  clearLabel, placeholder?, name? }`, renders a `SearchField`), `searchSlot?` (older
  hand-built form), `rememberKey?` (keeps the last filters on this device and
  restores them when the URL has none), `extra?`.
- **`filter-state`** (plain module, server-safe): `filterState(path, search, groups,
  { searchParam?, pageParam? })` returns `{ active, clearHref }`;
  `hasActiveFilters`, `clearFiltersHref`, `hrefWithParams`, and the types
  `FilterGroup` / `ChipOption`. Call these from pages, never from `filter-bar.tsx`
  (a client module).

### Actions

- **`Button`** (server), Props: `variant?`
  (`primary|secondary|ghost|danger`), `size?` (`sm|md|lg`), `fullWidth?`,
  `loading?` (spinner + disabled), `leftIcon?`, `rightIcon?` + native button
  props. All sizes ≥44px tap target.
- **`buttonVariants({ variant, size, fullWidth, className })`**, class string, for
  styling a `<Link>` as a button: `<Link className={buttonVariants({ variant:
  "primary" })}>`.
- **`SubmitButton`** (client), submit button wired to `useFormStatus`; shows a
  spinner + disables while the enclosing `<form action={serverAction}>` is
  pending. Props: `variant?`, `size?`, `fullWidth?`, `leftIcon?`, `pendingText?`,
  `disabled?`. Must be inside the `<form>` it submits.

### Feedback

- **`Flash`** (server), inline alert that works without JS. Props: `message?`
  (renders nothing when empty), `tone?` (`success|error|info|warning`),
  `clearParams?` (see below), `className?`. Feed it a searchParams-derived
  message, e.g.
  `<Flash tone="success" message={saved ? t("ui.saved", locale) : undefined} />`.
  **The result leaves the URL once it is shown.** When a Flash renders a message
  it mounts `ClearResultParams`, which strips the outcome keys (`RESULT_PARAMS`:
  `saved`, `error`, `added`, `deleted`, `sent`, `paid`, `imported`, ... ) from the
  address bar with `history.replaceState`: no navigation, no refetch, the message
  stays for this view, and a refresh, a Back or a shared link does not replay it.
  Filters, tabs, searches and steps (`status`, `q`, `type`, `retired`, `checkout`,
  `panel`, ...) are never touched. `clearParams={["saved"]}` narrows the keys;
  `clearParams={false}` keeps them (a page that must ship no client component).
- **`KeepResultParams`** (server), `keys: string[]`. A hidden marker that
  protects those keys from EVERY Flash on the page, for a message that must
  survive a refresh (billing's "we are checking that payment, do not pay again").
- **`ClearResultParams`** (client), `keys?`, renders nothing. Mount it beside any
  non-Flash result display (a `Toast`, a custom banner) that reads a result param.
  Add a new outcome word to `RESULT_PARAMS` (`result-params.ts`) only after
  checking no page uses the same word as a filter or a step.
- **`Toast`** (client), dismissible, auto-hiding alert. Props: `message`, `tone?`,
  `duration?` (ms, 0 = never), `closeLabel` (required, `t("ui.dismiss", locale)`),
  `onDismissed?`.

### Overlays (client)

- **`Modal`**, centered dialog. Props: `open`, `onClose`, `title?`, `closeLabel?`,
  `footer?`, `children`. Focus trap, Esc-to-close, scroll lock, `aria-modal`.
- **`Sheet`**, bottom sheet (mobile-first; used by the nav "More" menu). Props:
  `open`, `onClose`, `title?`, `closeLabel?`, `children`.
- **`DialogForm`**, a capture form behind a button (see CLAUDE.md, "A screen shows what
  IS"). `defaultOpen?` opens it on arrival, e.g. after a GET step or a validation
  bounce; `DialogSection` takes `title` and `defaultOpen?` for a long form's optional
  groups.
- Every overlay (Modal, Sheet, ActionMenu, DialogForm, ConfirmDialog) is
  `print:hidden`: printing with one open prints the page behind it.

### Navigation & disclosure (client)

- **`Tabs`**, accessible tabs (roving focus, arrow keys). Props: `tabs:
  {key,label,content}[]`, `defaultTab?`, `param?` (mirror the selected tab in
  `?<param>=<key>` with `replaceState`), `printAll?` (keep every panel mounted and
  print all of them, each under its label; the strip is not printed).
- **`tabs-url`** (plain module, server-safe): `withTab(url, key, param = "tab")`
  for a server action's redirect back onto the tab it came from, and
  `readTab(value, keys)`, which turns a raw search param into a valid `defaultTab`
  (unknown keys fall back to the first tab). Never import these from `tabs.tsx`.
- **`NavLink`**, active-aware nav link (`usePathname`). Props: `item:
  {href,label,icon}`, `variant: "sidebar" | "tab"`. Used by the app shell.
- **`MoreMenu`**, the mobile "More" tab; opens a `Sheet` of overflow nav items +
  a sign-out slot. Props: `label`, `title`, `closeLabel`, `items: NavItemData[]`,
  `signOutSlot: ReactNode` (render the `<form action={signOut}>` server-side and
  pass it in).

### Icons

Hand-rolled inline SVGs in `icons.tsx` (no icon-pack dependency). Named exports
(`DashboardIcon`, `MachinesIcon`, `BellIcon`, `PlusIcon`, `SearchIcon`, …) plus:

- **`Icon`**, render by string name: `<Icon name="dashboard" />` (lets a Server
  Component pass a serializable icon name across the client boundary).
- **`Spinner`**, animated loader used by buttons.
- Recent additions: `FilterIcon` (`filter`, the FilterBar button) and `TyreIcon`
  (`tyre`, the Tyres nav item).

All icons use `currentColor` and size from `font-size` (`text-[1.4rem]` etc.);
they're `aria-hidden` unless given a `title`.

### Utilities

- **`cn(...values)`**, tiny falsy-filtering className joiner (no dependency).
