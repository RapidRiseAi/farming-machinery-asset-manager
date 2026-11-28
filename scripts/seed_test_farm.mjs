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

function readEnv(name) {
  const text = fs.readFileSync(path.join(ROOT, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === name) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// In .env.local only: the repo is public, and this account signs in to production. Until
// 2026-10-14 it was written here, and anyone reading the repo could sign in with it.
const PASSWORD = readEnv("CLICKTHROUGH_PASSWORD");
if (CREATE && !PASSWORD) {
  console.error("seed_test_farm: set CLICKTHROUGH_PASSWORD in .env.local first (a long random value)");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: readEnv("DATABASE_URL"),
  ssl: { rejectUnauthorized: false },
});
await client.connect();

if (REMOVE) {
  /*
   * Every row this throwaway farm owns, in whatever table it lives. A hand-kept list of
   * tables fell behind the schema: on 28 Nov 2026 `cost_entries` (written by the seeded job
   * card) blocked the old list's delete of the job card and the machines, and the whole
   * removal rolled back. So the tables are read from the catalogue instead.
   *
   * `session_replication_role = replica` lifts triggers for this one transaction: guarded
   * ledgers (`ai_usage`, cost entries, the audit log) do not refuse, and foreign keys do
   * not block. It also means nothing cascades, so every column that can point at one of
   * the fixed ids is visited explicitly, auth's own tables included, and before committing
   * every uuid column in the app's schemas is scanned for a leftover. Any leftover rolls
   * the whole removal back and is named, rather than being left orphaned.
   */
  const farmIds = [IDS.farm];
  const userIds = [IDS.owner];
  const machineIds = [IDS.machineA, IDS.machineB];
  const jobIds = [IDS.jobCard];
  const byColumn = {
    farm_id: farmIds, about_farm_id: farmIds, billing_farm_id: farmIds,
    user_id: userIds, profile_id: userIds, created_by: userIds, actor_id: userIds,
    machine_id: machineIds, job_card_id: jobIds,
  };
  await client.query("begin");
  await client.query("set local session_replication_role = replica");
  const { rows: cols } = await client.query(
    `select c.table_schema s, c.table_name t, c.column_name col
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where (c.table_schema in ('public', 'app') and c.column_name = any($1))
         or (c.table_schema = 'auth' and c.column_name = 'user_id')`,
    [Object.keys(byColumn)],
  );
  let removed = 0;
  // Sign-in claims point at a session, not at the user, so they go before the sessions do.
  if ((await client.query("select to_regclass('auth.mfa_amr_claims') is not null as present")).rows[0].present) {
    removed += (await client.query(
      "delete from auth.mfa_amr_claims where session_id in (select id from auth.sessions where user_id = any($1::uuid[]))",
      [userIds],
    )).rowCount;
  }
  for (const { s, t, col } of cols) {
    const ids = s === "auth" ? userIds : byColumn[col];
    // ::text, because auth.refresh_tokens.user_id is text and a few app columns may be too.
    const r = await client.query(`delete from "${s}"."${t}" where "${col}"::text = any($1)`, [ids]);
    if (r.rowCount) console.log(`  ${s}.${t} (${col}): ${r.rowCount}`);
    removed += r.rowCount;
  }
  removed += (await client.query("delete from public.job_cards where id = any($1)", [jobIds])).rowCount;
  removed += (await client.query("delete from public.machines where id = any($1)", [machineIds])).rowCount;
  removed += (await client.query("delete from public.users where id = any($1)", [userIds])).rowCount;
  removed += (await client.query("delete from public.farms where id = any($1)", [farmIds])).rowCount;
  removed += (await client.query("delete from auth.users where id = any($1)", [userIds])).rowCount;

  // Nothing may still point at any fixed id, in any uuid column of the app's schemas.
  const everyId = [...farmIds, ...userIds, ...machineIds, ...jobIds];
  const { rows: uuidCols } = await client.query(
    `select c.table_schema s, c.table_name t, c.column_name col
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema in ('public', 'app', 'auth') and c.data_type = 'uuid'`,
  );
  const leftovers = [];
  for (const { s, t, col } of uuidCols) {
    const n = (await client.query(`select count(*)::int n from "${s}"."${t}" where "${col}" = any($1::uuid[])`, [everyId])).rows[0].n;
    if (n) leftovers.push(`${s}.${t}.${col}: ${n}`);
  }
  if (leftovers.length) {
    await client.query("rollback");
    console.log(`Not removed: rows still point at the test farm, so nothing was deleted.\n  ${leftovers.join("\n  ")}`);
    await client.end();
    process.exit(1);
  }
  await client.query("commit");
  console.log(`Test farm removed (${removed} rows; no uuid column still points at it).`);
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
// The four token columns are empty text, as Supabase Auth writes them itself: left NULL, its
// sign-in cannot read the row and answers 500 "Database error querying schema" (28 Nov 2026).
await client.query(
  `insert into auth.users (
     instance_id, id, aud, role, email, encrypted_password,
     email_confirmed_at, created_at, updated_at,
     raw_app_meta_data, raw_user_meta_data,
     confirmation_token, recovery_token, email_change_token_new, email_change
   ) values (
     '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
     crypt($3, gen_salt('bf')), now(), now(), now(),
     '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Click Through"}'::jsonb,
     '', '', '', ''
   ) on conflict (id) do update set encrypted_password = crypt($3, gen_salt('bf')),
     confirmation_token = coalesce(auth.users.confirmation_token, ''),
     recovery_token = coalesce(auth.users.recovery_token, ''),
     email_change_token_new = coalesce(auth.users.email_change_token_new, ''),
     email_change = coalesce(auth.users.email_change, '')`,
  [IDS.owner, EMAIL, PASSWORD],
);

await client.query(
  `insert into public.farms (id, name, plan, status, billing_period, billing_email, is_test)
   values ($1, 'Click-through Test Farm', 'complete', 'active', 'monthly', $2, true)
   on conflict (id) do update set is_test = true`,
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
console.log(`  sign in ${EMAIL} with CLICKTHROUGH_PASSWORD from .env.local`);
console.log(`  remove  node scripts/seed_test_farm.mjs --remove`);
await client.end();
