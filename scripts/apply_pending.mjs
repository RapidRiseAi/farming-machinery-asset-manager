/**
 * Apply the migrations a target database has not got yet, one transaction each.
 *
 * == Why it checks OBJECTS and not a ledger ==================================
 * This schema has no migrations table, and `docs/SCHEMA_DRIFT.md` says why: the only
 * trustworthy answer to "is this applied" is whether the thing it creates is there. So
 * each migration is paired with a probe below, and anything whose probe already answers
 * true is skipped rather than re-run.
 *
 * == Safety ==================================================================
 * One transaction per file, so a failure leaves that migration wholly unapplied rather
 * than half. `--dry` prints the plan and touches nothing. Nothing here drops, truncates or
 * updates existing rows; if a migration ever does, that is on the migration, and the plan
 * is printed first so a person sees the list before it runs.
 *
 *   node scripts/apply_pending.mjs --dry
 *   node scripts/apply_pending.mjs --apply
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const APPLY = process.argv.includes("--apply");
const ROOT = process.cwd();

/** Read DATABASE_URL out of .env.local without pulling in a dotenv dependency. */
function readEnv(name) {
  const text = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * One probe per pending migration: SQL returning true when it is already applied.
 * Written against the object the migration exists to create.
 */
const PROBES = {
  // The activity log shows no reader more than the source table would (work package A).
  "20261028093000": "select to_regprocedure('app.person_audit_elsewhere(uuid,uuid)') is not null",
  "20261028092500":
    "select to_regprocedure('app.audit_redact_existing()') is not null" +
    " and to_regclass('app.audit_redaction_runs') is not null",
  "20261028092000": "select to_regprocedure('app.audit_vehicle_reader_farm_ids()') is not null",
  "20261028091500":
    "select to_regprocedure('app.audit_log_file()') is not null" +
    " and exists(select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='audit_log' and column_name='about_farm_id')" +
    " and exists(select 1 from pg_trigger where tgname='audit_log_file'" +
    " and tgrelid='public.audit_log'::regclass)",
  "20261028091000":
    "select to_regprocedure('app.audit_withhold(jsonb,text[])') is not null" +
    " and to_regprocedure('app.audit_hidden_columns(regclass)') is not null",
  "20261028090000": "select to_regclass('app.audit_table_rules') is not null",
  // The support desk and the owner's dashboard (2026-10-28), one object each.
  "20261028100000":
    "select exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid" +
    " where t.typname = 'support_ticket_kind' and e.enumlabel = 'export_request')",
  "20261028100100": "select to_regprocedure('app.is_rr_support()') is not null",
  "20261028100200":
    "select to_regclass('public.support_settings') is not null" +
    " and to_regprocedure('public.support_contact()') is not null",
  "20261028100300": "select to_regclass('public.support_holidays') is not null",
  "20261028100400": "select to_regprocedure('app.support_due_at(timestamptz)') is not null",
  "20261028100500":
    "select exists (select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='support_tickets' and column_name='first_response_due_at')",
  "20261028100600": "select to_regclass('public.support_ticket_messages') is not null",
  "20261028100700":
    "select to_regclass('public.support_visits') is not null" +
    " and to_regprocedure('public.support_visit_start(uuid,text,uuid)') is not null",
  "20261028100800": "select to_regprocedure('app.notify_rr_support(uuid,text,jsonb)') is not null",
  "20261028100900": "select to_regprocedure('public.reply_to_help_request(uuid,text)') is not null",
  "20261028100950":
    "select to_regprocedure('app.support_next_due(support_ticket_kind,support_ticket_status,timestamptz," +
    "timestamptz,timestamptz,timestamptz,timestamptz)') is not null",
  "20261028101000": "select to_regprocedure('public.support_queue(text,text,text,boolean,uuid)') is not null",
  "20261028101100": "select to_regprocedure('public.admin_client(uuid)') is not null",
  "20261028101200": "select to_regprocedure('app.team_invite_actor_role(uuid,uuid)') is not null",
  "20261028101300": "select to_regprocedure('public.admin_set_user_active(uuid,uuid,boolean)') is not null",
  "20261026100000": "select to_regprocedure('app.audit_readable_farm_ids()') is not null",
  // An in-place rewrite leaves nothing but the text to check; the migration itself returns
  // early when applied and stops loudly if the text it rewrites has moved.
  "20261026090000":
    "select coalesce(pg_get_functiondef(to_regprocedure('app.generate_recurring_invoices(uuid)')) like '%for update of ri%', false)",
  "20261018100000":
    "select exists(select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='partner_documents' and column_name='payment_claimed_at')",
  "20261018090000":
    "select to_regclass('public.request_claims') is not null" +
    " and to_regprocedure('public.claim_request(uuid,text)') is not null" +
    " and to_regprocedure('public.release_request(uuid)') is not null",
  "20261015175415":
    "select to_regclass('public.whatsapp_links') is not null" +
    " and to_regprocedure('public.whatsapp_assistant_role(uuid)') is not null" +
    " and coalesce(pg_get_functiondef(to_regprocedure('app.effective_farm_role(uuid,uuid)')) like '%app.whatsapp_scope(p_farm)%', false)" +
    " and coalesce(pg_get_functiondef(to_regprocedure('app.effective_farm_role(uuid,uuid)')) like '%app.rr_admin_unlocked()%', false)",
  "20260918120000": "select to_regprocedure('public.billing_signup_email_taken(text)') is not null",
  "20260918130000": "select to_regprocedure('public.billing_take_signup_slot(text,integer)') is not null",
  "20260918140000":
    "select to_regprocedure('public.cron_enqueue_billing_renewal_notices()') is not null",
  // The real signature, read off pg_proc after the fact. A probe written from memory is a
  // probe that reports a migration missing when it is there, which is the same class of
  // wrong as reporting it present when it is not.
  "20260920090000":
    "select to_regprocedure('public.record_fuel_issue(uuid,uuid,uuid,date,numeric,numeric,bigint,text,uuid)') is not null",
  "20260920100000": "select to_regclass('public.meter_replacements') is not null",
  "20260920110000":
    "select exists (select 1 from information_schema.columns where table_name='checklist_template_fields' and column_name='fail_when')",
  "20260920120000": "select to_regprocedure('app.farm_vat_rate_bps(uuid)') is not null",
  "20260920130000": "select to_regclass('public.notification_email_delivery') is not null",
  "20260920140000": "select to_regclass('public.fuel_dips') is not null",
  "20260920150000":
    "select exists (select 1 from information_schema.columns where table_name='billing_subscriptions' and column_name='discount_percent_bps')",
  "20260920160000": "select to_regprocedure('public.billing_check_promo_code(text)') is not null",
  "20260921090000": "select to_regclass('public.driver_credentials') is not null",
  "20260921100000": "select to_regclass('public.incidents') is not null",
  "20260921110000": "select to_regprocedure('public.farm_book_values(uuid,date)') is not null",
  "20260921120000": "select to_regclass('public.warranty_claims') is not null",
  "20260921130000": "select to_regprocedure('public.farm_calendar(uuid,date,date)') is not null",
  "20260921140000":
    "select exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'support_ticket_kind' and e.enumlabel = 'help_request')",
  "20260921141000": "select to_regprocedure('public.open_help_request(text,text,jsonb)') is not null",
  "20260921150000": "select to_regclass('public.tyre_fitments') is not null",
  // Not an object this one creates: it REVOKES. The probe is the invariant itself.
  // The four restored checks live inside a function body, so the probe asks the function
  // itself rather than looking for an object.
  "20260921170000":
    "select pg_get_functiondef(('public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)')::regprocedure) like '%isfinite(v_date)%' " +
    "   and pg_get_functiondef(('public.apply_offline_capture(uuid,timestamptz,text,text,uuid,jsonb)')::regprocedure) like '%v_date > v_today%'",
  "20260921160000":
    "select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'EXECUTE'))",
  // The job-card workflow release. A migration with no probe is skipped as "assumed
  // applied", so without these three the script reported "Nothing pending" while the
  // live database had none of them, and the build that needs them would have shipped
  // against a schema without its tables and functions. Each probe names an object only
  // that migration creates.
  "20260927160340":
    "select to_regprocedure('public.update_work_request(uuid,text,bigint,bigint,text)') is not null" +
    "   and to_regclass('public.job_card_line_receipts') is not null",
  "20260928061830":
    "select to_regprocedure('public.record_job_card_media(uuid,uuid,text,text,bigint,text)') is not null",
  "20261001062931":
    "select to_regprocedure('public.create_job_card_intake(uuid,jsonb)') is not null" +
    "   and to_regprocedure('public.create_work_request_intake(uuid,jsonb)') is not null",
  // Replaces a function rather than creating an object, so the probe reads its body for
  // the v1-to-v2 upgrade branch only this migration adds.
  "20261003090000":
    "select pg_get_functiondef('app.app_users_guard_ai_consent()'::regprocedure) like '%voice-ai-v2%'",
  // Driver activity and the member QR (Codex, 2026-10-03): its first table, its last
  // function and its receipts table, so a half-applied file can never read as done.
  "20261003142805":
    "select to_regclass('public.driving_sessions') is not null and to_regprocedure('public.driving_session_details(uuid[])') is not null and to_regclass('public.member_qr_receipts') is not null",
  // The AI notice and the ledger. Each probe names something only the FINAL version of
  // its file has (the trigger's notice-evidence branch; the voice session's source column
  // and the hidden cost columns), so a draft applied somewhere can never read as done.
  // CASE, because AND does not promise to look at the guard first.
  "20261004095000":
    "select case when to_regprocedure('public.ai_notice_ack(boolean)') is null then false else pg_get_functiondef('app.app_users_guard_ai_consent()'::regprocedure) like '%old.ai_notice_seen_at is null and new.ai_notice_seen_at is not null%' end",
  "20261004100000":
    "select case when to_regclass('public.ai_usage') is null or to_regprocedure('public.ai_voice_token_window(timestamptz)') is null then false else exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_voice_sessions' and column_name = 'source') and not has_column_privilege('authenticated', 'public.ai_usage', 'provider_cost_usd', 'SELECT') end",
  // Team invites for addresses that already have a login. The body is read for the
  // switched-off branch the final version has. to_regprocedure, never a ::regprocedure
  // literal: the literal is resolved while the query is planned, so a function that does
  // not exist yet fails the whole probe instead of reading as not applied.
  "20261005120000":
    "select coalesce(pg_get_functiondef(to_regprocedure('public.team_invite_existing(uuid,uuid,text,text,text,text)')) like '%They stay off there.%', false)",
  // Tank balances in SQL: the function, with the dip column only the final version returns.
  "20261005122000":
    "select coalesce(pg_get_function_result(to_regprocedure('public.fuel_tank_balances(uuid)')) like '%book_at_dip_litres%', false)",
  // The assistant's farm numbers: the three bounded signatures (by machine or by month).
  "20261005130000":
    "select to_regprocedure('public.assistant_fuel_summary(uuid,date,date,text,uuid)') is not null and to_regprocedure('public.assistant_fuel_consumption(uuid,date,date,uuid)') is not null and to_regprocedure('public.assistant_cost_summary(uuid,date,date,text,uuid)') is not null",
  // The notice that mentions farm records: the trigger stamps v2 once this is applied.
  "20261008090000":
    "select pg_get_functiondef('app.app_users_guard_ai_consent()'::regprocedure) like '%ai-on-default-v2%'",
  // Diesel by voice: the proposal function with its log_fuel branch (and the hardened check).
  "20261009090000":
    "select pg_get_functiondef('public.apply_assistant_proposal_internal(uuid,text)'::regprocedure) like '%v_key_count <> 13%'",
  // AI use on the invoice: the AI-only generator's cron wrapper, the renewal notice that
  // carries the AI use, and the derive trigger that adds it to the total.
  "20261010090000":
    "select to_regprocedure('public.cron_generate_ai_usage_invoices()') is not null" +
    " and pg_get_functiondef('app.enqueue_billing_renewal_notices()'::regprocedure) like '%ai_cents%'" +
    " and pg_get_functiondef('app.billing_derive_invoice_totals()'::regprocedure) like '%+ new.ai_usage_incl_cents%'",
  // AI use billed on the farm's billing date: the cutoff helper, and the AI-only generator
  // that waits for the farm's own day of the month.
  "20261011090000":
    "select to_regprocedure('app.ai_billing_cutoff()') is not null" +
    " and pg_get_functiondef('app.generate_ai_usage_invoices()'::regprocedure) like '%v_cutoff - interval ''35 days''%'",
  // Database totals: machines list, expenses page, Rapid Rise's farm and partner lists.
  "20261013090000":
    "select to_regprocedure('public.machine_cost_totals(uuid)') is not null" +
    " and to_regprocedure('public.admin_farm_activity(timestamptz)') is not null" +
    " and to_regprocedure('public.partner_expense_position(uuid)') is not null" +
    " and to_regprocedure('public.admin_partner_activity()') is not null",
  // Statements readable page by page: a sort rank and a row key on both.
  "20261013100000":
    "select pg_get_function_result('public.partner_statement(uuid,uuid,uuid,date,date)'::regprocedure) like '%entry_id uuid, sort_rank integer%'" +
    " and pg_get_function_result('public.supplier_statement(uuid,uuid,date,date)'::regprocedure) like '%sort_rank integer%'",
  // Scheduled reports claimed in batches: the cron entry point takes a limit.
  "20261013110000":
    "select to_regprocedure('public.cron_run_due_report_schedules(integer)') is not null" +
    " and to_regprocedure('app.run_due_report_schedules(uuid,date,integer)') is not null",
  // tyre_life carries the latest check's pressure.
  "20261013120000":
    "select pg_get_function_result('public.tyre_life(uuid)'::regprocedure) like '%latest_pressure_kpa numeric%'",
  // Farm users read the seller's details, not the platform's AI pricing (H1).
  "20261013130000":
    "select not has_column_privilege('authenticated', 'public.billing_settings', 'ai_margin_bps', 'SELECT')" +
    " and has_column_privilege('authenticated', 'public.billing_settings', 'legal_name', 'SELECT')",
  // Bucket limits, and no trigger function executable by anon (H2, H6).
  "20261013140000":
    "select not has_function_privilege('anon', 'public.app_stock_rollup()', 'EXECUTE')" +
    " and exists (select 1 from storage.buckets where id = 'jobcard-photos' and file_size_limit = 10485760)",
  // Rate limits shared by every server instance (H3).
  "20261014090000":
    "select to_regprocedure('public.rate_limit_take(text,integer,integer)') is not null" +
    " and to_regclass('app.rate_limit_windows') is not null",
  // Rapid Rise's powers need the second factor (B9).
  // Objects only: 20261014120000 rewrites is_rr_admin to ask app.rr_admin_unlocked(), which
  // asks session_mfa_verified() itself, so a check on is_rr_admin's text would report B9
  // missing after the fence and re-run it, undoing the fence.
  "20261014100000": "select to_regprocedure('app.session_mfa_verified()') is not null",
  // Test farms stay out of Rapid Rise's totals (H5).
  "20261014110000":
    "select exists (select 1 from information_schema.columns where table_schema = 'public'" +
    " and table_name = 'farms' and column_name = 'is_test')" +
    " and pg_get_functiondef('public.ai_admin_month(date)'::regprocedure) like '%is_test%'",
  // Test accounts walled off from real ones; Rapid Rise never a test account.
  "20261014120000":
    "select to_regprocedure('app.rr_admin_unlocked()') is not null" +
    " and to_regprocedure('public.email_recipients_allowed(uuid,uuid,uuid,text[])') is not null" +
    " and exists (select 1 from pg_trigger where tgname = 'workshop_links_test_fence')" +
    " and pg_get_functiondef('app.is_rr_admin()'::regprocedure) like '%rr_admin_unlocked%'" +
    " and pg_get_functiondef('app.notify_rr_billing(uuid,text,jsonb)'::regprocedure) like '%is_test%'" +
    " and to_regclass('app.test_email_inboxes') is not null",
};

const url = readEnv("DATABASE_URL");
if (!url) {
  console.error("No DATABASE_URL in .env.local");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

const files = fs
  .readdirSync(path.join(ROOT, "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort();

const pending = [];
for (const file of files) {
  const stamp = file.split("_")[0];
  const probe = PROBES[stamp];
  if (!probe) continue; // Older migrations: assumed applied, and their objects are in use.
  const { rows } = await client.query(probe);
  if (rows[0] && Object.values(rows[0])[0] === true) continue;
  pending.push(file);
}

console.log(`${files.length} migration files, ${Object.keys(PROBES).length} probed.`);
if (pending.length === 0) {
  console.log("Nothing pending. The database already has every probed object.");
  await client.end();
  process.exit(0);
}
console.log(`\nPENDING (${pending.length}):`);
for (const f of pending) console.log("  " + f);

if (!APPLY) {
  console.log("\nDry run. Pass --apply to run these, one transaction each.");
  await client.end();
  process.exit(0);
}

console.log("\nApplying:");
for (const file of pending) {
  const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
  // Windows checks these out CRLF and some statements are sensitive to it.
  const clean = sql.replace(/\r\n/g, "\n");
  try {
    await client.query("begin");
    await client.query(clean);
    await client.query("commit");
    console.log(`  applied  ${file}`);
  } catch (err) {
    await client.query("rollback").catch(() => {});
    console.error(`  FAILED   ${file}`);
    console.error(`           ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log("\nVerifying every probe now answers true:");
let bad = 0;
for (const [stamp, probe] of Object.entries(PROBES)) {
  const { rows } = await client.query(probe);
  const ok = rows[0] && Object.values(rows[0])[0] === true;
  if (!ok) {
    bad += 1;
    console.log(`  MISSING  ${stamp}`);
  }
}
console.log(bad === 0 ? "  all present" : `  ${bad} still missing`);
await client.end();
process.exit(bad === 0 ? 0 : 1);
