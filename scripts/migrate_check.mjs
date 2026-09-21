// Apply every migration, in order, to a throwaway PGlite database, and optionally run the
// SQL suites against it, each on a database of its own.
//
// The same stand-in the billing work has used before: a real Postgres, not the project's
// own harness (`pnpm db:test` needs a psql that is not on this machine), and enough to
// prove that a new migration parses, applies, and applies AFTER everything already in the
// repo. CRs are stripped first, Windows checks files out CRLF and that is not what the
// server would receive.
//
// A FRESH DATABASE PER SUITE, because that is what `supabase/tests/run.sh` does. Sharing
// one connection means the first failure aborts the transaction and every suite after it
// reports "current transaction is aborted", which says nothing about the suite itself.
//
// PGlite ships neither pgcrypto nor pg_trgm, so both CREATE EXTENSION lines are
// neutralised and the two functions the migrations actually use are supplied below. What
// is exercised is therefore this repo's SQL, not a stand-in's extension catalogue.
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase/migrations");
const testsDir = path.join(root, "supabase/tests");
const shimPath = path.join(testsDir, "shim/auth_shim.sql");

const read = (p) =>
  fs
    .readFileSync(p, "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/create extension if not exists (pgcrypto|pg_trgm)\s*;/gi, "select 1;")
    // The trigram indexes go with the extension. They accelerate the assistant's lookups,
    // have nothing to do with billing, and dropping them changes nothing this run is
    // trying to establish.
    .replace(/create\s+index[^;]*trgm_ops[^;]*;/gis, "select 1;");

/** A database with the roles, the auth shim and every migration applied. */
async function freshDb() {
  const db = new PGlite();
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
    end $$;
  `);
  await db.exec(read(shimPath));
  // gen_random_uuid() is core from Postgres 13. digest() is not, and is only ever used to
  // build an opaque hash, so md5 standing in is fine for an apply check.
  await db.exec(`
    create or replace function public.digest(text, text) returns bytea
      language sql immutable as $fn$ select decode(md5($1), 'hex') $fn$;
    create or replace function public.digest(bytea, text) returns bytea
      language sql immutable as $fn$ select decode(md5($1), 'hex') $fn$;
  `);

  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await db.exec(read(path.join(migrationsDir, f)));
    } catch (err) {
      console.error(`\nMIGRATION FAILED: ${f}\n${err.message}\n`);
      process.exit(1);
    }
  }
  return { db, count: files.length };
}

// == 1. Every migration applies, in order, to an empty database ===============
const { db, count } = await freshDb();
console.log(`applied ${count} migrations cleanly`);

const checks = await db.query(`
  select p.proname,
         has_function_privilege('service_role', p.oid, 'EXECUTE')  as svc,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_role,
         has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('billing_signup_email_taken','billing_take_signup_slot',
                       'cron_enqueue_billing_renewal_notices')
   order by p.proname;
`);
console.table(checks.rows);

// == 2. The rate limiter, exercised rather than asserted from its source ======
// Skipped when the function is absent, so this script also runs against a checkout that
// predates it, which is how a suite failure gets attributed to a change rather than
// assumed to belong to it.
if (checks.rows.some((r) => r.proname === "billing_take_signup_slot")) {
  await db.exec(`select public.billing_take_signup_slot('1.2.3.4', 3);`);
  const slots = await db.query(`
    select public.billing_take_signup_slot('1.2.3.4', 3) as second,
           public.billing_take_signup_slot('1.2.3.4', 3) as third,
           public.billing_take_signup_slot('1.2.3.4', 3) as fourth_refused,
           public.billing_take_signup_slot('9.9.9.9', 3) as other_source;
  `);
  console.log("limiter, expect second/third true, fourth false, other true:", slots.rows[0]);
} else {
  console.log("limiter, not present in this checkout, skipped");
}
await db.close();

// == 3. The suites, each on its own database ==================================
if (process.argv.includes("--suite")) {
  const only = process.argv[process.argv.indexOf("--suite") + 1];
  const names =
    only && !only.startsWith("--")
      ? [only]
      : fs.readdirSync(testsDir).filter((f) => f.endsWith(".sql")).sort();

  console.log("");
  for (const name of names) {
    const { db: suiteDb } = await freshDb();
    try {
      // `\set ON_ERROR_STOP` and `\timing` are psql meta-commands, not SQL. PGlite speaks
      // to the server directly and never sees a psql, so they are dropped. ON_ERROR_STOP
      // is the behaviour here anyway, the first raised exception aborts the run.
      const sql = read(path.join(testsDir, name))
        .split("\n")
        .filter((line) => !line.startsWith("\\"))
        .join("\n");
      await suiteDb.exec(sql);
      console.log(`  PASS  ${name}`);
    } catch (err) {
      console.error(`  FAIL  ${name}`);
      console.error(`        ${String(err.message).split("\n")[0]}`);
      process.exitCode = 1;
    }
    await suiteDb.close();
  }
}
