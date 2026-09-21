> **How to launch this**
> Start a fresh Claude Code session in the `farming-machinery-asset-manager` repo on
> `main`, and paste **everything below the line** as your first message. Nothing above the
> line is part of the prompt.

---

# FleetWise, billing and sign-up UI/UX upgrade

You are working on **FleetWise**, a multi-tenant PWA that South African farms use to manage
machinery. Your job this session is the **user experience of the money screens**: `/billing`,
`/signup` and `/activate`. You are not changing what anything charges or when.

**Read `CLAUDE.md` first**, in full. It carries the project's conventions and a
"Hard-won rules" section where every entry cost somebody a debugging session. Then read
`docs/BILLING.md` §6b (the two billing models) and `docs/DESIGN.md`.

## Who you are designing for

A farmer or farm manager on a **mid-range Android phone**, often on a poor connection, often
outdoors. Frequently not a confident computer user. The app ships in **English and
Afrikaans** and both are first-class.

They open `/billing` to answer one of three questions, and almost never to change anything:

1. When is the next payment, and how much?
2. Am I in trouble?
3. Is my card still going to work?

## The five jobs

Ordered by value. Do them in order. Commit each separately with a message that says what a
reader would otherwise have to work out.

### 1. Put the answer above the fold (highest value)

`/billing` currently stacks nine cards. The single fact people arrive for, how much, and
when, sits in the **footer of the third card**. On a phone that is three scrolls of plan
and vehicle admin before they learn anything.

Add a summary strip at the top answering all three questions at a glance: **next charge
with its date**, **slots used against slots bought**, and **the card with its expiry
state**.

Use the existing **`Stat`** primitive (`@/components/ui/stat`). It already carries label,
value, tone and an optional href. Six pages use it, **including `/admin/billing`**, and
the customer-facing `/billing` renders the same kind of number with hand-rolled markup
instead, so the two billing screens currently look like different products. Fixing that
inconsistency is part of this job.

Everything you need is already computed in the page: `next` (from `nextChargeState`),
`estimate`, `unitsBilled`, `assets.billable`, `card` and `expiry`. Do not recompute any of
it, and do not re-derive money in the component.

### 2. Separate reading from changing

The change-plan and change-slots forms sit **inside** the informational cards, which is
most of why the page runs past 1,200 lines and scrolls as far as it does.

Move both behind one disclosure so the default view is short and read-only. Keep the
two-step behaviour exactly as it is: choosing a plan or a slot count is a **GET** to
`/billing` that renders a **priced review**, and only a second explicit press commits. That
review exists because these two controls used to charge a card straight off a dropdown with
no figure shown. **Do not collapse it back into a single submit.**

### 3. The invoice history on a phone

Seven columns in a horizontal scroll. That is the kit's deliberate pattern and it is not
broken, but for somebody checking "did October go through" it is a lot of thumb work.

Below the `sm` breakpoint, render a stacked card list: reference, period, amount, status,
and the download link. Keep the existing `Table` from `sm:` upward. Both must show the same
rows and the same statuses.

### 4. Use the Toast primitive for confirmations

`src/components/ui/toast.tsx` is built, exported from the barrel, and **called by nothing**.

Route action confirmations through it, "slots added", "plan changed", "card removed" -
instead of a banner that shoves the whole page down on every action.

**Keep `Flash` for anything that must persist.** In particular `billing.savedChecking`
("we are checking that payment with the bank") must **not** disappear on a timer: it is the
message that stops somebody paying twice. `savedNotice()` in `src/lib/billing/view.ts`
already returns a `tone` of `success` or `info` per outcome, use that to decide, and keep
its rule that money which has not landed is never reported as success.

### 5. Make the plan comparison actually compare

`/signup`'s comparison currently lists what the **selected** plan includes. Somebody
weighing Professional against Complete cannot see them side by side.

Build a compact matrix: feature rows, four plan columns, ticks. Horizontal scroll is fine
on a phone.

**The feature-to-plan mapping must stay derived from `FEATURE_MIN_PLAN` and `PLAN_RANK` in
`src/lib/entitlements.ts`**, which is the same map the entitlement gates read. Only the
labels come from the dictionaries. Never hard-code which plan has what: selling a feature
the product then refuses is the one mistake a pricing page must not make.

## Rules that will bite you

Each of these has already cost this project a session.

- **Every user-visible string lives in `src/lib/i18n/en.json` and `af.json`**, both, with
  matching keys. Afrikaans is really translated here, not copied. `t()` returns the key on
  a miss, so a missing key renders `billing.somethingTitle` at a customer.
- **Those JSON files are CRLF with two-space indent.** They round-trip exactly through
  `JSON.stringify(obj, null, 2)` plus a CRLF conversion. Preserve that or you will produce a
  whole-file diff.
- **Never render a raw database string.** Refusals from SQL come back as English prose
  written in a migration. `quoteReasonKey()` and `src/lib/errors.ts` exist to turn codes into
  translated sentences. An untranslated Postgres string in front of an Afrikaans farmer is a
  bug, and one was shipped and fixed this week.
- **Server components import from the specific module** (`@/components/ui/card`), not the
  barrel. The barrel mixes client components and Next.js cannot tree-shake it, so a barrel
  import pulls the whole client chunk into that route. `src/components/ui/README.md`
  explains it.
- **`/billing` reads a Paystack charging credential's table.** Never add `select=*` on
  `billing_payment_methods`; the credential columns are revoked at column level and a
  `select=*` returns a permission error, which is a 500 on a farmer's screen. Column lists
  are enumerated once in `src/lib/billing/view.ts`.
- **Touch-target floor is 48px** on mobile, and there is a design lint that enforces the
  token system. Use `brand-*`, `sand-*`, `status-*` and `callout-*` tokens, never raw hex.
- Both themes must agree. The design lint checks contrast and dark-mode blocks.

## Gates, all must pass before you call anything done

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
node scripts/i18n_parity.mjs
node scripts/i18n_keys.mjs
node scripts/error_coverage.mjs
node scripts/design_lint.mjs
```

`pnpm db:test` needs a psql this machine does not have. `pnpm db:check` stands in on
PGlite. You should not need either for this work; if you do, you have gone outside the
brief.

## Definition of done

- All five jobs, each its own commit.
- Every gate above green, including a clean production build.
- No change to what is charged, when it is charged, or to the two-step review before a
  plan or slot change commits.
- The billing page's default view fits the three questions above the fold on a 360px-wide
  screen.
- Both languages complete, with real Afrikaans rather than English copied across.
- Append one entry to `docs/BUILD_LOG.md` in the existing shape: what was measured, what
  was left undone and why. Update `CLAUDE.md` only where it has become wrong.

## Where things are

| | |
|---|---|
| Owner's billing screen | `src/app/(app)/billing/page.tsx` and `actions.ts` |
| Rapid Rise's billing screen | `src/app/(app)/admin/billing/page.tsx` |
| Pure presentation helpers, tested | `src/lib/billing/view.ts`, `view.test.ts` |
| Sign-up | `src/app/(public)/signup/` (`page.tsx`, `plan-picker.tsx`, `actions.ts`) |
| Between signing up and paying | `src/app/(auth)/activate/page.tsx` |
| UI kit and its guidance | `src/components/ui/`, `README.md` |
| What is left overall | `docs/BILLING_RELEASE_GATES.md` |

Put new pure logic in `src/lib/billing/view.ts` and test it in `view.test.ts`. That file is
deliberately pure, no I/O, no Supabase client, no `process.env`, so both billing screens
cannot disagree about what a status means or what the next charge comes to.
