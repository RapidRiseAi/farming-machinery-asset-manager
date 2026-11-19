/**
 * What a business export reads: one list, used by the streamed JSON export
 * (`/api/farm/export`, B3) and by the complete export job with files (A4), so the two can never
 * disagree about what "your records" means.
 *
 * Every read goes through the REQUESTER's own session, so row-level security decides what
 * comes back, and is narrowed to the one business being exported. Money columns are granted
 * only through the `_visible` projections, so those tables are read through them. A table the
 * requester may not read at all is named as unavailable rather than silently left out.
 *
 * Never listed: staff chat (`chat_*`, private conversations are not the owner's to read
 * through an export), spoken-command audio and its jobs (temporary), the AI usage ledger and
 * request claims (system records), credentials and tokens.
 */

/** Every column of `machines` a farm user may read, less the QR capture token. */
export const MACHINE_COLUMNS =
  "id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type, status, " +
  "current_reading, current_reading_date, purchase_date, warranty_expiry_date, " +
  "warranty_expiry_hours, assigned_operator_id, location, notes, created_at, deleted_at, " +
  "cost_centre, department, primary_attachment_id, profile";

/** `key`: the unique column paging ends on, for a table without an `id`. */
export type ExportTable = { name: string; source?: string; columns?: string; order?: string; farmColumn?: string; key?: string };

export const EXPORT_TABLES: readonly ExportTable[] = [
  { name: "farms", farmColumn: "id" },
  { name: "machines", columns: MACHINE_COLUMNS, order: "name" },
  // The business's own asset fields and their values (B5, 20261121100000); row security
  // leaves out "managers" fields for anyone else.
  { name: "asset_field_definitions", order: "sort_order" },
  { name: "asset_field_values" },
  { name: "meter_readings", order: "reading_date" },
  // Imports and what each row became (B5, 20261121110000): where readings came from.
  { name: "import_batches", order: "created_at" },
  { name: "import_rows", order: "row_no" },
  // Which manuals are searchable (B5, 20261121120000). Their page text is left out: it is read
  // from files the complete export already carries.
  { name: "manual_index", order: "indexed_at", key: "attachment_id" },
  { name: "service_plan_lines" },
  { name: "job_cards", source: "job_cards_visible", order: "created_at" },
  { name: "job_card_lines", source: "job_card_lines_visible" },
  { name: "faults", order: "created_at" },
  { name: "cost_entries", order: "occurred_on" },
  { name: "fuel_issues", source: "fuel_issues_visible", order: "date" },
  { name: "fuel_deliveries", source: "fuel_deliveries_visible", order: "date" },
  { name: "licences", order: "expiry_date" },
  { name: "work_requests", source: "work_requests_visible", order: "created_at" },
  { name: "budgets" },
  { name: "stock_items" },
  { name: "checklist_instances", order: "created_at" },
  { name: "usage_logs", order: "occurred_on" },
  { name: "billing_invoices", order: "issued_on" },
  // Added 2026-11-05 (launch tracker "Farm export: finance tables and large farms"): the
  // finance and lease records, and the operational tables built since this list was made.
  // Finance rows come back only for a role that may read them (`can_view_farm_finance`);
  // a manager without that sees the tables named as unavailable rather than empty.
  { name: "finance_agreements", order: "created_at" },
  { name: "finance_instalments", order: "due_date" },
  { name: "asset_contracts", order: "created_at" },
  { name: "fuel_tanks" },
  { name: "fuel_dips", order: "created_at" },
  { name: "meter_replacements", order: "created_at" },
  { name: "asset_aliases" },
  { name: "watch_items", order: "created_at" },
  { name: "stock_movements", source: "stock_movements_visible", order: "created_at" },
  { name: "service_kits" },
  { name: "checklist_templates" },
  // No id column: its key is the (job card, service line) pair.
  { name: "job_card_service_lines", order: "service_plan_line_id", key: "job_card_id" },
  { name: "tyres" },
  { name: "tyre_fitments", order: "created_at" },
  { name: "tyre_checks", order: "created_at" },
  { name: "incidents", order: "created_at" },
  { name: "warranty_claims", order: "created_at" },
  { name: "fines", order: "created_at" },
  { name: "driver_credentials" },
  { name: "driving_sessions", order: "created_at" },
  { name: "driving_events", order: "occurred_at" },
  // Trips, their loads and money, planned routes and reported positions (B3). After a
  // downgrade these stay the business's to take away (decision 37); the reads are the
  // person's own, so trip money comes back only for an owner or manager.
  { name: "trips", order: "created_at" },
  { name: "trip_jobs", order: "created_at" },
  { name: "trip_income", key: "trip_id" },
  { name: "trip_expenses", order: "created_at" },
  { name: "trip_routes", key: "trip_id" },
  { name: "asset_positions", order: "recorded_at" },
  { name: "fuel_card_statements", order: "created_at" },
  { name: "fuel_card_transactions", order: "created_at" },
  { name: "user_farm_memberships" },
  { name: "attachments", order: "created_at" },
  // A4: support equipment's history, what the account was billed and stored, and the services
  // agreed with Rapid Rise (owner-only by row security; anyone else sees them unavailable or
  // empty). Storage measurements and charges are a business's records too (REPORT-A3, section 7).
  { name: "asset_profile_changes", order: "changed_at" },
  { name: "asset_classification_reviews", order: "requested_at" },
  { name: "billing_invoice_lines" },
  { name: "billing_payments" },
  { name: "billing_change_quotes", order: "created_at" },
  { name: "billing_account_credits" },
  { name: "storage_usage_snapshots", order: "measured_on", key: "measured_on" },
  { name: "storage_charges", order: "created_at" },
  { name: "done_for_you_quotes", order: "created_at" },
  { name: "service_orders", order: "offered_at" },
  { name: "service_work_entries", order: "worked_on" },
];

/** Tables that must never be in a business export, whatever is added to the list above. */
export const NEVER_EXPORTED = /^(chat_|command_audio|assistant_command|ai_usage|request_claims|whatsapp_|push_subscriptions|billing_payment_methods)/;
