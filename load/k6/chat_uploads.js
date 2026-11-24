// Concurrent staff chat and photo uploads (A6, scenario 42): the people at each customer's first
// site talk in their group chat while attaching photos through the upload pipeline (begin, the
// direct upload to Storage, finalise), so the storage pool's reservations and the chat sequence
// are both under load. Staging only. The photo is the app's own icon, a real PNG the server checks.
//
//   k6 run -e STAGING_SUPABASE_URL=... -e STAGING_ANON_KEY=... -e APP_URL=... -e LOAD_PASSWORD=... load/k6/chat_uploads.js
import http from "k6/http";
import { check, sleep } from "k6";
import { APP_URL, appHeaders, refuseProduction, signIn, uuid } from "./lib/session.js";

const manifest = JSON.parse(open(__ENV.MANIFEST || "../.seed-manifest.json"));
const photo = open("../../public/icon-192.png", "b");
const talkers = manifest.customers.flatMap((c) =>
  c.users.filter((u) => u.farm === c.root).map((u) => ({ ...u, room: c.conversation, machines: c.machines[c.root] ?? [] })));

export const options = {
  scenarios: {
    chat_and_photos: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || talkers.length),
      duration: __ENV.HOLD || "10m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    "http_req_duration{kind:chat}": ["p(95)<1000"],
    "http_req_duration{kind:upload}": ["p(95)<3000"],
  },
};

export function setup() { refuseProduction(); }

let session = null;

export default function () {
  const me = talkers[(__VU - 1) % talkers.length];
  if (!session) {
    session = signIn(me.email);
    if (!check(session, { "signed in": (s) => s && s.access_token })) { sleep(5); return; }
  }
  const sent = http.post(`${APP_URL}/api/chat`, JSON.stringify({ action: "send", room: me.room, id: uuid(), body: `Load message ${__ITER}` }), {
    headers: appHeaders(session, true), tags: { kind: "chat", name: "/api/chat send" },
  });
  check(sent, { "message sent": (r) => r.status === 200 });
  sleep(2);

  // Every third round, a photo on one of the site's assets.
  if (__ITER % 3 === 0 && me.machines.length) {
    const machine = me.machines[__ITER % me.machines.length];
    const begin = http.post(`${APP_URL}/api/uploads/begin`, JSON.stringify({
      target: { kind: "machine", id: machine, farmId: me.farm }, label: "photo", mediaClass: "photo",
      mime: "image/png", bytes: photo.byteLength, requestId: uuid(),
    }), { headers: appHeaders(session, true), tags: { kind: "upload", name: "/api/uploads/begin" } });
    if (check(begin, { "upload begun": (r) => r.status === 200 && r.json("state") === "upload" })) {
      const put = http.put(begin.json("signedUrl"), photo, { headers: { "content-type": "image/png" }, tags: { kind: "upload", name: "storage signed PUT" } });
      check(put, { "file stored": (r) => r.status === 200 });
      const done = http.post(`${APP_URL}/api/uploads/finalise`, JSON.stringify({ intentId: begin.json("intentId"), attachmentKind: "photo" }), {
        headers: appHeaders(session, true), tags: { kind: "upload", name: "/api/uploads/finalise" },
      });
      check(done, { "upload finalised": (r) => r.status === 200 });
    }
  }
  sleep(4 + Math.random() * 4);
}
