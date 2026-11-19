// Representative customers at work (A6, scenario 42): every synthetic person signs in once, then
// opens the screens a fleet uses every day and records meter readings at their own site, so several
// sites of one customer write at the same time (pooled-site writes). Staging only.
//
//   k6 run -e STAGING_SUPABASE_URL=... -e STAGING_ANON_KEY=... -e APP_URL=https://<staging app> \
//          -e LOAD_PASSWORD=... load/k6/customers.js
import http from "k6/http";
import { check, sleep } from "k6";
import { APP_URL, SUPABASE_URL, apiHeaders, appHeaders, refuseProduction, signIn, todaySast } from "./lib/session.js";

const manifest = JSON.parse(open(__ENV.MANIFEST || "../.seed-manifest.json"));
const people = manifest.customers.flatMap((c) => c.users.map((u) => ({ ...u, machines: c.machines[u.farm] ?? [] })));
const peak = Number(__ENV.VUS || people.length);

export const options = {
  scenarios: {
    working_day: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP || "2m", target: peak },
        { duration: __ENV.HOLD || "10m", target: peak },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:page}": ["p(95)<2500"],
    "http_req_duration{kind:api}": ["p(95)<1000"],
    "http_req_duration{kind:rpc}": ["p(95)<800"],
  },
};

export function setup() {
  refuseProduction();
  return { started: new Date().toISOString() };
}

let session = null;
let reading = 0;

export default function () {
  const me = people[(__VU - 1) % people.length];
  if (!session) {
    session = signIn(me.email);
    if (!check(session, { "signed in": (s) => s && s.access_token })) { sleep(5); return; }
    reading = 100000 + __VU * 10;
  }
  const page = (path) => http.get(`${APP_URL}${path}`, { headers: appHeaders(session), tags: { kind: "page", name: path }, redirects: 0 });

  check(page(me.role === "operator" ? "/driver" : "/home"), { "home 200": (r) => r.status === 200 });
  sleep(2);
  check(page("/machines"), { "machines 200": (r) => r.status === 200 });
  sleep(1);
  const search = http.get(`${APP_URL}/api/machines/search?q=C`, { headers: appHeaders(session), tags: { kind: "api", name: "/api/machines/search" } });
  check(search, { "search 200": (r) => r.status === 200 });

  // A reading on one of this site's assets, always higher than the last (the database refuses a lower one).
  if (me.machines.length) {
    reading += 7;
    const machine = me.machines[(__ITER + __VU) % me.machines.length];
    const res = http.post(`${SUPABASE_URL}/rest/v1/rpc/record_meter_reading`, JSON.stringify({
      p_farm: me.farm, p_machine: machine, p_reading: reading, p_reading_date: todaySast(), p_driver_user: null,
    }), { headers: apiHeaders(session), tags: { kind: "rpc", name: "record_meter_reading" } });
    check(res, { "reading saved": (r) => r.status === 200 });
  }
  sleep(3 + Math.random() * 4);
}
