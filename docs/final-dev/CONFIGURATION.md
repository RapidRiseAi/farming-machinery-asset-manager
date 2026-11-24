# Provider and configuration checklist

Task A6, BRIEF section 25 item 6. Every setting the code reads, what it is for, and the smallest human
action still needed. **No values appear here.** "Last recorded" is what an earlier session read
(with its date and source), not a fresh check: read the provider's dashboard before relying on it
(memory: check the dashboard, not the notes). Settings live in Vercel (Production, and Preview
where it shares the database) unless noted.

## 1. Settings the app reads

### Core

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the database and its public key | set (live since September) | none |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only database access (crons, webhooks, uploads) | set | none; server-only, never `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` | every emailed and payment link | CLAUDE.md asks to confirm it is set in Production | confirm in Vercel it is `https://app.fleet-wise.co.za` |
| `CRON_SECRET` | the scheduler's bearer secret (all `/api/cron/*`, `/api/push/send`) | set; minute scheduler active (16 Oct) | none |
| `EMAIL_LINK_SECRET` | signs links in emails (unsubscribe, closure) | set when closure shipped | confirm it is set |
| `TZ` | server time zone | Vercel default (UTC) | none: dates in SAST are computed explicitly |

### Email, alerts, monitoring

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| `RESEND_API_KEY`, `EMAIL_FROM` | all app email | set; email delivered (Oct) | none |
| `OPS_ALERT_EMAIL`, `AI_ALERT_EMAIL` | where operational and AI alerts go | AI_ALERT_EMAIL missing (5 Oct) | set both to a monitored inbox |
| `SENTRY_DSN` | error monitoring (without it `captureError` only logs) | missing (5 Oct) | create a Sentry project, set the DSN |
| `SUPPORT_WEBHOOK_URL`, `SUPPORT_WEBHOOK_SECRET` | optional copy of support cases | unset by design | none |

### Payments

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| `PAYMENTS_PROVIDER`, `BILLING_PROVIDER` | which provider runs (Paystack live) | Paystack live, a real payment taken | none |
| `PAYSTACK_SECRET_KEY` | charges, verification, webhook HMAC | set | none |
| `BILLING_CHARGING_ENABLED` | kill switch for automatic charges | per BILLING section 12 | leave as is; off on staging |
| `PAYFAST_MERCHANT_ID`, `PAYFAST_MERCHANT_KEY`, `PAYFAST_PASSPHRASE`, `PAYFAST_SANDBOX` | the PayFast alternative | not in use | none unless PayFast is chosen |

### AI and voice

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| AI Gateway credentials (Vercel's own, read by the AI SDK) | answers, hearing | free tier, about $4.85 credit (5 Oct) | add Gateway credit |
| `LLM_MODEL`, `LLM_FALLBACK_MODEL` | the answer model and its fallback | `openai/gpt-5.4-mini`, which the free tier refuses (5 Oct) | add credit, or set `LLM_MODEL=openai/gpt-4.1-mini` |
| `ASSISTANT_TRANSCRIBE_MODELS`, `ASSISTANT_TRANSCRIBE_ZDR`, `ASSISTANT_BYOK_LLM_MODEL` | hearing models; zero data retention after a Vercel upgrade; the model on a farm's own key | defaults | set `ASSISTANT_TRANSCRIBE_ZDR=1` after leaving Hobby |
| `AI_KEY_SECRET` | encrypts farms' own OpenAI keys (32 random bytes, base64), the same on every deployment sharing the database | missing (5 Oct) | set before any farm links a key |
| `AI_GATEWAY_LOW_CREDIT_USD` | alert threshold | default $5 | none |
| `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_SPEECH_ENDPOINT` | live speech | set; resource refuses parallel recognitions | move the Speech resource to S0 |

### WhatsApp

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| `WHATSAPP_ENABLED` | the channel switch (per-path flags are in the database since B4) | 1 in Production (16 Oct) | none |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_BUSINESS_PHONE`, `WHATSAPP_GRAPH_VERSION` | Meta Cloud API | set (pilot) | real-phone journeys for photos and voice (B4) |
| `WHATSAPP_AUTH_PRIVATE_JWK` | signs delegated sessions | set | none |
| `WHATSAPP_NOTIFICATION_TEMPLATE`, `WHATSAPP_ASSIGNMENT_TEMPLATE`, `WHATSAPP_TEMPLATE_LANGUAGE` | approved templates | set | none |
| `WHATSAPP_CRON_SECRET` | the Supabase scheduler's own credential for the worker | set | none |

### Security, notifications, maps

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | captcha on sign-up, sign-in links and resets | unset (security round item) | create a Cloudflare Turnstile widget, set both |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | web push | set | none |
| `MAPBOX_TOKEN`, `ROUTING_PROVIDER`, `ROUTING_MONTHLY_CAP`, `OSRM_URL`, `NOMINATIM_URL` | routes and place search (docs/ROUTING.md) | maps flag off | the Mapbox terms read (decision 5); choose a production tile source (the style is a constant in `src/components/map/map-style.ts`) |

### Uploads, retention, the final build's switches

| Name | Purpose | Last recorded | Action still needed |
|---|---|---|---|
| `UPLOAD_GLOBAL_LIMIT_BYTES` | states the Supabase global file limit when below the app's | unset | raise the Supabase global limit to at least 50 MB (Storage, Settings) |
| `RETENTION_DELETION` | scheduled deletion (off means a dry run) | unset | lawyer's read, then the founder (decision 7) |
| `DOCUMENT_EXTRACTION_PROVIDER`, `MANUAL_READER_PROVIDER` | the reader of photos, PDFs and manuals | unset (`none`) | decision 12 |
| `ANDROID_CERT_SHA256`, `ANDROID_APP_ID` | App Links for the Android app | unset | after Play App Signing (decision 14) |

### Local and test only

| Name | Purpose |
|---|---|
| `DEMO_PASSWORD`, `CLICKTHROUGH_PASSWORD` | demo and check-script accounts, in `.env.local` only |
| `STAGING_DATABASE_URL`, `STAGING_SUPABASE_URL`, `STAGING_SERVICE_ROLE_KEY`, `STAGING_ANON_KEY`, `LOAD_PASSWORD` | staging and load tests (docs/LOAD_TESTS.md) |
| `RESTORE_SUPABASE_URL`, `RESTORE_SERVICE_ROLE_KEY`, `RCLONE_CONFIG` | the restore drill (BACKUP.md section 9) |
| `CAP_SERVER_URL` | points an Android test build at another address |

## 2. Accounts, plans and contracts (cost or contract prerequisites)

| Provider | Needed for | Status as last recorded | Smallest human action |
|---|---|---|---|
| Supabase | the database; PITR and a 50 MB global file limit need Pro | check the plan; PITR and drill not done | confirm Pro, PITR on, global limit 50 MB or more; create `fleetwise-staging` |
| Vercel | hosting; Hobby is for non-commercial use and refuses zero data retention | Hobby (Oct) | upgrade to Pro before paying customers |
| Paystack | payments | live, Registered Business, no collections cap | none |
| Resend | email, verified domain | working | none |
| Microsoft Azure | speech | free tier; parallel recognition refused | Speech resource to S0; budget alert |
| Vercel AI Gateway / OpenAI | answers, hearing | low credit | add credit; data agreements with Vercel, Microsoft and OpenAI |
| Meta (WhatsApp Business) | WhatsApp | pilot live | WhatsApp rate card into `/admin/ai` before charging (A3) |
| Mapbox | routes (maps on Complete) | terms question open | read the Directions product terms (decision 5) |
| Offsite storage (Azure Blob, R2 or B2) | the nightly file copy | not set up | create it, add the three secrets (BACKUP.md 2.3) |
| Google Play | the Android app | D-U-N-S 588248857 received | open the developer account in the business's name; upload key; Play App Signing |
| Firebase | native push in the app (optional) | none | decide (decision 14) |
| Cloudflare Turnstile | captcha | not set | create the widget, set the keys |
| Sentry | error monitoring | not set | create the project, set `SENTRY_DSN` |
| A lawyer | terms (`legal.ts`), retention (A4 section 8), privacy | open | the lawyer list in FOUNDER-DECISIONS-PENDING |
| An accountant | VAT on the supplier treatment and the billing documents | open | FOUNDER-DECISIONS-PENDING to-do list |
