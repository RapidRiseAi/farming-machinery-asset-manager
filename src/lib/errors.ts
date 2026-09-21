import { t, type Lang } from "@/lib/i18n";

/**
 * One place that turns an error code into a sentence a person can read.
 *
 * == The problem this solves ================================================
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
 * == The rule ===============================================================
 * `errorMessage()` ALWAYS returns a translated sentence. An unrecognised code
 * yields the generic apology, never the raw code, a person seeing
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
  // == Permission, session, existence ========================================
  forbidden: "errors.forbidden",
  "not-allowed": "errors.forbidden",
  // Emitted as "You+can+invite+manager/mechanic/operator+only", the slashes are
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

  // == Things the person needs to fill in ====================================
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

  // == Values that don't make sense ==========================================
  "invalid-values": "errors.badValues",
  "invalid-status": "errors.badValues",
  "bad-status": "errors.badValues",
  "invalid-type": "errors.badValues",
  "bad-plan": "errors.badValues",
  "wrong-direction": "errors.wrongDirection",
  "save-failed": "errors.saveFailed",

  // == Meter corrections and replacements (20260920100000) ===================
  // The commands refuse in English prose from a migration, so the action turns each
  // refusal into a code rather than putting a Postgres sentence on a farmer's screen.
  "meter-correct-missing": "errors.meterCorrectMissing",
  "meter-correct-failed": "errors.meterCorrectFailed",
  "meter-replace-invalid": "errors.meterReplaceInvalid",
  "meter-replace-failed": "errors.meterReplaceFailed",

  // == Subscription billing ==================================================
  // None of these were mapped, so every refusal on /billing and /admin/billing
  // rendered as the generic apology, including the ones a person can act on
  // ("there is no saved card", "a payment is already in progress"). Several of
  // them are about MONEY, where "Something didn't work" is the least useful
  // sentence available: the first question is always whether they were charged,
  // so each of these answers it.
  "billing-unavailable": "errors.billingUnavailable",
  "billing-site-url-missing": "errors.billingUnavailable",
  // The vehicle ceiling (20260910230000). Three codes rather than one, because the person
  // reading them is different each time: the owner adding a vehicle can buy more slots,
  // the owner importing a sheet needs to know the whole file was refused, and the
  // CONTRACTOR cannot fix it at all and must be told whose limit it is.
  // Self-serve sign-up (20260911120000). A visitor who has not signed in yet reads
  // these, so every one says what to do next rather than what went wrong.
  "signup-email": "errors.signupEmail",
  "signup-password": "errors.signupPassword",
  "signup-name": "errors.signupName",
  "signup-farm": "errors.signupFarm",
  "signup-vehicles": "errors.signupVehicles",
  "signup-too-many": "errors.signupTooMany",
  // The sign-up rate limit (20260918130000). Worded as congestion rather than as an
  // accusation: the overwhelming majority of people who ever see it are sharing an office
  // connection with somebody else who just signed up, not abusing anything.
  "signup-busy": "errors.signupBusy",
  // One sentence for every reason a promo code did not work, unknown, switched off,
  // expired, or all taken. Saying which would tell a stranger trying codes that a
  // particular one exists, and the visitor's next move is the same either way.
  "signup-promo": "errors.signupPromo",
  // Emitted twice by /signup when the posted plan or period is not one we sell. It was
  // never mapped, so the product's own front door answered with the generic apology.
  "signup-plan": "errors.signupPlan",
  "terms-required": "errors.termsRequired",
  // The wording was redeployed between the page loading and the form arriving, so what
  // they ticked is not what we publish. Ask again rather than record the wrong version.
  "terms-stale": "errors.termsStale",
  "billing-not-paid": "errors.billingNotPaid",
  "signup-plan-unavailable": "errors.signupPlanUnavailable",
  // fuel/actions.ts bounces with raw English sentences, `bounce("Enter a tank name")` -
  // which `norm()` turns into these. Unmapped, they fell through to the fallback, so the
  // sentence the author wrote was the one thing nobody read. Mapped here rather than by
  // editing that file, which also makes them translated.
  "enter-a-tank-name": "errors.tankName",
  "enter-a-tank-and-litres": "errors.tankAndLitres",
  "pick-a-tank": "errors.pickTank",
  "signup-failed": "errors.signupFailed",
  // Self-serve plan and slot changes (20260911140000).
  "billing-quota-invalid": "errors.billingQuotaInvalid",
  "billing-quota-below-fleet": "errors.billingQuotaBelowFleet",
  "billing-quota-failed": "errors.billingQuotaFailed",
  "billing-plan-invalid": "errors.billingPlanInvalid",
  "billing-plan-failed": "errors.billingPlanFailed",
  "vehicle-limit-reached": "errors.vehicleLimitReached",
  "vehicle-limit-import": "errors.vehicleLimitImport",
  "vehicle-limit-client": "errors.vehicleLimitClient",
  "billing-no-subscription": "errors.billingNoSubscription",
  "billing-nothing-due": "errors.billingNothingDue",
  "billing-in-flight": "errors.billingInFlight",
  // A lost claim and an in-flight attempt are the same thing to the reader:
  // somebody else is already paying this, wait rather than press again.
  "billing-claim-failed": "errors.billingInFlight",
  "billing-below-minimum": "errors.billingBelowMinimum",
  "billing-no-card": "errors.billingNoCard",
  "billing-no-email": "errors.billingNoEmail",
  "billing-declined": "errors.billingDeclined",
  "billing-mismatch": "errors.billingMismatch",
  "billing-checkout-failed": "errors.billingCheckoutFailed",
  "billing-reconcile-failed": "errors.billingReconcileFailed",
  "billing-already-cancelled": "errors.billingAlreadyCancelled",
  "billing-not-cancelling": "errors.billingNotCancelling",
  "billing-already-subscribed": "errors.billingAlreadySubscribed",
  "billing-bad-plan": "errors.billingBadPlan",
  "billing-bad-period": "errors.billingBadPeriod",
  "billing-bad-trial": "errors.billingBadTrial",
  // A discount is a percentage or an amount, never both (20260920150000). The database
  // refuses it too; this is so the refusal is a sentence rather than a check constraint.
  "billing-discount-both": "errors.billingDiscountBoth",
  "billing-discount-bad": "errors.billingDiscountBad",
  // Driver and operator documents (20260921090000). The database refuses the impossible
  // combinations too, one person or one name, never both, and these turn each refusal
  // into a sentence a farmer can act on instead of a check-constraint name.
  "credential-bad-type": "errors.credentialBadType",
  "credential-two-people": "errors.credentialTwoPeople",
  "credential-no-person": "errors.credentialNoPerson",
  "credential-bad-date": "errors.credentialBadDate",
  "credential-backwards": "errors.credentialBackwards",
  "credential-bad-lead": "errors.credentialBadLead",
  "credential-missing": "errors.credentialMissing",
  "credential-save-failed": "errors.credentialSaveFailed",
  // Accidents and insurance claims (20260921100000). The two "need" codes mirror check
  // constraints the database would otherwise refuse by name: a claim that has been paid
  // carries its amount and its date, or the "still owed by the insurer" total on the same
  // screen would quietly be too small.
  "incident-bad-kind": "errors.incidentBadKind",
  "incident-bad-status": "errors.incidentBadStatus",
  "incident-bad-date": "errors.incidentBadDate",
  "incident-bad-amount": "errors.incidentBadAmount",
  "incident-bad-id": "errors.incidentBadId",
  "incident-need-lodged": "errors.incidentNeedLodged",
  "incident-need-settlement": "errors.incidentNeedSettlement",
  "incident-missing": "errors.incidentMissing",
  "incident-save-failed": "errors.incidentSaveFailed",
  // Book-value policy (20260921110000). "forbidden" is deliberately NOT one of these: the
  // RPC raises 42501 for a role that may not set a policy, and the action maps that to the
  // existing permission sentence rather than inventing a second way to say the same thing.
  "depreciation-missing": "errors.depreciationMissing",
  "depreciation-bad-method": "errors.depreciationBadMethod",
  "depreciation-bad-rate": "errors.depreciationBadRate",
  "depreciation-bad-life": "errors.depreciationBadLife",
  "depreciation-bad-residual": "errors.depreciationBadResidual",
  "depreciation-bad-date": "errors.depreciationBadDate",
  "depreciation-save-failed": "errors.depreciationSaveFailed",
  // Warranty claims (20260921120000). "too-much" and "duplicate" are database refusals
  // turned into the sentence that names what to do: a claim cannot exceed the repair, and
  // one repair carries one live claim.
  "warranty-bad-status": "errors.warrantyBadStatus",
  "warranty-bad-date": "errors.warrantyBadDate",
  "warranty-bad-amount": "errors.warrantyBadAmount",
  "warranty-need-submitted": "errors.warrantyNeedSubmitted",
  "warranty-need-payout": "errors.warrantyNeedPayout",
  "warranty-too-much": "errors.warrantyTooMuch",
  "warranty-duplicate": "errors.warrantyDuplicate",
  "warranty-missing": "errors.warrantyMissing",
  "warranty-save-failed": "errors.warrantySaveFailed",
  // Asking for help (20260921141000). "too-many" is the per-farm ceiling and the only one
  // of these with a next step, so it does not fall through to the generic apology.
  "help-need-subject": "errors.helpNeedSubject",
  "help-need-message": "errors.helpNeedMessage",
  "help-subject-long": "errors.helpSubjectLong",
  "help-message-long": "errors.helpMessageLong",
  "help-too-many": "errors.helpTooMany",
  "help-failed": "errors.helpFailed",
  // Tyres (20260921150000). "not-fitted" is the RPC refusing to take off a tyre that is
  // on nothing, which is a mistake with a next step rather than a failure.
  "tyre-bad-number": "errors.tyreBadNumber",
  "tyre-bad-date": "errors.tyreBadDate",
  "tyre-need-machine": "errors.tyreNeedMachine",
  "tyre-missing": "errors.tyreMissing",
  "tyre-not-fitted": "errors.tyreNotFitted",
  "tyre-save-failed": "errors.tyreSaveFailed",
  "billing-save-failed": "errors.saveFailed",

  // == Somebody's own account (20260911190000) ===============================
  // Until these shipped there was no way for anyone to change their own password or email
  // at all, so there were no codes for it either.
  "name-required": "errors.nameRequired",
  "too-long": "errors.tooLong",
  "password-short": "errors.passwordShort",
  "password-mismatch": "errors.passwordMismatch",
  "password-failed": "errors.passwordFailed",
  "email-unchanged": "errors.emailUnchanged",
  "email-failed": "errors.emailFailed",
  // An operator problem, and the sentence says so, a farmer reading "we could not send"
  // will check their own spelling for something that is entirely ours.
  "email-not-configured": "errors.emailNotConfigured",
  "no-email": "errors.noEmail",
  "more-than-owed": "errors.moreThanOwed",
  "refund-too-big": "errors.refundTooBig",
  "not-an-invoice": "errors.notAnInvoice",

  // == State that blocks the action ==========================================
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

  // == Entitlement ===========================================================
  upgrade: "errors.upgrade",
  "upgrade-required": "errors.upgrade",

  // == Files and import ======================================================
  "logo-format": "errors.logoFormat",
  "logo-too-big": "errors.logoTooBig",
  "receipt": "errors.receipt",
  "no-csv-provided": "errors.noCsv",
  "invalid-csv-header": "errors.badCsvHeader",
  "no-valid-rows": "errors.noValidRows",
  "nothing-valid": "errors.noValidRows",
  "too-many-rows": "errors.tooManyRows",
  "too-many": "errors.tooManyRows",

  // == Purchase orders =======================================================
  // These are emitted in camelCase (`po-needSupplier`), which `normalise`
  // lower-cases WITHOUT inserting a separator, so the lookup key has no hyphen
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

  // == Cross-farm attempts (these are RLS doing its job) =====================
  "you-cannot-record-a-reading-for-that-farm": "errors.wrongFarm",
  "you-cannot-report-a-fault-for-that-farm": "errors.wrongFarm",
  "wrong-farm": "errors.wrongFarm",

  // == Team invites ==========================================================
  "email-name-and-role-required": "errors.needInvite",

  // == Auth ==================================================================
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
    console.warn(`[errors] unmapped error code: ${JSON.stringify(raw)}, add it to CODE_KEYS`);
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
