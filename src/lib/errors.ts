import { t, type Lang } from "@/lib/i18n";

/**
 * One place that turns an error code into a sentence a person can read.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 * Server actions in this app reject by redirecting to `?error=<something>`, and
 * there are 259 such paths. 232 of them put RAW ENGLISH or a raw Postgres
 * message straight into the URL:
 *
 *     redirect("/admin/farms?error=Name+is+required")
 *     redirect(`/admin/templates?error=${encodeURIComponent(error.message)}`)
 *
 * Pages then render whatever arrives, most of them with a hand-rolled ternary
 * chain that covers two or three codes and falls through to printing the code
 * itself:
 *
 *     <Flash tone="error" message={sp.error === "upgrade" ? t(...) : sp.error} />
 *
 * So in a product that keeps 3,560 translation keys at parity, an Afrikaans
 * farmer could be shown `need-name`, `po_line_qty`, or a Supabase error string
 * in English. And because every page invented its own mapping, coverage was
 * patchy by construction.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * `errorMessage()` ALWAYS returns a translated sentence. An unrecognised code
 * yields the generic apology, never the raw code — a person seeing
 * "Something didn't work" learns as much as they would from `wrong_direction`,
 * and at least it is in their language.
 *
 * Adding a new error: add the code to CODE_KEYS below and the key to both
 * dictionaries. `npm run design:lint` does not police this, but
 * `scripts/i18n_parity.mjs` will catch a key that exists in one language only.
 */

/** The generic fallback. Used whenever a code is not recognised. */
const FALLBACK = "errors.generic";

/**
 * Every error code the app can emit, mapped to an i18n key.
 *
 * Keys are matched after normalisation (see `normalise`), so the slug form
 * (`need-name`), the underscore form (`need_name`) and the raw English that was
 * historically put in the URL (`Name+is+required`) all land on the same entry.
 * The raw-English aliases are kept so the mapping works even before every
 * action is converted to emit a slug.
 */
const CODE_KEYS: Record<string, string> = {
  // ── Permission, session, existence ────────────────────────────────────────
  forbidden: "errors.forbidden",
  "not-allowed": "errors.forbidden",
  // Emitted as "You+can+invite+manager/mechanic/operator+only" — the slashes are
  // stripped by `normalise`, which is why the key looks run-together.
  "you-can-invite-managermechanicoperator-only": "errors.inviteRole",
  auth: "errors.session",
  "no-profile": "errors.session",
  "no-farm": "errors.noFarm",
  "no-farm-context": "errors.noFarm",
  "missing-farm": "errors.noFarm",
  "farm-not-found": "errors.noFarm",
  "no-workshop": "errors.noWorkshop",
  "not-found": "errors.notFound",
  "schedule-not-found": "errors.notFound",
  "template-not-found": "errors.notFound",
  "part-not-found": "errors.notFound",
  "partner-not-found": "errors.notFound",
  "suggested-partner-not-found": "errors.notFound",
  "unknown-template": "errors.notFound",
  "missing-fine": "errors.notFound",
  "missing-partner": "errors.notFound",
  "missing-vehicle": "errors.notFound",
  "missing-machine": "errors.pickMachine",
  "missing-id": "errors.missing",
  "missing-ids": "errors.missing",
  missing: "errors.missing",
  empty: "errors.missing",

  // ── Things the person needs to fill in ────────────────────────────────────
  name: "errors.needName",
  "need-name": "errors.needName",
  "missing-name": "errors.needName",
  "name-is-required": "errors.needName",
  "kit-name-is-required": "errors.needName",
  "part-number-is-required": "errors.needPartNo",
  "pick-a-part-or-enter-a-part-number": "errors.needPartNo",
  "need-amount": "errors.needAmount",
  "budget-amount-is-required": "errors.needAmount",
  "enter-a-quote-amount": "errors.needQuote",
  "enter-an-invoice-amount": "errors.needInvoice",
  "need-email": "errors.needEmail",
  "a-valid-email-is-required": "errors.needEmail",
  "a-valid-email-is-required-to-invite": "errors.needEmail",
  "need-description": "errors.needDescription",
  "task-is-required": "errors.needDescription",
  "empty-note": "errors.needDescription",
  "pick-a-machine-and-describe-the-problem": "errors.needFault",
  "need-recipient": "errors.needRecipient",
  "missing-recipient": "errors.needRecipient",
  "need-supplier": "errors.needSupplier",
  "need-line": "errors.needLine",
  "add-at-least-one-valid-line": "errors.needLine",
  "template-has-no-lines": "errors.needLine",
  "kit-has-no-items": "errors.needLine",
  "name-and-lines-required": "errors.needLine",
  "pick-a-kit": "errors.pickKit",
  "pick-a-template": "errors.pickTemplate",
  "pick-a-machine": "errors.pickMachine",
  "expiry-date-is-required": "errors.needExpiry",
  "set-an-hour-or-month-interval": "errors.needInterval",
  "stock-need-qty": "errors.needQty",
  "enter-a-valid-reading": "errors.badReading",
  "void-reason": "errors.needReason",
  "revise-reason": "errors.needReason",
  "writeoff-reason": "errors.needReason",
  "revise-empty": "errors.needLine",

  // ── Values that don't make sense ──────────────────────────────────────────
  "invalid-values": "errors.badValues",
  "invalid-status": "errors.badValues",
  "bad-status": "errors.badValues",
  "invalid-type": "errors.badValues",
  "bad-plan": "errors.badValues",
  "wrong-direction": "errors.wrongDirection",
  "save-failed": "errors.saveFailed",
  "more-than-owed": "errors.moreThanOwed",
  "refund-too-big": "errors.refundTooBig",
  "not-an-invoice": "errors.notAnInvoice",

  // ── State that blocks the action ──────────────────────────────────────────
  locked: "errors.locked",
  closed: "errors.closed",
  "not-issued": "errors.notIssued",
  "already-void": "errors.alreadyVoid",
  "already-sent": "errors.alreadySent",
  "already-linked": "errors.alreadyLinked",
  "already-synced": "errors.alreadySynced",
  "already-settled": "errors.alreadySettled",
  "not-linked": "errors.notLinked",
  "this-partner-is-not-connected-yet": "errors.notLinked",
  "revoke-failed": "errors.revokeFailed",

  // ── Entitlement ───────────────────────────────────────────────────────────
  upgrade: "errors.upgrade",
  "upgrade-required": "errors.upgrade",

  // ── Files and import ──────────────────────────────────────────────────────
  "logo-format": "errors.logoFormat",
  "logo-too-big": "errors.logoTooBig",
  "receipt": "errors.receipt",
  "no-csv-provided": "errors.noCsv",
  "invalid-csv-header": "errors.badCsvHeader",
  "no-valid-rows": "errors.noValidRows",
  "nothing-valid": "errors.noValidRows",
  "too-many-rows": "errors.tooManyRows",
  "too-many": "errors.tooManyRows",

  // ── Purchase orders ───────────────────────────────────────────────────────
  // These are emitted in camelCase (`po-needSupplier`), which `normalise`
  // lower-cases WITHOUT inserting a separator — so the lookup key has no hyphen
  // in the second half. Verified against what the code actually emits rather
  // than guessed; `scripts/` has a check that every emitted code is covered.
  "po-badstatus": "errors.badValues",
  "po-cannotconvert": "errors.poCannot",
  "po-hasexpense": "errors.poHas",
  "po-needamount": "errors.needAmount",
  "po-needdescription": "errors.needDescription",
  "po-needqty": "errors.needQty",
  "po-needsupplier": "errors.needSupplier",
  "po-notfound": "errors.notFound",

  // ── Cross-farm attempts (these are RLS doing its job) ─────────────────────
  "you-cannot-record-a-reading-for-that-farm": "errors.wrongFarm",
  "you-cannot-report-a-fault-for-that-farm": "errors.wrongFarm",
  "wrong-farm": "errors.wrongFarm",

  // ── Team invites ──────────────────────────────────────────────────────────
  "email-name-and-role-required": "errors.needInvite",

  // ── Auth ──────────────────────────────────────────────────────────────────
  "need-password": "errors.needPassword",

  // The public QR actions use a bare `?error=1` as a generic sentinel. Mapped so
  // it resolves to a sentence rather than the digit.
  "1": FALLBACK,

  unknown: FALLBACK,
};

/**
 * Fold every historical spelling of a code onto one lookup key.
 *
 * Handles the three shapes that reach us: slugs (`need-name`), snake case
 * (`wrong_direction`) and the raw English that was put straight in the URL
 * (`Name+is+required`, which arrives here already decoded to `Name is
 * required`). Trailing punctuation is dropped so `Not found.` matches
 * `not-found`.
 */
function normalise(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[+_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Turn whatever arrived in `?error=` into a sentence in the reader's language.
 *
 * Returns `undefined` for an absent code so it drops straight into a `Flash`:
 *
 *   <Flash tone="error" message={errorMessage(sp.error, locale)} />
 */
export function errorMessage(
  code: string | string[] | undefined | null,
  locale: Lang,
): string | undefined {
  if (!code) return undefined;
  const raw = Array.isArray(code) ? code[0] : code;
  if (!raw) return undefined;

  const key = CODE_KEYS[normalise(raw)];
  if (key) return t(key, locale);

  // An unmapped code is a gap in this file, not something to show a farmer.
  // Surface it to the developer without ever putting it on screen.
  if (process.env.NODE_ENV !== "production") {
    console.warn(`[errors] unmapped error code: ${JSON.stringify(raw)} — add it to CODE_KEYS`);
  }
  return t(FALLBACK, locale);
}

/**
 * The same lookup for a success code, so `?saved=1` style flashes are
 * translated by the same route rather than by another ternary chain.
 */
const OK_KEYS: Record<string, string> = {
  "1": "errors.okSaved",
  saved: "errors.okSaved",
  created: "errors.okCreated",
  updated: "errors.okSaved",
  deleted: "errors.okDeleted",
  sent: "errors.okSent",
  added: "errors.okAdded",
};

export function successMessage(
  code: string | string[] | undefined | null,
  locale: Lang,
): string | undefined {
  if (!code) return undefined;
  const raw = Array.isArray(code) ? code[0] : code;
  if (!raw) return undefined;
  return t(OK_KEYS[normalise(raw)] ?? "errors.okSaved", locale);
}

/** Exposed for the test that asserts every code maps to a real key. */
export const ERROR_CODE_KEYS = CODE_KEYS;
