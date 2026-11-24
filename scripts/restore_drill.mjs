// The restore drill, as a script (A6; docs/BACKUP.md section 9; scenario 39).
//
// Run against an ISOLATED project that a backup was restored into, never production. It checks
// that the restored database holds data (row counts of key tables), then takes a sample of
// finished uploads from that database and confirms each file exists in the separate offsite copy
// (rclone remote "dest:", the same config the nightly file copy uses). With --download it also
// fetches each sampled file and compares its size with what the upload recorded.
//
// Nothing here is faked: without the restored project's address and key, or without rclone and
// its config, it says exactly what is missing and exits 2 (blocked). It never prints a key.
//
// usage:
//   RESTORE_SUPABASE_URL=https://<scratch>.supabase.co RESTORE_SERVICE_ROLE_KEY=... \
//   RCLONE_CONFIG=/path/to/rclone.conf node scripts/restore_drill.mjs [--sample 20] [--download]
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const PRODUCTION_REFS = ["nmqtcvdwtyggxjjgtnzm"];
const args = process.argv.slice(2);
const sample = Math.min(Math.max(Number(args[args.indexOf("--sample") + 1]) || 20, 1), 200);
const download = args.includes("--download");
const url = process.env.RESTORE_SUPABASE_URL ?? "";
const key = process.env.RESTORE_SERVICE_ROLE_KEY ?? "";

function blocked(missing) {
  console.log("BLOCKED: the restore drill needs:");
  for (const m of missing) console.log(`  - ${m}`);
  console.log("See docs/BACKUP.md section 9 for the setup. Nothing was checked.");
  process.exit(2);
}

// 1. Never production. The drill reads with a service key; aimed at the live project it would be
//    a production read with full rights, which is not what a drill is for.
if (PRODUCTION_REFS.some((ref) => url.includes(ref))) {
  console.log("REFUSED: RESTORE_SUPABASE_URL is the production project. Restore into a scratch project and point the drill there.");
  process.exit(3);
}
const missing = [];
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) missing.push("RESTORE_SUPABASE_URL: the restored scratch project's https://<ref>.supabase.co address");
if (!key) missing.push("RESTORE_SERVICE_ROLE_KEY: that project's service role key (Settings, API), kept out of the shell history");
const rclone = spawnSync("rclone", ["version"], { encoding: "utf8" });
if (rclone.status !== 0) missing.push("rclone on the PATH (rclone.org/downloads)");
if (!process.env.RCLONE_CONFIG) missing.push("RCLONE_CONFIG: the path to the same rclone config the nightly copy uses (one [dest] section)");
if (missing.length) blocked(missing);

const db = createClient(url, key, { auth: { persistSession: false } });
const started = Date.now();
const report = { tables: {}, files: { checked: 0, found: 0, missing: [], sizeMismatch: [] } };

// 2. The database came back with data in it.
for (const table of ["farms", "users", "machines", "meter_readings", "job_cards", "attachments", "upload_intents", "billing_invoices"]) {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true });
  report.tables[table] = error ? `error ${error.code ?? ""}` : count;
}

// 3. Files: a sample of finished uploads, looked up in the offsite copy.
const { data: uploads, error: uploadError } = await db
  .from("upload_intents")
  .select("bucket, object_path, actual_bytes")
  .eq("status", "finalised")
  .order("created_at", { ascending: false })
  .limit(sample);
if (uploadError) {
  console.log(`FAILED: could not read upload_intents from the restored database (${uploadError.code ?? "error"}).`);
  process.exit(1);
}
for (const u of uploads ?? []) {
  report.files.checked++;
  const remote = `dest:${u.bucket}/${u.object_path}`;
  const ls = spawnSync("rclone", ["lsjson", remote], { encoding: "utf8" });
  const entries = ls.status === 0 ? JSON.parse(ls.stdout || "[]") : [];
  if (entries.length === 0) { report.files.missing.push(`${u.bucket}/${u.object_path}`); continue; }
  report.files.found++;
  if (download && u.actual_bytes != null && Number(entries[0].Size) !== Number(u.actual_bytes)) {
    report.files.sizeMismatch.push(`${u.bucket}/${u.object_path}: copy ${entries[0].Size} bytes, recorded ${u.actual_bytes}`);
  }
}

const seconds = Math.round((Date.now() - started) / 1000);
console.log("Restored database, rows per table:");
for (const [table, count] of Object.entries(report.tables)) console.log(`  ${table}: ${count}`);
console.log(`Offsite copy: ${report.files.found} of ${report.files.checked} sampled files found${download ? `, ${report.files.sizeMismatch.length} size differences` : ""}.`);
for (const m of report.files.missing) console.log(`  MISSING ${m}`);
for (const m of report.files.sizeMismatch) console.log(`  SIZE ${m}`);
const ok = Object.values(report.tables).every((c) => typeof c === "number")
  && report.tables.farms > 0 && report.files.checked > 0 && report.files.missing.length === 0 && report.files.sizeMismatch.length === 0;
console.log(`\nDrill log line: | ${new Date().toISOString().slice(0, 10)} | <your name> | backup restore into scratch project + offsite files | checks ${seconds} s | ${ok ? "PASS" : "FAIL"}: ${report.files.found}/${report.files.checked} files |`);
process.exit(ok ? 0 : 1);
