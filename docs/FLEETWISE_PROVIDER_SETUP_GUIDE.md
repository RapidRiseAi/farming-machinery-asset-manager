# FleetWise — Manual setup guide for the provider-dependent features

**Read this when we're ready to turn on Voice AI, WhatsApp, and Billing.** These three features need external accounts, approvals, and secret keys that only a human with company/billing/identity access can obtain. This guide lists **exactly what you must do and get**, in order, with the env-var names the code will expect. Nothing here is built yet — the code goes in only after these exist.

Each section separates:
- **🔧 What we build in code** (no action from you), and
- **✅ What YOU must set up / obtain** (action + the secret to hand back).

> ⏱️ **Start the slow ones first.** Meta WhatsApp business verification + display-name + template approval and Azure resource provisioning take days. Paystack live activation needs company docs. Kick these off well before you want the features live.

---

## 0. Infrastructure prerequisites (needed for production regardless of the 3 features)

**✅ You set up / obtain:**
1. **Vercel Pro** (~$20/mo) — Hobby is non-commercial; Pro is required at launch. Upgrade the project's team to Pro.
2. **Supabase Pro** (~$25/mo) — Free tier auto-pauses + has no daily backups. Upgrade the project. Then, in Project Settings:
   - Turn on **daily backups** (or Point-in-Time Recovery).
   - Copy the **connection pooler** connection string (Transaction mode) — serverless + Postgres must use the pooler. Env: `DATABASE_URL` (pooler), `DIRECT_URL` (direct, migrations only).
   - Enable the optional **leaked-password protection** in Auth.
3. **Sentry** (free tier) — create a project; copy the DSN. Env: `SENTRY_DSN`.
4. **Web Push (VAPID) keys** — self-hosted, no third party. Generate a keypair (`npx web-push generate-vapid-keys`). Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` you own). *(These power the F6 push notifications already in the base product.)*
5. **Cron secret** — set `CRON_SECRET` in Vercel so the nightly cron route authenticates (see `docs/CRON.md`), and add the Vercel Cron schedule.

---

## 1. Feature C — Billing (Paystack) 💳

**🔧 What we build in code:** the whole billing engine in-house — nightly `asset_counts`, period-close → `invoices`/`invoice_lines`, SA-VAT (prices are **VAT-inclusive** per your decision), dunning, entitlement gating (F5), affiliate commissions — with Paystack behind a one-file adapter (`src/lib/billing/*`). Subscription state lives in our Postgres, not Paystack.

**✅ You set up / obtain:**
1. **Register a Paystack account** at paystack.com as the **South African** business (Paystack supports SA-registered businesses; Stripe does not).
2. **Activate live mode** — submit company registration (CIPC), bank account, and director ID. This is a review; do it early.
3. **Get API keys** (Settings → API Keys & Webhooks), both test and live:
   - `PAYSTACK_SECRET_KEY` (server only — never expose)
   - `PAYSTACK_PUBLIC_KEY`
4. **Create a webhook** pointing at `https://<your-domain>/api/billing/paystack/webhook` and copy the signing secret → `PAYSTACK_WEBHOOK_SECRET`. (We verify every event's signature.)
5. **Confirm recurring capability** — verify with Paystack support that **card authorization codes** (charge-authorization / recurring) are enabled on your account for subscription re-charges.
6. **VAT registration** — decide/confirm your SA VAT number and when you cross the R1m threshold; prices are VAT-inclusive, so invoices must show the VAT breakdown. Hand us the **VAT number** + rate.
7. *(Phase 3, later — past ~50 paying farms)* Request **written quotes** from **Netcash** and **Stitch** for **DebiCheck** debit-order per-transaction fees; that becomes the primary rail then (cards stay for contractors/self-service).

**Hand back:** `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_WEBHOOK_SECRET`, VAT number.

---

## 2. Feature B — WhatsApp (Meta Cloud API direct) 💬

**🔧 What we build in code:** the webhook (`/api/whatsapp/webhook`, signature-verified, returns 200 fast, idempotent on `wa_message_id`), inbound parsing that reuses the same entity-resolution + intent pipeline as voice, media → Supabase Storage, a template registry, and a free-24h-window-aware dispatcher on top of the notification queue.

**✅ You set up / obtain (START THIS FIRST — approvals take days):**
1. **Meta Business account** — create/verify your business at business.facebook.com. **Business verification** requires company documents; start now.
2. **WhatsApp Business Platform app** — in developers.facebook.com, create an app, add the **WhatsApp** product.
3. **Phone number** — add a business phone number (a new one, not tied to a personal WhatsApp). Complete verification.
4. **Display name approval** — submit your business display name (e.g. "FleetWise") for Meta review.
5. **Message template approval** — submit the utility templates we'll need (service-due, overdue, fault-logged confirmation) for review. Approval is per template and can take a day+ each.
6. **Permanent access token** — create a **System User** with a permanent token (temporary tokens expire in 24h). Copy:
   - `WHATSAPP_ACCESS_TOKEN` (permanent system-user token)
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`
7. **Webhook config** — in the app's WhatsApp → Configuration, set the callback URL `https://<your-domain>/api/whatsapp/webhook` and a **verify token** you choose → `WHATSAPP_VERIFY_TOKEN`; subscribe to the `messages` field. Copy the app secret → `WHATSAPP_APP_SECRET` (for signature verification).
8. **Opt-in** — note that we record explicit per-user opt-in with timestamp (POPIA + Meta both require it); no action beyond approving that flow.

**Hand back:** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, and confirmation that display name + templates are approved.

---

## 3. Feature A — Voice AI (Azure AI Speech + LLM adapter) 🎙️

**🔧 What we build in code:** the three-tier router (local grammar → deterministic tool-call → LLM), per-tenant phrase lists, fuzzy entity resolution (`asset_aliases` + `pg_trgm`), confirm-before-commit UI, hybrid RAG over `kb_chunks`, all behind adapters (`transcribe()`, `synthesize()`, `parseIntent()`) — swappable in one file. Voice reuses the F2 offline queue (queue-and-sync, per your decision).

**✅ You set up / obtain:**
1. **Azure account** + a **Speech resource** created in **South Africa North** (the region with af-ZA neural voices Adri/Willem + af-ZA STT). Copy:
   - `AZURE_SPEECH_KEY`
   - `AZURE_SPEECH_REGION` = `southafricanorth`
2. **Verify af-ZA availability in South Africa North** for: standard STT, **fast transcription**, and TTS neural voices — confirm in the resource before we rely on it (TTS is confirmed; verify STT + fast transcription in-region). If STT isn't in SA-North, we set the STT region separately via the adapter and note the POPIA implication (you approved cross-border AI with consent + DPA, so this is acceptable).
3. **LLM provider** (any capable API model — used only for intent-parsing + RAG). Create the account, get the API key → `LLM_API_KEY` (+ `LLM_API_BASE`/`LLM_MODEL` if applicable). Cross-border is acceptable per your decision, **with** a signed **DPA** and user consent captured.
4. *(Optional, later)* **Azure Custom Speech** — only if the Afrikaans eval set proves it's needed; it carries a ~R650/mo hosting fee. Don't provision at launch.

**Also plan (no key, but real work):** we build a **200–500 utterance Afrikaans eval set** from real farm phrasing before shipping voice — you/your pilot farms help collect these.

**Hand back:** `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `LLM_API_KEY` (+ base/model), and confirmation of af-ZA STT/fast-transcription availability + a signed DPA on file.

---

## 4. POPIA / legal (cross-cutting)

- **Consent + DPA:** because AI processing may be cross-border (your decision), capture explicit user consent and keep a **Data Processing Agreement** on file with each AI/processor vendor. We record consent per user.
- **Retention & deletion:** the base product's F8 work ships a documented retention/deletion policy + a data-subject deletion/export flow — review and sign off on it.

---

## 5. Do-this-in-order summary (with lead times)

| When | Action | Lead time |
|---|---|---|
| **Now** | Vercel Pro + Supabase Pro + backups + pooler + Sentry + VAPID keys + CRON_SECRET | minutes–hours |
| **Now** | Start **Meta** business verification + phone + display name + templates | **days** |
| **Now** | Start **Paystack** live activation (company docs) | **days** |
| Soon | Provision **Azure Speech** (SA-North) + verify af-ZA STT; create LLM account + DPA | hours–1 day |
| Before voice ships | Collect the **Afrikaans eval set** (200–500 utterances) | ongoing |
| Phase 3 | Netcash/Stitch **DebiCheck** quotes | days |

---

## 6. Env-var checklist (add to Vercel + Supabase as noted)

```
# Infra
DATABASE_URL=            # Supabase pooler (transaction mode)
DIRECT_URL=              # Supabase direct (migrations)
SENTRY_DSN=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@yourdomain
CRON_SECRET=

# Billing (Paystack)
PAYSTACK_SECRET_KEY=
PAYSTACK_PUBLIC_KEY=
PAYSTACK_WEBHOOK_SECRET=
VAT_NUMBER=

# WhatsApp (Meta Cloud API)
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=

# Voice (Azure Speech + LLM)
AZURE_SPEECH_KEY=
AZURE_SPEECH_REGION=southafricanorth
LLM_API_KEY=
LLM_API_BASE=
LLM_MODEL=
```

The code reads all of these through `src/lib/env.ts`-style getters that throw only when the feature is actually used, so the base product keeps building/running with these unset. We wire each feature only once its keys are in hand.
