/**
 * The terms and privacy wording, and the one place their version is set.
 *
 * == Why the text lives here and not in the i18n dictionaries =================
 * Every other string in this product is a translation key. These are not, and the reason is
 * that they are a LEGAL INSTRUMENT rather than an interface: a translated clause is a
 * second document that can say something different from the first, and when two versions of
 * a contract disagree the question of which one binds is exactly the question nobody wants
 * to litigate. So the English is authoritative, the Afrikaans summary points at it, and
 * both say so plainly.
 *
 * == The version is a date ====================================================
 * `TERMS_VERSION` is what gets recorded against a sign-up. It is a date because the thing a
 * human asks later is "which wording was live then", and it is exported from one place so
 * the page a visitor reads and the value stored against them cannot drift.
 *
 * == What these clauses are grounded in =======================================
 * Each one describes something the software actually does, and several were written by
 * reading the code rather than the other way round:
 *   · the seven days, the pause and coming back come from `app.farm_billing_gate`,
 *     `billing_settings.access_grace_days` and `app.billing_restore_after_payment`
 *     (20261029090100)
 *   · "nothing is deleted" and the export come from `/api/farm/export`
 *   · the refund position is the founder's decision of 11 September 2026, already written
 *     up in `docs/BILLING.md` §11b
 *   · the 99.5% availability target is the one stated in `docs/BACKUP.md`
 *   · the sub-processor list is the one in `docs/POPIA.md` §5.3, checked against the code
 *     that calls each service (13 November 2026)
 *   · the usage charges come from `docs/AI_USAGE.md` (AI and voice, cost plus a margin, owner
 *     limits on /settings/ai) and `usage_rates` / `usage_for_month` (20261107150000:
 *     WhatsApp messages and storage, invoiced from /admin/usage)
 *   · the cookies are the ones the code sets (`fw_*` by name, Supabase's sign-in cookies by
 *     @supabase/ssr), and the browser storage the ones it reads and writes
 *   · location and its 180 days come from `asset_positions` (20261107120000) and the three
 *     places that ask the browser for a position (faults, driving records, the route recorder)
 * Terms that describe behaviour the product does not have are worse than none, because
 * they are a promise nobody is keeping.
 */

/** The wording currently live. Recorded against every sign-up that accepts it. */
export const TERMS_VERSION = "2026-11-13";

export const COMPANY = {
  legalName: "Rapid Rise AI (Pty) Ltd",
  regNumber: "K2024727338",
  tradingAs: "FLEETWISE",
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
      `FLEETWISE is operated by ${COMPANY.legalName} (registration ${COMPANY.regNumber}), of ${COMPANY.address}. You can reach a person at ${COMPANY.email}.`,
      "In these terms, “we” and “us” mean Rapid Rise AI, and “you” means the business that holds the FLEETWISE account.",
    ],
  },
  {
    heading: "What the service is",
    body: [
      "FLEETWISE is software for keeping track of vehicles and machinery: a register, service scheduling, job cards, faults, costs, fuel, compliance dates and reports.",
      "It is a record-keeping tool. It does not inspect your machines, and it does not decide when something is safe to use. Decisions about your equipment remain yours.",
    ],
  },
  {
    heading: "Who may use FLEETWISE",
    body: [
      "FLEETWISE is for businesses. It is not directed at children.",
      "The person who accepts these terms does so for the business, and must be 18 or older and allowed to act for it.",
    ],
  },
  {
    heading: "What it costs",
    body: [
      "You choose a plan and tell us how many vehicles you want to cover. The price is per vehicle per month and is shown before you pay. Every price we show is the final price, Rapid Rise AI is not a registered VAT vendor, so no VAT is added and our invoices are not tax invoices.",
      "Every subscription covers at least five vehicle slots, so the smallest monthly bill is five times the plan's price per vehicle.",
      "Paying yearly costs ten months instead of twelve.",
      "Done-For-You is remote fleet management that we quote for your fleet in writing. Nothing is charged for it until you accept the quote.",
      "On top of the price per vehicle, the AI help and the voice assistant are charged for as they are used, at what they cost us plus a markup. Your owners can see that use, by person, under Settings, AI, and it is billed on your billing date, on your plan's invoice or on one of its own, which lists who used it. Use through your business's own OpenAI key, if you link one, is paid to OpenAI by you and is not charged by us.",
      "Every business has a monthly limit for AI and voice use. Once you have paid us for the first time, your owners can change it under Settings, AI, and can set a limit for each person as well. Owners are told when 80% of the limit is used and when it is reached; at the limit, voice and AI help pause until the next month or until the limit is raised, and everything else keeps working.",
      "WhatsApp messages we send for your business, and the files you store in FLEETWISE, can also be charged at what they cost us plus a markup. Such a charge comes on an invoice of its own that says how many messages and how much storage it covers.",
      "You pay by card through Paystack. Your card details go to Paystack and never reach our servers; we keep only the last four digits and the card’s expiry, so you can tell which card is on file.",
      "The subscription renews automatically at the end of each period, for the same plan and the same number of vehicle slots, until you cancel. We email a receipt for every payment.",
    ],
  },
  {
    heading: "Changing your plan or your vehicle slots",
    body: [
      "Moving up a plan, or buying more vehicle slots, happens straight away and you pay the difference for the days left in the period you have already paid for.",
      "Moving down a plan, or giving slots back, takes effect at the end of the period you have already paid for. We do not refund the unused part of a period.",
      "You cannot reduce your slots below the number of vehicles you are actually running. Retire or sell a vehicle in FLEETWISE first.",
    ],
  },
  {
    heading: "If a payment fails",
    body: [
      "If a payment is missed, you have seven days to pay. A card on file is tried again during those days, and we let you know each time.",
      "If it is still unpaid after seven days, FLEETWISE is paused for your business until it is paid: you can then only pay and download your records. Nothing is deleted while it is paused.",
      "Paying what is overdue opens it again straight away, and you are not charged for the time it was paused: if what was overdue was the period you are in, that period starts again on the day you pay; if that period was already paid, it is made longer by the days it was paused.",
    ],
  },
  {
    heading: "Cancelling, and coming back",
    body: [
      "You can cancel at any time from the billing screen, without ringing anybody. Cancelling takes effect at the end of the period you have already paid for, unless you ask for it to be immediate. While FLEETWISE is paused for a missed payment, pay what is overdue first, or ask us to close the account.",
      "After a cancelled or unpaid account has been closed, you can reopen it yourself from the screen you land on, and pick up where you left off.",
    ],
  },
  {
    heading: "Refunds",
    body: [
      "There is no refund button, on purpose. A refund is arranged with a person: email us and say what happened.",
      "If you ask for a refund because you no longer want the service, we refund and the subscription ends immediately.",
      "If we refund you because something on our side went wrong, that is on us, you keep your subscription and it carries on as normal.",
    ],
  },
  {
    heading: "Your records stay yours",
    body: [
      "Everything you put into FLEETWISE belongs to you. We do not sell it, and we do not use one customer’s data to do anything for another customer.",
      "You can download your records as a file at any time, including after your account has been closed. Photos, voice notes and uploaded documents are not in that file, ask us and we will get them to you.",
      "We do not delete a closed account’s records as a matter of routine. If you want them deleted, ask, and we will do it and tell you when it is done.",
    ],
  },
  {
    heading: "Using it sensibly",
    body: [
      "Do not use FLEETWISE to break the law, to store somebody else’s personal information without a reason to have it, or to attack or overload the service.",
      "Keep your sign-in details to yourself. Anything done from your account is treated as done by you, so tell us straight away if you think somebody else has got in.",
      "You are responsible for what your own people do in your account, including the drivers and contractors you give access to.",
    ],
  },
  {
    heading: "Availability",
    body: [
      "We aim for 99.5% availability each month, and we take daily backups. That is a target we work to, not a guarantee, and we will sometimes take the service down briefly to fix or improve it.",
      "FLEETWISE keeps working on a phone with no signal for the things a person does in a field, and sends them up when the signal comes back. Not everything works offline, and the app tells you when it does not.",
    ],
  },
  {
    heading: "If something goes wrong",
    body: [
      "If we fail to provide the service properly, tell us and we will fix it, or refund you.",
      "We are not liable for money you lose because of a decision you made using, or despite, the records in FLEETWISE. It is a record-keeping tool, and it is only ever as accurate as what is put into it.",
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
      "For the information your business puts into FLEETWISE about your own people, drivers, mechanics, the staff you invite, YOUR business is the responsible party under POPIA. We are the operator: we hold and process it for you, on your instructions.",
      "For your account itself, who signed up, what you pay, what our support team can see, we are the responsible party.",
    ],
  },
  {
    heading: "What we hold",
    body: [
      "Account and contact details: name, email address, phone number, the business’s name and address, and the role each person has.",
      "What your business records: vehicles, meter readings, services, job cards, faults, costs, fuel, licences and the photos and notes attached to them. Where a person is named, a driver on a usage log, whoever reported a fault, that is personal information too.",
      "Billing: what you were invoiced, what you paid, and the last four digits and expiry of the card. We never see or store a full card number.",
      "Technical: sign-in times, and an audit record of changes including the IP address and rough location (city level) they came from. That rough location is worked out from the IP address, not asked of your device; where FLEETWISE does use a precise location is set out under Location.",
    ],
  },
  {
    heading: "Location",
    body: [
      "FLEETWISE asks your phone or computer where it is only when you tap to share it: to attach a location to a fault report or to a step of a driving record, or to record a route. Your browser asks your permission first, and you can say no.",
      "The map, which we are still testing with businesses we have chosen, keeps a vehicle's positions while a driver records a route with the screen open, or while a vehicle tracker your business has connected sends them. Where a person drove is personal information.",
      "A trip's planned route is compared with the distance driven, and a large difference is pointed out to the business.",
      "Positions are kept for 180 days and then deleted. Your business's owners and managers can see them, a driver sees only their own drives, and Rapid Rise's support staff can see them. If your business closes its account for good, they are deleted with the rest of its records.",
    ],
  },
  {
    heading: "Why we hold it",
    body: [
      "To run the service you are paying for, which is the contract between us.",
      "To take payment and to keep the accounting records the law requires us to keep.",
      "To keep the service secure and to be able to answer “who changed this, and when”, a legitimate interest, and the reason the audit record exists.",
      "Some records we keep because another law says to, even if you ask us to delete them. Traffic-fine records under AARTO are the clearest example.",
    ],
  },
  {
    heading: "Who else touches it",
    body: [
      "Supabase, the database, file storage and sign-in. Hosted in Paris, France.",
      "Vercel, where the application runs. The part of it that reads and writes your records runs in Paris, France.",
      "Paystack, card payments. They see your payment details; we do not.",
      "Resend, the email we send you: receipts, alerts, confirmation links.",
      "Microsoft Azure Speech, if your business uses the voice assistant. It turns what is said into text, and reads replies aloud, in its South Africa North region.",
      "The AI help. When the voice step cannot make out a request, the recording is sent to be heard again; when a question needs an AI answer, its words and the business records needed to answer it (only what the person asking may see) are sent to an AI model. Both go through Vercel's AI Gateway to the company that makes the model: today OpenAI, with Microsoft as the backup for hearing a recording. If your business links its own OpenAI key, they go to OpenAI directly, under your business's own OpenAI account. AI help is on once a person has seen a notice that explains it, and anyone can switch it off.",
      "Mapbox, if your business uses the map. It works out driving routes between a trip's stops; our server sends it only the stops' coordinates.",
      "OpenStreetMap's place search (Nominatim), if your business uses the map. Our server sends it the place names typed into the route planner, and the coordinates of a pin dropped on the map so the place can be named.",
      "OpenFreeMap, which supplies the map pictures if your business uses the map. Your browser fetches them directly, so OpenFreeMap sees your device's IP address and which part of the map is being shown.",
      "Cloudflare Turnstile, when our bot check is switched on. It runs on the sign-in, sign-up and partner application forms to tell people from bots. It reads signals from your browser, such as its IP address and browser details, and may store information in your browser for the check. Cloudflare runs the check for us, and also uses those signals to improve its bot detection.",
      "Meta's WhatsApp Business Platform, if you choose to connect WhatsApp. It handles your WhatsApp number, messages and delivery information so FLEETWISE can receive your requests and send the notifications or replies you selected.",
      "The push service of your browser's maker (Google, Apple, Mozilla or Microsoft), if you turn on notifications on a device. It delivers them to that device. Each message is encrypted before it leaves us, so the push service carries it without being able to read it.",
      "We do not sell your information, and we do not share it with anybody for advertising.",
    ],
  },
  {
    heading: "Optional WhatsApp connection",
    body: [
      "You choose whether to connect your WhatsApp number to your signed-in FLEETWISE account, and whether to enable work notifications, the assistant, or both. We record the verified number, the business it is linked to, consent choices, message text and delivery status to provide those features.",
      "The WhatsApp assistant uses the same account permissions and AI settings as the app. Requests and relevant records can be processed by the configured AI provider to answer you. WhatsApp and AI processing may take place outside South Africa.",
      "Reply STOP or disconnect from Account > WhatsApp to stop the connection. This stops future processing through the link; it does not erase operational records you already created or messages already delivered to WhatsApp.",
      "The scheduled cleanup removes message and reply text from FLEETWISE's WhatsApp delivery queue after 30 days and clears expired conversation context. Delivery identifiers and operational records follow their own retention. You can use the contact details below to request access, correction or deletion.",
    ],
  },
  {
    heading: "Information leaving South Africa",
    body: [
      "Most of the services above run outside South Africa. Your records are stored, and the application runs, in Paris, France. Email, payments, AI help, the map services, the bot check, WhatsApp and notifications to your devices go through companies that may handle the information in other countries.",
      "POPIA allows this where the receiving party is bound to a comparable standard of protection, which is what our agreements with the companies that hold or process your records provide for.",
      "Azure's voice-to-text is deliberately kept in its South Africa North region. AI help can send a recording, the words of a request and the records needed to answer it outside South Africa, and the optional WhatsApp connection can process messages outside South Africa. The notice shown before AI help is first used, and the WhatsApp settings, say so before you use them.",
    ],
  },
  {
    heading: "Cookies and your browser's storage",
    body: [
      "FLEETWISE sets only the cookies it needs to work. There are no advertising or analytics cookies and no third-party trackers; the only script from another company is Cloudflare's bot check, when it is switched on.",
      "Supabase's sign-in cookies (their names start with sb- and contain auth-token) keep you signed in, and are removed when you sign out.",
      "fw_farm remembers which business you are working in, until you sign out. fw_lang remembers the language you chose, and fw_start and fw_tabs your start page and the shortcuts in your phone's bottom bar; those three are kept for a year.",
      "fw_qr_name remembers, on that phone and only on a vehicle's QR code pages, the name a person typed when reporting from it, for a year. Leaving the name empty forgets it.",
      "Two last only minutes: fw_partner_link (ten minutes) holds a contractor's new access link so it can be shown once, and fw_join_sent (fifteen minutes) holds the email address typed on a contractor's join page, so only that person sees where the sign-in link went. fw_support_farm is used only by Rapid Rise's staff, for up to an hour, while they support a business.",
      "Your browser's own storage, on that device only, keeps your theme and text size, which menu groups are open, the filters and views you last used, the guided tour's progress, drafts you have not saved yet, copies of pages for use without signal, and anything captured offline that is waiting to be sent, including a voice note recorded offline, for seven days at most.",
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
