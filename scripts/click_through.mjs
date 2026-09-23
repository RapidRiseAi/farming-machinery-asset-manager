/**
 * Sign in as the throwaway owner and walk the product, checking what actually renders.
 *
 * == Why this is not a browser ===============================================
 * It does not need to be. Every page here is a server component: what a person sees IS the
 * HTML this fetches, cookies and all. Driving Chrome would add a dependency and a lot of
 * timing in exchange for testing React's hydration, which the build already type-checks.
 * What was never tested is whether a page renders at all for a signed-in user with real
 * rows, and that is exactly what this does.
 *
 * It signs in through the ordinary Supabase password endpoint and carries the session
 * cookies the middleware sets, so every guard, every RLS policy and every query runs as
 * that user. A page that 500s, redirects to /login, or renders a raw i18n key fails here.
 *
 *   node scripts/click_through.mjs                 # against http://localhost:3111
 *   node scripts/click_through.mjs --base=http://localhost:3000
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE =
  process.argv.find((a) => a.startsWith("--base="))?.slice(7) ?? "http://localhost:3111";
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

const SUPABASE_URL = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const ANON = readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = readEnv("SUPABASE_SERVICE_ROLE_KEY");

/** Close out the previous run's questions. Service-role, because a farm cannot. */
async function resolveOpenHelpRequests() {
  await fetch(
    `${SUPABASE_URL}/rest/v1/support_tickets?kind=eq.help_request&status=in.(open,waiting)`,
    {
      method: "PATCH",
      headers: {
        apikey: SERVICE,
        authorization: `Bearer ${SERVICE}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify({ status: "resolved", resolved_at: new Date().toISOString() }),
    },
  );
}

// == Sign in the way the app does ============================================
const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!res.ok) {
  console.error(`Could not sign in: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const session = await res.json();
console.log(`Signed in as ${EMAIL}\n`);

/**
 * The cookie @supabase/ssr writes. Name is `sb-<project-ref>-auth-token`, value is the
 * session JSON base64-encoded behind a `base64-` marker, chunked if long.
 */
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const payload = JSON.stringify({
  access_token: session.access_token,
  token_type: "bearer",
  expires_in: session.expires_in,
  expires_at: session.expires_at,
  refresh_token: session.refresh_token,
  user: session.user,
});
const encoded = "base64-" + Buffer.from(payload, "utf8").toString("base64");
const CHUNK = 3180;
const cookies = [];
if (encoded.length <= CHUNK) {
  cookies.push(`sb-${ref}-auth-token=${encoded}`);
} else {
  for (let i = 0, n = 0; i < encoded.length; i += CHUNK, n += 1) {
    cookies.push(`sb-${ref}-auth-token.${n}=${encoded.slice(i, i + CHUNK)}`);
  }
}
const COOKIE = cookies.join("; ");

// == The walk ================================================================
const PAGES = [
  ["/dashboard", ["Test Tractor"]],
  ["/machines", ["Test Tractor", "Test Bakkie"]],
  ["/incidents", []],
  ["/team", []],
  ["/team/licences", []],
  ["/reports", []],
  ["/reports/assets", []],
  ["/fines", []],
  ["/faults", []],
  ["/jobcards", []],
  ["/fuel", []],
  ["/checklists", []],
  ["/notifications", []],
  ["/settings", []],
  ["/billing", []],
  ["/parts", []],
  ["/work", []],
  ["/account", []],
  ["/jobcards/f0000000-0000-4000-8000-00000000bc01", ["Test Tractor"]],
  ["/calendar", []],
  ["/help", []],
  ["/tyres", []],
];

let failures = 0;

for (const [route, mustContain] of PAGES) {
  let status = 0;
  let html = "";
  try {
    const r = await fetch(BASE + route, { headers: { cookie: COOKIE }, redirect: "manual" });
    status = r.status;
    html = await r.text();
  } catch (e) {
    console.log(`  FAIL  ${route.padEnd(18)} request failed: ${e.message}`);
    failures += 1;
    continue;
  }

  const problems = [];
  if (status >= 500) problems.push(`HTTP ${status}`);
  if (status === 307 || status === 302) {
    const to = "redirected";
    problems.push(to);
  }
  if (status === 200) {
    // A raw i18n key on the page is the failure `t()` makes silently.
    const rawKeys = html.match(/>[a-z]+\.[a-zA-Z]{3,}</g) || [];
    if (rawKeys.length) problems.push(`raw i18n key ${rawKeys[0]}`);
    // Built from its code point, not typed: this file is itself swept by
    // scripts/dash_sweep.mjs, which rewrote the literal into a plain hyphen and turned
    // this into a check that fired on every page with a hyphen in it.
    if (html.includes(String.fromCharCode(0x2014))) problems.push("em dash");
    if (/Application error|Something went wrong/i.test(html)) problems.push("error boundary");
    for (const s of mustContain) {
      if (!html.includes(s)) problems.push(`missing "${s}"`);
    }
  }

  if (problems.length) {
    failures += 1;
    console.log(`  FAIL  ${route.padEnd(18)} ${status}  ${problems.join(", ")}`);
  } else {
    console.log(`  ok    ${route.padEnd(18)} ${status}  ${(html.length / 1024).toFixed(0)}kB`);
  }
}

// == The writes ==============================================================
//
// Server actions speak Next's own action protocol, which is not worth hand-rolling. What
// IS worth exercising is the layer underneath them: the insert or RPC, sent as this
// signed-in user through PostgREST, so RLS and every constraint decide the outcome exactly
// as they would from the form. Then the page is loaded again and asked whether it shows it.
const rest = (pathAndQuery, init = {}) =>
  fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: ANON,
      authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });

const FARM = "f0000000-0000-4000-8000-00000000fa01";
const MACHINE = "f0000000-0000-4000-8000-00000000aa01";
const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/**
 * Clear what a previous run wrote, so this one can be run again.
 *
 * Not a convenience: without it the second run fails on the uniqueness guard that only
 * allows one live warranty claim per repair, and a check that passes only the first time
 * is a check nobody will keep running. Deleted as the signed-in owner, so RLS confirms
 * these rows really do belong to this farm.
 */
for (const table of ["tyre_checks", "tyre_fitments", "tyres", "warranty_claims", "driver_credentials", "incidents"]) {
  await rest(`${table}?farm_id=eq.${FARM}`, {
    method: "DELETE",
    headers: { prefer: "return=minimal" },
  });
}
// Help requests are capped at five open PER FARM, so a run that left them open would make
// the sixth run fail on the ceiling rather than on anything real. Resolved through the
// service side, because a farm deliberately cannot write to support_tickets at all.
await resolveOpenHelpRequests();

console.log("\nWrites, as this owner, through RLS:");

async function step(label, run, verifyRoute, mustAppear) {
  try {
    const r = await run();
    if (!r.ok) {
      failures += 1;
      const body = typeof r.text === "function" ? (await r.text()).slice(0, 140) : "";
      console.log(`  FAIL  ${label.padEnd(36)} ${r.status} ${body}`);
      return;
    }
    let detail = "";
    if (verifyRoute) {
      const page = await fetch(BASE + verifyRoute, { headers: { cookie: COOKIE } });
      const html = await page.text();
      const missing = (mustAppear ?? []).filter((m) => !html.includes(m));
      if (missing.length) {
        failures += 1;
        console.log(
          `  FAIL  ${label.padEnd(36)} written, but ${verifyRoute} lacks ${missing.join(", ")}`,
        );
        return;
      }
      detail = `then ${verifyRoute} shows it`;
    }
    console.log(`  ok    ${label.padEnd(36)} ${detail}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${label.padEnd(36)} ${e.message}`);
  }
}

await step(
  "driver credential, expired PrDP",
  () =>
    rest("driver_credentials", {
      method: "POST",
      body: JSON.stringify({
        farm_id: FARM,
        person_name: "Sipho Ndlovu",
        type: "prdp",
        code: "G",
        number: "P-0001",
        expiry_date: daysAgo(30),
        reminder_lead_days: 30,
      }),
    }),
  "/team/licences",
  ["Sipho Ndlovu", "Expired"],
);

await step(
  "incident, claim lodged 60 days ago",
  () =>
    rest("incidents", {
      method: "POST",
      body: JSON.stringify({
        farm_id: FARM,
        machine_id: MACHINE,
        kind: "collision",
        status: "claim_lodged",
        description: "Collision at the R63 turn-off.",
        saps_case_number: "CAS 114/06/2026",
        third_party_name: "Pieter van Wyk",
        insurer: "Santam",
        claim_number: "CLM-99812",
        claim_lodged_on: daysAgo(60),
        claimed_incl_cents: 4500000,
        excess_incl_cents: 500000,
      }),
    }),
  "/incidents",
  ["CLM-99812", "60"],
);

await step(
  "book-value policy on the tractor",
  () =>
    rest("rpc/set_machine_depreciation", {
      method: "POST",
      body: JSON.stringify({
        p_machine: MACHINE,
        p_method: "straight_line",
        p_rate_bps: null,
        p_life_months: 120,
        p_residual_cents: 10000000,
        p_start: "2020-01-01",
      }),
    }),
  "/reports/assets",
  ["Straight line"],
);

const JOB_CARD = "f0000000-0000-4000-8000-00000000bc01";

await step(
  "warranty claim on a covered repair",
  () =>
    rest("warranty_claims", {
      method: "POST",
      body: JSON.stringify({
        farm_id: FARM,
        machine_id: MACHINE,
        job_card_id: JOB_CARD,
        supplier: "Barloworld",
        reference: "W-8812",
        status: "submitted",
        submitted_on: daysAgo(60),
        claimed_ex_vat_cents: 400000,
        covered_by_date: true,
        covered_by_hours: true,
      }),
    }),
  `/jobcards/${JOB_CARD}`,
  ["Barloworld", "W-8812", "Under warranty"],
);

// The trigger firing IS the pass: the repair cost R4 500 and this asks for R9 000.
await step("a claim bigger than its own repair is refused", async () => {
  const r = await rest("warranty_claims", {
    method: "POST",
    body: JSON.stringify({
      farm_id: FARM,
      machine_id: MACHINE,
      job_card_id: JOB_CARD,
      claimed_ex_vat_cents: 900000,
    }),
  });
  return { ok: r.status >= 400 && r.status < 500, status: r.status, text: () => r.text() };
});

// The constraint firing IS the pass. A settled claim with no amount and no date would
// quietly shrink the "owed by the insurer" figure on the screen above.
await step("a settled claim with no amount is refused", async () => {
  const r = await rest("incidents", {
    method: "POST",
    body: JSON.stringify({
      farm_id: FARM,
      machine_id: MACHINE,
      kind: "theft",
      status: "claim_settled",
      claim_lodged_on: today,
    }),
  });
  return { ok: r.status >= 400 && r.status < 500, status: r.status, text: () => r.text() };
});

// A tyre, fitted, then rotated to the second machine. The rotation is the case the whole
// feature turns on: a tyre that keeps ONE life across machines.
await step(
  "a tyre bought, fitted and rotated",
  async () => {
    const made = await rest("tyres", {
      method: "POST",
      body: JSON.stringify({
        farm_id: FARM, brand: "Michelin", pattern: "XM108", size: "520/85R42",
        serial_no: "CT-1", purchase_cost_cents: 600000, new_tread_mm: 20,
        purchase_date: daysAgo(400),
      }),
    });
    if (!made.ok) return made;
    const tyre = (await made.json())[0].id;

    const fit = await rest("rpc/fit_tyre", {
      method: "POST",
      body: JSON.stringify({
        p_tyre: tyre, p_machine: MACHINE, p_axle: "drive", p_position: "LR",
        p_on: daysAgo(300), p_reading: 1000,
      }),
    });
    if (!fit.ok) return fit;

    // Rotated onto the bakkie. The previous fitment must close itself.
    const rotate = await rest("rpc/fit_tyre", {
      method: "POST",
      body: JSON.stringify({
        p_tyre: tyre, p_machine: "f0000000-0000-4000-8000-00000000aa02",
        p_axle: "drive", p_position: "RR", p_on: daysAgo(100), p_reading: 40000,
      }),
    });
    if (!rotate.ok) return rotate;

    const check = await rest("tyre_checks", {
      method: "POST",
      body: JSON.stringify({ farm_id: FARM, tyre_id: tyre, tread_mm: 9, checked_on: daysAgo(10) }),
    });
    return check;
  },
  "/tyres",
  ["XM108", "9mm"],
);

await step(
  "a question asked from inside the product",
  () =>
    rest("rpc/open_help_request", {
      method: "POST",
      body: JSON.stringify({
        p_subject: "The QR sticker will not scan",
        p_message: "It worked last week on the Massey and now nothing happens.",
        p_context: { path: "/machines/abc", locale: "en", secret: "must not be kept" },
      }),
    }),
  "/help",
  ["The QR sticker will not scan", "With us"],
);

// And the tenancy fence, from the inside: this owner must not be able to file a document
// against somebody else's farm, however the form is posted.
await step("a write aimed at another farm is refused", async () => {
  const r = await rest("driver_credentials", {
    method: "POST",
    body: JSON.stringify({
      farm_id: "00000000-0000-4000-8000-000000000001",
      person_name: "Not mine",
      type: "drivers_licence",
      expiry_date: today,
    }),
  });
  return { ok: r.status >= 400 && r.status < 500, status: r.status, text: () => r.text() };
});

console.log(
  failures === 0
    ? "\nEvery page rendered and every write behaved."
    : `\n${failures} check(s) failed.`,
);
process.exit(failures === 0 ? 0 : 1);
