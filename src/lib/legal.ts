/**
 * The terms and privacy wording, and the one place their version is set.
 *
 * ── Why the text lives here and not in the i18n dictionaries ─────────────────
 * Every other string in this product is a translation key. These are not, and the reason is
 * that they are a LEGAL INSTRUMENT rather than an interface: a translated clause is a
 * second document that can say something different from the first, and when two versions of
 * a contract disagree the question of which one binds is exactly the question nobody wants
 * to litigate. So the English is authoritative, the Afrikaans summary points at it, and
 * both say so plainly.
 *
 * ── The version is a date ────────────────────────────────────────────────────
 * `TERMS_VERSION` is what gets recorded against a sign-up. It is a date because the thing a
 * human asks later is "which wording was live then", and it is exported from one place so
 * the page a visitor reads and the value stored against them cannot drift.
 *
 * ── What these clauses are grounded in ───────────────────────────────────────
 * Each one describes something the software actually does, and several were written by
 * reading the code rather than the other way round:
 *   · the lapse window and the closed state come from `app.farm_billing_gate` and
 *     `billing_settings.lapsed_grace_days`
 *   · "nothing is deleted" and the export come from `/api/farm/export`
 *   · the refund position is the founder's decision of 11 September 2026, already written
 *     up in `docs/BILLING.md` §11b
 *   · the 99.5% availability target is the one stated in `docs/BACKUP.md`
 *   · the sub-processor list is the one in `docs/POPIA.md`
 * Terms that describe behaviour the product does not have are worse than none, because
 * they are a promise nobody is keeping.
 */

/** The wording currently live. Recorded against every sign-up that accepts it. */
export const TERMS_VERSION = "2026-09-11";

export const COMPANY = {
  legalName: "Rapid Rise AI (Pty) Ltd",
  regNumber: "K2024727338",
  tradingAs: "FleetWise",
  address: "363 Cradock Ave, Centurion, Gauteng, South Africa",
  email: "team@rapidriseai.com",
  /** Rapid Rise is not a registered VAT vendor; every price is a final price. */
  vatRegistered: false,
} as const;

export type Clause = { heading: string; body: string[] };

export const TERMS: Clause[] = [
  {
    heading: "Who you are contracting with",
    body: [
      `FleetWise is operated by ${COMPANY.legalName} (registration ${COMPANY.regNumber}), of ${COMPANY.address}. You can reach a person at ${COMPANY.email}.`,
      "In these terms, “we” and “us” mean Rapid Rise AI, and “you” means the farm or business that holds the FleetWise account.",
    ],
  },
  {
    heading: "What the service is",
    body: [
      "FleetWise is software for keeping track of farm vehicles and machinery: a register, service scheduling, job cards, faults, costs, fuel, compliance dates and reports.",
      "It is a record-keeping tool. It does not inspect your machines, and it does not decide when something is safe to use. Decisions about your equipment remain yours.",
    ],
  },
  {
    heading: "What it costs",
    body: [
      "You choose a plan and tell us how many vehicles you want to cover. The price is per vehicle per month and is shown before you pay. Every price we show is the final price — Rapid Rise AI is not a registered VAT vendor, so no VAT is added and our invoices are not tax invoices.",
      "Paying yearly costs ten months instead of twelve.",
      "You pay by card through Paystack. Your card details go to Paystack and never reach our servers; we keep only the last four digits and the card’s expiry, so you can tell which card is on file.",
      "The subscription renews automatically at the end of each period, for the same plan and the same number of vehicle slots, until you cancel. We email a receipt for every payment.",
    ],
  },
  {
    heading: "Changing your plan or your vehicle slots",
    body: [
      "Moving up a plan, or buying more vehicle slots, happens straight away and you pay the difference for the days left in the period you have already paid for.",
      "Moving down a plan, or giving slots back, takes effect at the end of the period you have already paid for. We do not refund the unused part of a period.",
      "You cannot reduce your slots below the number of vehicles you are actually running. Retire or sell a vehicle in FleetWise first.",
    ],
  },
  {
    heading: "If a payment fails",
    body: [
      "We try the card again a few times over the following days and email you each time. If it still has not gone through, your plan is reduced for a while rather than switched off, and paying restores it exactly as it was.",
      "If the account stays unpaid beyond that, we close it. Closing means you can no longer use FleetWise — it does not mean your records are deleted.",
    ],
  },
  {
    heading: "Cancelling, and coming back",
    body: [
      "You can cancel at any time from the billing screen, without ringing anybody. Cancelling takes effect at the end of the period you have already paid for, unless you ask for it to be immediate.",
      "After a cancelled or unpaid account has been closed, you can reopen it yourself from the screen you land on, and pick up where you left off.",
    ],
  },
  {
    heading: "Refunds",
    body: [
      "There is no refund button, on purpose. A refund is arranged with a person: email us and say what happened.",
      "If you ask for a refund because you no longer want the service, we refund and the subscription ends immediately.",
      "If we refund you because something on our side went wrong, that is on us — you keep your subscription and it carries on as normal.",
    ],
  },
  {
    heading: "Your records stay yours",
    body: [
      "Everything you put into FleetWise belongs to you. We do not sell it, and we do not use one farm’s data to do anything for another farm.",
      "You can download your records as a file at any time, including after your account has been closed. Photos, voice notes and uploaded documents are not in that file — ask us and we will get them to you.",
      "We do not delete a closed account’s records as a matter of routine. If you want them deleted, ask, and we will do it and tell you when it is done.",
    ],
  },
  {
    heading: "Using it sensibly",
    body: [
      "Do not use FleetWise to break the law, to store somebody else’s personal information without a reason to have it, or to attack or overload the service.",
      "Keep your sign-in details to yourself. Anything done from your account is treated as done by you, so tell us straight away if you think somebody else has got in.",
      "You are responsible for what your own people do in your account, including the drivers and contractors you give access to.",
    ],
  },
  {
    heading: "Availability",
    body: [
      "We aim for 99.5% availability each month, and we take daily backups. That is a target we work to, not a guarantee, and we will sometimes take the service down briefly to fix or improve it.",
      "FleetWise keeps working on a phone with no signal for the things a person does in a field, and sends them up when the signal comes back. Not everything works offline, and the app tells you when it does not.",
    ],
  },
  {
    heading: "If something goes wrong",
    body: [
      "If we fail to provide the service properly, tell us and we will fix it, or refund you.",
      "We are not liable for money you lose because of a decision you made using — or despite — the records in FleetWise. It is a record-keeping tool, and it is only ever as accurate as what is put into it.",
      "Nothing in these terms takes away rights you have under the Consumer Protection Act or any other law that applies to you.",
    ],
  },
  {
    heading: "Changing these terms",
    body: [
      "If we change anything that matters to you, we will email you before it takes effect, and you can cancel if you do not want to carry on.",
      "The version of these terms you agreed to is recorded against your account, with the date.",
    ],
  },
  {
    heading: "Which law applies",
    body: [
      "South African law applies, and the South African courts have jurisdiction.",
      "If any part of these terms turns out to be unenforceable, the rest still stands.",
    ],
  },
];

export const PRIVACY: Clause[] = [
  {
    heading: "Who is responsible for what",
    body: [
      "For the information your farm puts into FleetWise about your own people — drivers, mechanics, the staff you invite — YOUR farm is the responsible party under POPIA. We are the operator: we hold and process it for you, on your instructions.",
      "For your account itself — who signed up, what you pay, what our support team can see — we are the responsible party.",
    ],
  },
  {
    heading: "What we hold",
    body: [
      "Account and contact details: name, email address, phone number, the farm’s name and address, and the role each person has.",
      "What your farm records: vehicles, meter readings, services, job cards, faults, costs, fuel, licences and the photos and notes attached to them. Where a person is named — a driver on a usage log, whoever reported a fault — that is personal information too.",
      "Billing: what you were invoiced, what you paid, and the last four digits and expiry of the card. We never see or store a full card number.",
      "Technical: sign-in times, and an audit record of changes including the IP address and rough location (city level) they came from. Never precise location — we do not ask your browser where you are.",
    ],
  },
  {
    heading: "Why we hold it",
    body: [
      "To run the service you are paying for, which is the contract between us.",
      "To take payment and to keep the accounting records the law requires us to keep.",
      "To keep the service secure and to be able to answer “who changed this, and when” — a legitimate interest, and the reason the audit record exists.",
      "Some records we keep because another law says to, even if you ask us to delete them. Traffic-fine records under AARTO are the clearest example.",
    ],
  },
  {
    heading: "Who else touches it",
    body: [
      "Supabase — the database, file storage and sign-in. Hosted in the EU.",
      "Vercel — where the application runs.",
      "Paystack — card payments. They see your payment details; we do not.",
      "Resend — the email we send you: receipts, alerts, confirmation links.",
      "If your farm turns on the optional voice assistant, Microsoft Azure Speech processes what is said, using the South Africa North region. A further optional step can send transcript TEXT to a language model outside South Africa, and that one only ever runs if the person has explicitly agreed to it and can be switched off again at any time.",
      "We do not sell your information, and we do not share it with anybody for advertising.",
    ],
  },
  {
    heading: "Information leaving South Africa",
    body: [
      "Some of the services above run outside South Africa. POPIA allows this where the receiving party is bound to a comparable standard of protection, which is what our agreements with them provide for.",
      "The voice-to-text step is deliberately kept in the South Africa North region. The optional language-model step is the only part that requires a person’s explicit agreement first, because it is the only part that sends text abroad without needing to.",
    ],
  },
  {
    heading: "How long we keep it",
    body: [
      "For as long as your account is open, and after it closes we keep your records rather than deleting them, so that you can come back or ask for a copy.",
      "Ask us to delete a person’s information and we will anonymise it: the name, email and phone number go, and the structural record of what happened stays, because removing it would falsify the history of a machine.",
      "Records another law requires us to keep are kept for as long as that law says.",
      "Backups roll forward on their own schedule, so a deletion works through them as the window moves rather than instantly.",
    ],
  },
  {
    heading: "Your rights",
    body: [
      "You can ask what we hold about you, ask for a copy, ask us to correct it, and ask us to delete it. An owner or manager can do the first and the last from the Team screen without asking us.",
      "You can object to how we are using it, and you can complain to the Information Regulator of South Africa.",
      `To ask us anything about this, email ${COMPANY.email}.`,
    ],
  },
  {
    heading: "If something goes wrong",
    body: [
      "If personal information is accessed by somebody who should not have it, we will tell the Information Regulator and the people affected, as POPIA requires.",
    ],
  },
];
