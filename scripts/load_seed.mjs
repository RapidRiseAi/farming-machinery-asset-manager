// Synthetic customers for load tests on the STAGING project only (A6, BRIEF section 21, scenario 42).
//
// Each customer is what the brief asks to measure: 200 full spaces and 50 pieces of equipment
// across three sites billed through the first, an owner, a manager and ten operators, a year of
// monthly meter readings, staff chat on, and the map flag on. Everything is marked test (the
// test-account fence keeps it away from real accounts) and named "LOAD ...". Sign-ins are made
// through Supabase's admin API with LOAD_PASSWORD; nothing is inserted into the auth schema by hand.
// What was made is written to load/.seed-manifest.json (git-ignored, no password in it) for k6.
//
// usage (staging only; refuses the production project):
//   STAGING_SUPABASE_URL=https://<staging>.supabase.co STAGING_SERVICE_ROLE_KEY=... LOAD_PASSWORD=... \
//   node scripts/load_seed.mjs --yes-staging [--customers 5] [--exports]
//   node scripts/load_seed.mjs --yes-staging --remove     (signs-ins deleted, businesses closed)
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PRODUCTION_REFS = ["nmqtcvdwtyggxjjgtnzm"];
const MANIFEST = path.join(import.meta.dirname, "..", "load", ".seed-manifest.json");
const args = process.argv.slice(2);
const url = process.env.STAGING_SUPABASE_URL ?? "";
const key = process.env.STAGING_SERVICE_ROLE_KEY ?? "";
const password = process.env.LOAD_PASSWORD ?? "";
const customers = Math.min(Math.max(Number(args[args.indexOf("--customers") + 1]) || 5, 1), 50);

if (PRODUCTION_REFS.some((ref) => url.includes(ref))) {
  console.log("REFUSED: that is the production project. Load fixtures go to staging only.");
  process.exit(3);
}
if (!args.includes("--yes-staging")) {
  console.log("Add --yes-staging to confirm STAGING_SUPABASE_URL is the staging project (docs/LOAD_TESTS.md).");
  process.exit(2);
}
const missing = [
  !/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url) && "STAGING_SUPABASE_URL",
  !key && "STAGING_SERVICE_ROLE_KEY",
  !args.includes("--remove") && password.length < 12 && "LOAD_PASSWORD (12 characters or more)",
].filter(Boolean);
if (missing.length) {
  console.log(`BLOCKED: set ${missing.join(", ")}. Nothing was written.`);
  process.exit(2);
}

const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const must = (result, where) => {
  if (result.error) throw new Error(`${where}: ${result.error.code ?? ""} ${result.error.message}`);
  return result.data;
};

if (args.includes("--remove")) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  for (const c of manifest.customers) {
    for (const u of c.users) await db.auth.admin.deleteUser(u.id).catch(() => undefined);
    for (const f of [c.root, ...c.sites]) await db.from("farms").update({ status: "closed", deleted_at: new Date().toISOString() }).eq("id", f);
  }
  console.log(`Removed ${manifest.customers.length} customers' sign-ins and closed their businesses. Reset the staging project for a clean slate.`);
  process.exit(0);
}

const FULL_TYPES = ["tractor", "harvester", "bakkie", "truck"];
const EQUIPMENT_TYPES = ["pump_generator", "compressor", "trailer", "implement"];
const run = randomUUID().slice(0, 8);
const manifest = { createdAt: new Date().toISOString(), url, run, customers: [] };

async function person(farmId, role, label, c) {
  const email = `load-${run}-c${c}-${label}@example.test`;
  const created = must(await db.auth.admin.createUser({ email, password, email_confirm: true }), `createUser ${label}`);
  must(await db.from("users").insert({ id: created.user.id, farm_id: farmId, role, name: `Load ${label}`, email, active: true, is_test: true }), `users ${label}`);
  return { id: created.user.id, email, role, farm: farmId };
}

for (let c = 1; c <= customers; c++) {
  const started = Date.now();
  const root = must(await db.from("farms").insert({ name: `LOAD ${run} customer ${c} site 1`, plan: "complete", status: "active", is_test: true }).select("id").single(), "root farm").id;
  const sites = [];
  for (let s = 2; s <= 3; s++) {
    sites.push(must(await db.from("farms").insert({ name: `LOAD ${run} customer ${c} site ${s}`, plan: "complete", status: "active", is_test: true, billed_through: root }).select("id").single(), "site").id);
  }
  const all = [root, ...sites];
  must(await db.from("farm_feature_access").insert(all.flatMap((farm_id) => [{ key: "general_chat", farm_id }, { key: "map", farm_id }])), "flags");

  const users = [await person(root, "owner", "owner", c), await person(root, "manager", "manager", c)];
  for (let i = 1; i <= 10; i++) users.push(await person(all[i % 3], "operator", `operator${i}`, c));

  // 200 full spaces and 50 equipment, spread over the three sites.
  const machines = [];
  for (let i = 0; i < 250; i++) {
    const equipment = i >= 200;
    machines.push({
      farm_id: all[i % 3],
      name: `C${c} ${equipment ? "Equipment" : "Vehicle"} ${i + 1}`,
      type: equipment ? EQUIPMENT_TYPES[i % EQUIPMENT_TYPES.length] : FULL_TYPES[i % FULL_TYPES.length],
      meter_type: !equipment && FULL_TYPES[i % FULL_TYPES.length] === "bakkie" ? "km" : "hours",
      profile: equipment ? "equipment" : "full",
    });
  }
  const machineRows = [];
  for (let i = 0; i < machines.length; i += 100) {
    machineRows.push(...must(await db.from("machines").insert(machines.slice(i, i + 100)).select("id, farm_id, profile, meter_type"), "machines"));
  }

  // A year of monthly readings for every full-profile asset, rising.
  const readings = [];
  const today = new Date();
  for (const m of machineRows.filter((r) => r.profile === "full")) {
    for (let k = 12; k >= 1; k--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - k, 15));
      readings.push({ farm_id: m.farm_id, machine_id: m.id, reading: (13 - k) * (m.meter_type === "km" ? 2500 : 90), reading_date: d.toISOString().slice(0, 10), source: "manual" });
    }
  }
  for (let i = 0; i < readings.length; i += 1000) must(await db.from("meter_readings").insert(readings.slice(i, i + 1000)), "readings");

  // One group chat at the first site with everyone there.
  const conversation = randomUUID();
  const here = users.filter((u) => u.farm === root);
  must(await db.from("chat_conversations").insert({ id: conversation, farm_id: root, kind: "group", title: "Load test", created_by: users[0].id }), "chat");
  must(await db.from("chat_members").insert(here.map((u) => ({ conversation_id: conversation, farm_id: root, user_id: u.id, is_admin: u.role === "owner" }))), "chat members");

  if (args.includes("--exports")) {
    must(await db.rpc("export_job_create", { p_by: users[0].id, p_farm: root, p_request: randomUUID() }), "export job");
  }

  manifest.customers.push({
    root, sites, conversation, users,
    machines: Object.fromEntries(all.map((f) => [f, machineRows.filter((r) => r.farm_id === f && r.profile === "full").slice(0, 40).map((r) => r.id)])),
  });
  console.log(`customer ${c}: 3 sites, ${users.length} people, ${machineRows.length} assets, ${readings.length} readings (${Math.round((Date.now() - started) / 1000)} s)`);
}

fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log(`Manifest: ${MANIFEST} (no password in it). Next: docs/LOAD_TESTS.md.`);
