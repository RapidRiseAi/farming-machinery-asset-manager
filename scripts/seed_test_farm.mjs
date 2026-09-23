/**
 * Create a throwaway farm, owner and a little data, so the new screens can be clicked.
 *
 * == Why a whole farm and not a row on an existing one =======================
 * Because RLS is the thing being exercised. A test row inside a customer's farm would be
 * visible to that customer, would appear in their totals, and would have to be found again
 * to remove. A separate farm is isolated by the same mechanism the product sells.
 *
 * == Everything it writes is prefixed and listed =============================
 * One farm, one auth user, one profile, and a handful of rows beneath them. `--remove`
 * deletes exactly what `--create` made, by id, and nothing else.
 *
 *   node scripts/seed_test_farm.mjs --create
 *   node scripts/seed_test_farm.mjs --remove
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = process.cwd();
const CREATE = process.argv.includes("--create");
const REMOVE = process.argv.includes("--remove");

/** Fixed ids, so --remove can be exact and a half-finished run can be re-run. */
export const IDS = {
  farm: "f0000000-0000-4000-8000-00000000fa01",
  owner: "f0000000-0000-4000-8000-00000000c001",
  machineA: "f0000000-0000-4000-8000-00000000aa01",
  machineB: "f0000000-0000-4000-8000-00000000aa02",
  // Hex only. A "jc01" in a uuid is not a uuid, and Postgres says so in a message that
  // reads like the row is wrong rather than the literal.
  jobCard: "f0000000-0000-4000-8000-00000000bc01",
};
const EMAIL = "clickthrough@fleetwise.test";
const PASSWORD = "Clickthrough!2026";

function readEnv(name) {
  const text = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

const client = new pg.Client({
  connectionString: readEnv("DATABASE_URL"),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

if (REMOVE) {
  // Children first, then the farm, then the auth user. Anything the farm owns that is not
  // listed here would block the delete and say so, which is the point of doing it by hand
  // rather than relying on a cascade nobody has read.
  const tables = [
    "warranty_claims", "driver_credentials", "incidents", "fuel_dips", "meter_replacements",
    "licences", "fines", "usage_logs", "faults", "job_cards", "machines",
    "billing_invoices", "billing_subscriptions", "notifications", "audit_log",
  ];
  await client.query("begin");
  for (const t of tables) {
    try {
      await client.query(`delete from public.${t} where farm_id = $1`, [IDS.farm]);
    } catch (e) {
      console.log(`  (skipped ${t}: ${e.message.split("\n")[0]})`);
    }
  }
  await client.query("delete from public.users where id = $1", [IDS.owner]);
  await client.query("delete from public.farms where id = $1", [IDS.farm]);
  await client.query("delete from auth.users where id = $1", [IDS.owner]);
  await client.query("commit");
  console.log("Test farm removed.");
  await client.end();
  process.exit(0);
}

if (!CREATE) {
  console.log("Pass --create or --remove.");
  await client.end();
  process.exit(1);
}

await client.query("begin");

// The auth user. `crypt` with bcrypt is what Supabase Auth stores, so the password works
// through the ordinary sign-in path rather than through an admin back door.
await client.query(
  `insert into auth.users (
     instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at,
     raw_app_meta_data, raw_user_meta_data
   ) values (
     '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
     crypt($3, gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Click Through"}'::jsonb
   ) on conflict (id) do update set encrypted_password = crypt($3, gen_salt('bf'))`,
  [IDS.owner, EMAIL, PASSWORD],
);

await client.query(
  `insert into public.farms (id, name, plan, status, billing_period, billing_email)
   values ($1, 'Click-through Test Farm', 'complete', 'active', 'monthly', $2)
   on conflict (id) do nothing`,
  [IDS.farm, EMAIL],
);

await client.query(
  `insert into public.users (id, farm_id, workshop_id, role, name, email, active)
   values ($1, $2, null, 'owner', 'Click Through', $3, true)
   on conflict (id) do update set farm_id = excluded.farm_id, active = true`,
  [IDS.owner, IDS.farm, EMAIL],
);

await client.query(
  `insert into public.machines (id, farm_id, name, type, meter_type, status, reg_no,
                                purchase_date, purchase_price_cents)
   values ($1, $3, 'Test Tractor', 'tractor', 'hours', 'active', 'CA 123-456',
           date '2020-01-01', 100000000),
          ($2, $3, 'Test Bakkie', 'bakkie', 'km', 'active', 'CA 654-321',
           date '2022-06-01', 50000000)
   on conflict (id) do nothing`,
  [IDS.machineA, IDS.machineB, IDS.farm],
);

// A closed repair on the tractor, inside its warranty on the day it was done. The
// warranty panel has nothing to say without one, and "was this covered" is the question
// the whole feature turns on.
await client.query(
  `update public.machines
      set warranty_expiry_date = date '2026-12-31', warranty_expiry_hours = 3000,
          current_reading = 1800
    where id = $1`,
  [IDS.machineA],
);
await client.query(
  `insert into public.job_cards (id, farm_id, machine_id, type, status, date_in,
                                 meter_reading, total_cents)
   values ($1, $2, $3, 'repair', 'approved', current_date - 40, 1500, 450000)
   on conflict (id) do nothing`,
  [IDS.jobCard, IDS.farm, IDS.machineA],
);

await client.query("commit");

console.log("Test farm created.");
console.log(`  farm    ${IDS.farm}`);
console.log(`  sign in ${EMAIL} / ${PASSWORD}`);
console.log(`  remove  node scripts/seed_test_farm.mjs --remove`);
await client.end();
