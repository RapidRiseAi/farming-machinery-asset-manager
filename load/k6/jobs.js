// The scheduled work at the size the seed makes (A6, scenario 42): large exports (one job per
// customer, made by `load_seed.mjs --exports`), the billing pass and the nightly pass, called the
// way the scheduler calls them. One caller at a time, as in production. Staging only, and the
// staging deployment must have BILLING_CHARGING_ENABLED off (docs/BILLING.md section 12) and
// Paystack TEST keys, so the billing pass charges nobody.
//
//   k6 run -e APP_URL=https://<staging app> -e CRON_SECRET=<staging's> load/k6/jobs.js
import http from "k6/http";
import { check } from "k6";
import exec from "k6/execution";

const APP_URL = (__ENV.APP_URL || "").replace(/\/$/, "");
const SECRET = __ENV.CRON_SECRET || "";

export const options = {
  scenarios: { scheduler: { executor: "per-vu-iterations", vus: 1, iterations: Number(__ENV.ROUNDS || 6), maxDuration: "40m" } },
  thresholds: { "http_req_duration{name:/api/cron/exports}": ["max<300000"] },
};

export function setup() {
  if (/app\.fleet-wise\.co\.za/.test(APP_URL)) exec.test.abort("REFUSED: production address. Staging only.");
  if (!APP_URL || !SECRET) exec.test.abort("BLOCKED: set APP_URL and CRON_SECRET (staging's own).");
}

export default function () {
  const auth = { headers: { authorization: `Bearer ${SECRET}` }, timeout: "310s" };
  const exports = http.get(`${APP_URL}/api/cron/exports`, { ...auth, tags: { name: "/api/cron/exports" } });
  check(exports, { "exports ran": (r) => r.status === 200 });
  if (exec.scenario.iterationInTest === 0) {
    const billing = http.get(`${APP_URL}/api/cron/billing`, { ...auth, tags: { name: "/api/cron/billing" } });
    check(billing, { "billing pass ran": (r) => r.status === 200 });
    const nightly = http.get(`${APP_URL}/api/cron/nightly`, { ...auth, tags: { name: "/api/cron/nightly" } });
    check(nightly, { "nightly pass ran": (r) => r.status === 200 });
  }
}
