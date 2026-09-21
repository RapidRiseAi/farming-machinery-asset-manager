/**
 * Apply the migrations a target database has not got yet, one transaction each.
 *
 * ── Why it checks OBJECTS and not a ledger ──────────────────────────────────
 * This schema has no migrations table, and `docs/SCHEMA_DRIFT.md` says why: the only
 * trustworthy answer to "is this applied" is whether the thing it creates is there. So
 * each migration is paired with a probe below, and anything whose probe already answers
 * true is skipped rather than re-run.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
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
  "20260921160000":
    "select not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and has_function_privilege('anon', p.oid, 'EXECUTE'))",
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
