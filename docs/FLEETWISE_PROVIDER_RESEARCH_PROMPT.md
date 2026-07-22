# Provider-research prompt (paste into ChatGPT / a research model)

Use this to decide the external providers for the three deferred FleetWise features — **voice AI assistant, WhatsApp capture, and billing/payments** — before we wire them. Paste everything inside the horizontal rule into a capable research model (enable web browsing / deep-research mode). Fill in the two bracketed budget/volume blanks first if you can; if not, leave them and the model will assume ranges.

---

**ROLE & GOAL**

You are a senior solutions architect doing vendor due-diligence for a production SaaS. Research and compare providers for three capabilities, then give a costed, defensible recommendation for each. Prioritise **primary sources** (official pricing/docs pages) and note the "as-of" date for every price. Where you are unsure, say so — do not invent numbers.

**PRODUCT CONTEXT (read carefully — it constrains the choices)**

- **Product:** "FleetWise" — a multi-tenant PWA for **South African farms** to manage machinery/vehicles (service scheduling, job cards, faults, fuel, costs, QR field capture). Built on **Next.js (App Router) + TypeScript** on **Vercel**, with **Supabase (Postgres + Auth + Storage)** and row-level-security multi-tenancy.
- **Users:** farm owners, managers, mechanics, operators/drivers, external contractors. Many are **non-technical, rural, on mid-range/low-end Android over patchy 3G**. The app is **offline-first**.
- **Languages:** **English and Afrikaans (af-ZA)** are both first-class and mandatory. Afrikaans support is a hard requirement, not a nice-to-have — this is the single biggest filter for the voice provider.
- **Currency & region:** billing is in **ZAR (South African Rand)**; the business is a South African company. Data-residency/POPIA considerations matter.
- **Scale assumptions:** target **[FILL IN: e.g. 200 farms / 5,000 vehicles / 20,000 users in year 1]**, growing. Expect spiky load (mornings, season starts). Assume **thousands of assets per org** at the top end.
- **Budget posture:** **[FILL IN: e.g. bootstrapped, want low fixed cost + usage-based; or funded, willing to pre-commit for volume discounts]**.

**WHAT TO RESEARCH — THREE TRACKS**

**Track A — Voice AI assistant (EN + Afrikaans, hands-free logging & queries)**
The feature: a farmer speaks (in English or Afrikaans) to log a service/fault or query an asset's status; the assistant confirms the parsed action and asks for missing details before committing; it must respect the same permissions/validation as manual entry and fall back to manual on failure/offline. This needs **speech-to-text (STT)**, **intent/slot understanding (NLU/LLM)**, and optionally **text-to-speech (TTS)** for confirmations.
Compare at least: **OpenAI (Realtime API / Whisper + GPT), Google Cloud Speech-to-Text + Vertex, Microsoft Azure AI Speech, Deepgram, AssemblyAI, ElevenLabs (STT/TTS), the browser-native Web Speech API, self-hosted Whisper (e.g. faster-whisper on our own GPU), and voice-agent orchestration platforms (Vapi, Retell AI, Bland).**
Critical questions:
- **Afrikaans (af-ZA) support and accuracy** for STT and TTS — which providers genuinely support it, and how good is it? This likely eliminates several options — call that out explicitly.
- **Custom-build viability:** is it viable/cost-effective to build our own voice agent (e.g. self-hosted Whisper for STT + our existing LLM for intent + a TTS engine), versus buying a managed voice platform? Give the trade-offs: engineering effort, ops burden, latency, per-minute cost at scale, Afrikaans quality, and where the break-even volume is.
- Latency on poor mobile networks; offline/on-device options; streaming vs batch.
- Per-minute / per-character / per-request pricing, free tiers, and monthly cost at our assumed volume.

**Track B — WhatsApp capture & notifications (BSP)**
The feature: users log a service/fault **via WhatsApp** (resolving to the right asset + user), and receive service-due/overdue reminders and confirmations over WhatsApp that tie back to the same records. Needs the **WhatsApp Business Platform** via Meta directly or a **BSP**.
Compare at least: **Meta WhatsApp Cloud API (direct), Twilio, 360dialog, Bird (MessageBird), Vonage, Gupshup, Infobip, WATI.**
Critical questions:
- Pricing model under Meta's **conversation/per-message** billing (note the 2025+ per-message template changes) — total cost at our assumed message volume, including any BSP markup or monthly platform fee.
- **South Africa** availability, local number support, and any data-residency options.
- Template message management, opt-in handling, and **inbound webhook** ergonomics (we need to parse inbound messages into records).
- Scalability / rate limits / messaging tier ramp-up; reliability/SLA.
- Developer experience with a Next.js/Node webhook and a Postgres backend.

**Track C — Billing & subscriptions (per-vehicle-per-month, ZAR)**
The feature: **per-vehicle-per-month** subscription billing with **unlimited users**, **four tiers** (Essential/Professional/Complete/Done-For-You), **annual pre-pay (2 months free)**, asset-count-based (metered) pricing, and easy export/no lock-in on cancel. Must gate feature entitlements by plan.
Compare at least: **Stripe Billing, Paddle, Chargebee, Lemon Squeezy, and South-African-local options — Paystack, Peach Payments, Yoco, PayFast, Ozow.**
Critical questions:
- **ZAR support** and South African card/EFT/debit-order coverage (debit orders matter for rural SMB retention).
- **Usage/metered & per-seat(per-vehicle) subscription** support, proration, tier changes, annual pre-pay, dunning.
- Fees (% + fixed per transaction, plus any platform %), payout timing to a SA bank.
- Tax/VAT handling for SA; merchant-of-record vs gateway (Paddle/Lemon Squeezy are MoR — weigh the compliance offload vs cost).
- API/webhook quality for driving entitlement state in our Postgres; PCI scope.

**COMPARISON DIMENSIONS (apply to every option, every track)**

For each candidate produce a row scoring: **Price** (concrete numbers at our volume, as-of date) · **Customizability** (how much control/branding/flexibility) · **Scalability** (headroom to grow) · **Ability to handle load** (rate limits, burst behaviour, SLA/uptime) · **Afrikaans/SA-fit** (language + regional suitability) · **Integration effort** (with Next.js/Vercel + Supabase/Postgres) · **Lock-in / exit cost** · **Overall viability**.

**DELIVERABLES (format your answer exactly like this)**

1. **Executive summary** — one recommended provider per track + one-line why, plus the single biggest risk of each.
2. **Three comparison tables** (one per track), one row per candidate, columns = the dimensions above, with concrete prices and an as-of date.
3. **Voice deep-dive** — an explicit build-vs-buy recommendation with a rough cost model at low / medium / high volume, an Afrikaans-quality verdict per option, and the break-even point between self-hosted and managed.
4. **Total cost of ownership** — estimated blended monthly cost across all three at our assumed scale, low/expected/high.
5. **Migration/lock-in notes** — how hard it is to switch away from each recommended provider later.
6. **Open questions** — anything you'd need from us (exact volumes, budget ceiling, data-residency stance) to firm up the recommendation.

Cite primary sources with links and dates. Flag any figure you're estimating rather than quoting.

---

*After ChatGPT returns this, drop its recommendations back into the FleetWise session and I'll brief the voice / WhatsApp / billing build agents against the chosen providers.*
