# FleetWise — Contractor/Supplier portal, Partners, Checklists & Vehicle capture (expansion spec)

Founder-directed expansion. FleetWise becomes **two-sided**: (1) the farmer's fleet/maintenance manager, and (2) a **paid SaaS portal for contractors & suppliers** who serve those farmers — one aggregated dashboard per contractor across ALL their farmer clients (not a separate login per farmer). Everything below must be doable **manually and perfectly first** (AI later). All house rules in `docs/FLEETWISE_BUILD_CHECKLISTS.md §G` apply (farm_id tenancy, RLS, audit, soft-delete, ex-VAT cents, EN/AF parity, gates green).

## 1. Access & roles model (build on what exists)

- A **contractor/supplier = a `workshop`** (already in schema). Its staff are `workshop`-role users. `workshop_links` (status=active) already grant a workshop scoped access to a farm — this is exactly the "one contractor account → many farms" spine. Extend, don't replace.
- Add **contractor types** (`workshops.kind`: mechanic / auto_electrician / parts_supplier / panel_beater / tyre / towing / other) to drive **tailored views**.
- The contractor's **aggregated dashboard** lists work/requests across every linked farm in one place; per-farm data stays RLS-isolated (they only see farms they're linked to). This makes their job easier — the core value prop.
- **Value-first onboarding:** a contractor can be invited and see incoming requests/value before paying; entitlement-gate the richer contractor features behind a contractor plan (reuse F5's entitlement framework with a contractor-side plan map). Payment stays deferred (Paystack later).

## 2. Partners directory (find / add / connect)

- **`partners`** (suggested/curated by RapidRise) + farmer-added contractors/suppliers. Fields: name, kind, contact (phone/whatsapp/email), area, is_suggested, linked `workshop_id` (once they join).
- Farmer flows: browse **suggested partners**, or **add their own** contractor/supplier. Adding one can **invite** them (creates a workshop + workshop_link + a login URL) so they get authenticated, role-based access.
- **Quick-contact buttons** (no provider needed now): `tel:` (call) and `https://wa.me/<e164>?text=…` (WhatsApp deep link) + email. These work today; the full WhatsApp Cloud API integration stays deferred. A quick-contact action can also **generate/send a login URL** (magic-link style) that deep-links the contractor to the specific vehicle/request.

## 3. Work-request flow (the heart of the contractor value)

- **`work_requests`**: farm_id, machine_id, workshop_id (assigned contractor), kind (repair/quote/inspection/parts/other), status (`requested → viewed → quoted → accepted → in_progress → completed → invoiced → closed`), description, created_by, priority, timestamps. Composite FK to machine + farm; RLS (farm side + assigned-workshop side); audit.
- **Farmer initiates from a vehicle:** on the machine page or a "get something done" action → pick contractor (or partner) + kind → creates a `work_request` **pre-filled with that vehicle**. When the contractor opens the login URL / their dashboard, **that vehicle/request is highlighted/pre-selected** (deep-link carries the request id).
- Contractor updates status, uploads **quote → invoice → proof photos/files**, records progress notes. Owner/manager is **notified on every status change** (in-app now; push via F6; WhatsApp later).
- **Quote → Invoice → Cost/TCO:** an accepted quote and its final invoice amount flow into the machine's `cost_entries` (reuse F1's invoice→cost path). Proof media via the `jobcard-photos`/attachments pattern (F1).
- A work_request can spawn/attach a **job card** (existing) so the maintenance history + costs stay unified.

## 4. Owner/manager activity dashboard (inbox)

- A unified **activity feed / inbox**: incoming **quotes, invoices, job requests, suggestions, status updates** — each actionable (accept quote, approve invoice, view proof, message contractor). Grouped by vehicle + contractor, with unread state.
- **Timelines, analytics, stats, reminders** across the fleet: per-vehicle timeline (already exists — extend with work_requests/quotes/invoices), spend/quote analytics, outstanding-quote/invoice reminders, contractor responsiveness stats.

## 5. Contractor-side views (tailored & dynamic per type)

- **Distinct dashboards per contractor `kind`:** a mechanic sees jobs/inspections; a parts supplier sees parts/quote requests + a catalogue to fulfil; an auto-electrician sees electrical jobs; etc. Build a view-router keyed on `workshops.kind` + entitlements, sharing components.
- Contractor can: see assigned vehicles + full context (with the requested vehicle highlighted), accept/decline, quote, update status, upload invoice + proof, message the farmer (quick-contact). Everything scoped to farms they're linked to.

## 6. Service kits & parts (manual CRUD — FR-5.1/5.2/5.3)

- **`parts_catalogue`**: part_no, description, supplier, typical_cost_cents (ex-VAT), category, farm_id (or global). Mechanics / parts dealers add + edit manually (AI later).
- **`service_kits`** per machine (or machine_type): the exact engine-oil / gearbox-oil / filter **part numbers** + quantities. Editable/addable in the UI. Applying a kit to a service auto-appends its parts to the job card → cost/history (reuse F1 line→cost).
- Parts consumed on a job auto-append to cost + history (exists via job_card_lines; add "add from catalogue").

## 7. Vehicle checklists + template builder (mirror TJ-autovault)

- **Study `RapidRiseAi/TJ-autovault`** — `components/workshop/inspection-template-builder.tsx`, `inspection-report-form-renderer.tsx`, `inspection-templates-table.tsx`, `lib/inspection-reports.ts`, and migrations `..._inspection_templates.sql` / `_inspection_reports*.sql`. Mirror that pattern.
- **`checklist_templates`** (farm or global): named template with ordered fields (field types: checkbox / text / number / photo / rating / section_break), reusable. A **template builder UI** to create/edit them.
- **`checklist_instances`** per vehicle/job: a filled checklist (a report) tied to machine_id (+ optional work_request/job_card), rendered from a template, with per-field values + notes + photos. Used for pre-use inspections, service sign-off, condition reports.
- Per-vehicle: create a checklist from a template; view completed checklists on the vehicle timeline.

## 8. Vehicle capture completeness + images

- **Primary vehicle image**: show a real photo on machine cards + detail (not just the name). Add a `primary_photo` concept (reuse attachments/machine-photos; mark one primary). Gallery on detail.
- **Full info capture on add**: audit the add-vehicle form ensures every useful field is captured (identity, make/model/year, reg/VIN, meter, purchase+finance, warranty, licence, assigned operator, location/site, cost-centre/department, default checklist, service kit). Add any missing fields.

## 9. Driver/usage logging made easy

- Make **"I'm driving this / log usage"** a one-tap action (extend F3 `usage_logs`): quick start on QR scan / vehicle page / a "who's driving" prompt, with the assigned operator pre-filled. Keep it <30s.

## 10. Data-model additions (adapt to house rules)

New tables (all farm-scoped where farm-owned; RLS + audit + soft-delete): `partners`, `work_requests`, `work_request_events` (status history), `parts_catalogue`, `service_kits` (+ `service_kit_items`), `checklist_templates` (+ `checklist_template_fields`), `checklist_instances` (+ `checklist_instance_values`). Extend `workshops` with `kind` + contact fields; add `machines.primary_attachment_id` (or an `is_primary` flag on attachments) + any missing capture columns.

## 11. Workstream decomposition (agent-sized; build 2 at a time; provider-free)

| ID | Workstream | Notes / deps |
|---|---|---|
| **F9** | Service kits & parts catalogue (manual CRUD) | FR-5.1/5.2/5.3. Foundational. |
| **F10** | Vehicle capture completeness + primary image + gallery | Independent. |
| **F11** | Vehicle checklists + template builder | Mirror TJ-autovault. Depends on nothing hard. |
| **F12a** | Contractor spine: `workshops.kind`, partners directory, contractor invite + login URLs, quick-contact (tel/wa.me/email) | Foundation for the portal. |
| **F12b** | Work-request flow: `work_requests` + vehicle-prefill + status lifecycle + quote/invoice/proof upload → cost/TCO + notifications | Depends on F12a. |
| **F12c** | Contractor aggregated dashboard + tailored per-kind views + entitlement gating (contractor plan) | Depends on F12a/b + F5. |
| **F13** | Owner/manager activity inbox + fleet timelines/analytics/stats/reminders | Depends on F12b. |
| **F7** | Multi-site + per-role visibility | Complements contractor multi-farm access. |
| **F8** | POPIA/security/backup | Base hardening. |

**Sequencing:** F9 + F10 now (independent, foundational) → F11 + F12a → F12b + F13 → F12c + F7 → F8 + hardening. WhatsApp/Voice/Paystack stay deferred; contractor quick-contact uses tel/wa.me deep links (no provider) until then.
