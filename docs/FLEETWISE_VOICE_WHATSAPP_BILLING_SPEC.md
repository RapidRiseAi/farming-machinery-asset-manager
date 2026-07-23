# FleetWise — Voice AI · WhatsApp · Billing (provider-confirmed build spec)

> Source: founder-supplied research/build spec (post provider-research). This is the authoritative design for the three features that were parked pending provider selection. Build them in upcoming waves, **adapted to this codebase's schema** (see the mapping note first).

## ⚠️ Codebase adaptation note (READ BEFORE BUILDING)

The spec below was written against a generic schema. **Map it onto FleetWise's actual tables** — do NOT create `organizations`/`assets`/`profiles`:

| Spec term | This codebase |
|---|---|
| `organizations` / `org_id` | `farms` / `farm_id` |
| `org_members` (+ `contractor` role) | `users` (roles owner/manager/mechanic/operator/workshop) + `workshop_links` |
| `assets` / `asset_id` | `machines` / `machine_id` |
| `profiles` | `users` |
| `service_records` / `service_schedules` | `job_cards` + `service_plan_lines` |
| `costs` | `cost_entries` (F1) |
| `parts` / `service_kits` | (parts catalogue / service kits — F-kits, not yet built) |
| generic RLS "caller's org" | existing `app.has_farm_access(farm_id)` + FORCE RLS + audit trigger + soft-delete |

All new tables keep the house rules (see `docs/FLEETWISE_BUILD_CHECKLISTS.md §G`): `farm_id` + composite FK, enable+force RLS, `app.has_farm_access` policies, `app_audit()` trigger, soft-delete, money = ex-VAT integer cents, SECURITY DEFINER funcs revoked from public/anon/authenticated, `anon` zero DB access, i18n EN/AF parity.

## Confirmed stack

| Layer | Choice | Notes |
|---|---|---|
| STT + TTS | **Azure AI Speech** (South Africa North) | Only vendor with real af-ZA neural voices (Adri, Willem) + af-ZA STT + Custom Speech path. Batch $0.18/hr, fast $0.36/hr. |
| LLM | Any general API model behind an adapter | Intent parsing + RAG answers only. |
| WhatsApp | **Meta Cloud API direct** | No BSP markup; Node webhook → Postgres. |
| Payments | **Paystack** (cards, 2.9% + R1, T+1) | Stripe does NOT support SA-registered businesses. Add Netcash/Stitch **DebiCheck** at ~50+ paying farms (Phase 3). |
| Vector search | **pgvector in Supabase** | No Pinecone/Weaviate — small corpus. |
| Errors | Sentry free tier | |

**Wrap every external AI/payment call in a one-file adapter** (`transcribe()`, `synthesize()`, `parseIntent()`, payment gateway). Vendor swap must be a one-file change.

## Architectural non-negotiables

1. **Never embed live operational data.** Assets/services/costs/faults are queried by SQL tool-calls. Vector search is for unstructured docs only.
2. **Structured reference data lives in tables, not documents.** Part-number lookup = deterministic indexed query, never similarity match.
3. **The AI never writes directly.** It proposes a validated tool call → user confirms → write goes through the same RLS + validators as manual entry.
4. **Subscription state lives in Postgres**, not the gateway. The gateway only moves money → every provider stays swappable.
5. **Use Supabase's connection pooler from day one** (serverless + Postgres exhausts connections otherwise).
6. **Uploads (audio, photos) go direct to Supabase Storage**, never through Vercel functions.
7. **Scheduled jobs** use Vercel Cron or `pg_cron` — not long-running Vercel functions.

## Feature A — Voice AI (Azure Speech + adapter LLM)

**Three-tier routing** (target 70–80% resolved at Tier 0/1):
- **Tier 0** — top ~20 commands/queries matched by local grammar (EN+AF) against synced data, on-device, offline, <100ms, no LLM. Reads answer instantly.
- **Tier 1** — deterministic intent + SQL tool call, server, 200–500ms, no LLM.
- **Tier 2** — ambiguous/multi-step/KB questions, server, 1–3s, LLM with strict tool schema.

**Pipeline:** push-to-talk (never auto-listen) → Tier 0 attempt → queue into the **existing F2 offline sync queue** if offline/unmatched ("Captured ✓") → on reconnect upload audio to Azure STT **with a per-tenant phrase list** (asset names, aliases, service-kit terms, part numbers — free, biggest accuracy lever) → fuzzy entity resolution against `machines` + `asset_aliases` via `pg_trgm` (highest-value custom code) → deterministic intent parse, LLM only if needed → **confirmation card (never auto-commit)** → commit through the normal validated RLS path → log to `ai_interactions`.

**Tool schema** (each validates args + runs under caller's permissions, reusing existing server actions):
`log_service`, `report_fault`, `update_asset_status`, `query_asset_status`, `query_service_due`, `query_costs`, `query_knowledge_base` (hybrid RAG over `kb_chunks`).

**Afrikaans quality levers (in order):** (1) per-request phrase lists; (2) fuzzy entity resolution in our code; (3) LLM post-correction with the tenant's asset list; (4) Azure Custom Speech = last resort (per-model hosting fee ~R650/mo). **Build a 200–500 utterance AF eval set before shipping.**

**TTS:** Azure af-ZA voice for confirmations; fix part-number/brand pronunciation via SSML/custom lexicon (verify af-ZA voices support custom lexicon). **Prefer on-screen confirmation cards over speech** (visual beats audio next to a diesel engine).

**New tables** (adapt org_id→farm_id, asset_id→machine_id): `asset_aliases` (alias + `gin_trgm_ops` index — the accuracy key), `voice_captures` (utterance lifecycle, ties into the sync queue), `ai_interactions` (eval/finetune log — log everything from day one), `kb_documents` + `kb_chunks` (pgvector + tsvector, hybrid retrieval with reciprocal-rank fusion).

## Feature B — WhatsApp (Meta Cloud API direct)

**Cost model (design around it):** Meta bills per delivered template since 1 Jul 2025. Service messages inside an open 24h window = **free unlimited**; utility templates inside window = free; utility outside window (SA) ~R0.15–0.40; marketing (SA) ~R1.50. **Strategy:** users message first (opens window) to log faults; reminders are *utility*; before dispatching from the queue, check `whatsapp_contacts.last_inbound_at` — within 24h → free. **Never use marketing templates for operational notifications.**

**Implementation:** webhook `app/api/whatsapp/webhook/route.ts` — verify Meta signature, **return 200 fast**, enqueue + process async. Idempotency on `wa_message_id` (Meta redelivers). Inbound: resolve `phone_e164` → contact → farm → user, then the **same entity-resolution + intent pipeline as voice** (WhatsApp text is just another input channel; voice notes → same STT path). Media → download from Meta → Supabase Storage. Outbound: template registry, log every send with category + billable flag. Opt-in recorded with timestamp (POPIA + Meta require it). **Start Meta business verification + display-name + template approval NOW** (slow; common launch blocker).

**New tables:** `whatsapp_contacts` (phone_e164 unique, opted_in, `last_inbound_at`), `whatsapp_messages` (direction, `wa_message_id` unique, parsed_intent, linked_record_type/id), `notification_queue` (reminders wait for a free window or deadline). Reuse the existing `notifications` engine where possible; this queue is the WhatsApp-dispatch layer on top.

## Feature C — Billing (Paystack) — extends F5's entitlement framework

**Model:** per-asset per-month, unlimited users, no lock-in. Four tiers **Essential R44 · Professional R73 · Complete R89 (push this) · Done-For-You R250**. Annual pre-pay = 2 months free. Vehicle counts are guidance; **features gate tiers**, not asset caps (this is exactly F5's entitlement map).

**Engine (in-house — do not buy Chargebee):** nightly `pg_cron`/Vercel-Cron job counts active assets/farm → `asset_counts`; period-close × `price_per_asset` → `invoices` + `invoice_lines`; apply SA VAT; charge via Paystack stored auth code; dunning (retry + WhatsApp/email reminders + grace → downgrade, **never hard-delete**); entitlements resolved from `plan_features` and enforced **server-side** (F5); affiliate commission on each successful payment (10/20/20/25% months 1–3, then 5%/10%; clock starts on **first successful payment**; reverse on refund/cancel-in-period).

**New tables:** `subscriptions`, `asset_counts`, `plan_features`, `invoices`, `invoice_lines`, `payment_methods`, `payments`, `affiliates`, `affiliate_commissions`. **Phase 2:** Netcash/Stitch DebiCheck as primary rail past ~50 farms (card churn is the main rural-SMB retention leak). Keep cards for contractors/self-service.

## Build order (per spec)

- **Phase 1 (launch):** offline sync queue ✅(F2) → hours+km+time scheduling ✅(existing) → tool/validation layer + confirmation UI → typed input first, voice second → WhatsApp webhook + inbound parsing → billing engine + Paystack → entitlements ✅(F5 in progress).
- **Phase 2:** voice STT + phrase lists + entity resolution → TTS → notification queue with window checking → RAG over `kb_chunks` → affiliate tracking.
- **Phase 3:** DebiCheck → Capacitor mobile build → Custom Speech (only if evals justify) → Dockerised self-hosted SKU.

**Ship the tool layer + confirmation UI with typed input first**, so voice is an input method on top of something already working — if AF accuracy disappoints, it degrades gracefully.

## Open decisions needed from the founder (tracked)

1. **Tier prices VAT-inclusive or exclusive?** (billing — repricing post-launch is costly; decide before the billing agent runs). → see `FLEETWISE_FOUNDER_DECISIONS.md`
2. **POPIA:** cross-border AI processing acceptable, or SA-region only? (voice/LLM adapter region).
3. Expected voice interactions per farm per month (AI cost modelling).
4. Must voice work with zero connectivity, or is queue-and-sync acceptable? (Default assumed: **queue-and-sync**, reusing F2.)
5. Confirm Azure **STT** availability in South Africa North (TTS endpoint confirmed).
6. Written quotes: Netcash/Stitch per-debit fees; Paystack SA recurring/mandate capability.
