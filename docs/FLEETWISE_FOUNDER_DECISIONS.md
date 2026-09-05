# FleetWise — Founder decisions (authoritative)

Decisions made by the founder that bind the build. Agents building Billing, Voice, and WhatsApp MUST follow these.

| # | Decision | Answer | Implication for the build |
|---|---|---|---|
| 1 | **Tier prices VAT-inclusive or exclusive?** | **VAT-INCLUSIVE** | Essential R44 / Professional R73 / Complete R89 / Done-For-You R250 **include** 15% VAT. Displayed price = price paid. Billing derives ex-VAT subtotal + VAT from the inclusive total (reuse `exVatCents`/`vatOfInclCents` in `src/lib/money.ts`). Invoices show ex-VAT subtotal, VAT amount, and the inclusive total. Store money ex-VAT cents as usual. |
| 2 | **POPIA — cross-border AI processing?** | **CROSS-BORDER OK** (with user consent + a DPA) | LLM intent-parsing / RAG may call any-region providers behind the adapter. Capture explicit consent + keep a DPA on file. **Azure Speech still runs in South Africa North** regardless. Record consent per user (tie to the existing opt-in/consent pattern). |
| 3 | **Voice offline requirement?** | **QUEUE-AND-SYNC** (reuse F2) | No native/on-device speech required now. Push-to-talk captures offline, Tier-0 local grammar answers simple reads instantly, everything else enqueues in the existing F2 IndexedDB sync queue and transcribes on reconnect. Native/Capacitor + on-device models stay a later phase. |

## Still open (not blocking Phase-1 build; defaults noted)

| # | Item | Default / action |
|---|---|---|
| 4 | Expected voice interactions per farm/month | Unknown — used only for cost modelling, not the build. Instrument `ai_interactions` from day one so real volume is measured. |
| 5 | Confirm Azure **STT** in South Africa North | Verification task at deploy; TTS endpoint already confirmed. Adapter is region-configurable via env. |
| 6 | Netcash/Stitch DebiCheck + Paystack recurring quotes | Phase-3 concern (DebiCheck past ~50 paying farms). Phase-1 uses Paystack cards. |
| 7 | **Which price table is real?** ⚠️ **BLOCKS CHARGING** | **UNRESOLVED — decision #1 above and the shipped code disagree.** Decision #1 says Essential **R44** / Professional **R73** / Complete **R89** / Done-For-You **R250**. Shipped `src/lib/entitlements.ts` displays Essential **R39** / Professional **R69** / Complete **R99** / Done-For-You **POA**. Both are stated as VAT-inclusive, so only the numbers are in dispute. The billing system is built and versioned around this, and `billing_price_versions` deliberately ships **EMPTY**: with no `active` price version the invoice generator raises nothing, so nothing can be charged by accident. Confirming the table is a single INSERT. **Nothing is charged until it is confirmed.** |
| 8 | **Is Rapid Rise VAT-registered?** | **NO** (stated 3 Sep 2026) `billing_settings.vat_registered` is false, so a trigger forces every invoice to a 0% rate with a null VAT number, no VAT line is shown, and invoices are correctly **not** headed "Tax invoice" (VAT Act s20(4)). The full VAT machinery is built anyway: registering later is one flag flip and restates **no** historical invoice. |
| 9 | **Dunning / lifecycle policy** | **PROPOSED — awaiting sign-off** Trial **14 days**; retries at **3, 7 and 14 days** after the first failure; **7-day grace** with full access retained; then the EFFECTIVE plan drops to **Essential** while the commercial plan is kept and **nothing is deleted**; cancellation takes effect at **period end**; mid-term annual asset additions are **not** pro-rated. All nine values live in the single audited `billing_settings` row, so changing one is a decision somebody makes and the audit log records, not a deploy. Built and tested at these values — confirm or amend before charging is enabled. |

See `docs/FLEETWISE_VOICE_WHATSAPP_BILLING_SPEC.md` for the full architecture and `docs/FLEETWISE_BUILD_CHECKLISTS.md` for per-feature checklists.
