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

See `docs/FLEETWISE_VOICE_WHATSAPP_BILLING_SPEC.md` for the full architecture and `docs/FLEETWISE_BUILD_CHECKLISTS.md` for per-feature checklists.
