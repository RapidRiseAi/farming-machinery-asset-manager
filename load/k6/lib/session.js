// Shared by the k6 scenarios (A6, docs/LOAD_TESTS.md): signing in as a synthetic person and the
// cookies the app reads, so page and API requests go through the same session checks as a phone.
import http from "k6/http";
import encoding from "k6/encoding";
import crypto from "k6/crypto";
import exec from "k6/execution";

export const SUPABASE_URL = (__ENV.STAGING_SUPABASE_URL || "").replace(/\/$/, "");
export const ANON_KEY = __ENV.STAGING_ANON_KEY || "";
export const APP_URL = (__ENV.APP_URL || "").replace(/\/$/, "");
const PASSWORD = __ENV.LOAD_PASSWORD || "";

/** Never production: the scenarios write readings, messages and files as the people they sign in as. */
export function refuseProduction() {
  if (/app\.fleet-wise\.co\.za|nmqtcvdwtyggxjjgtnzm/.test(`${APP_URL} ${SUPABASE_URL}`)) {
    exec.test.abort("REFUSED: production address. Load tests run against staging only.");
  }
  if (!SUPABASE_URL || !ANON_KEY || !APP_URL || !PASSWORD) {
    exec.test.abort("BLOCKED: set STAGING_SUPABASE_URL, STAGING_ANON_KEY, APP_URL and LOAD_PASSWORD (docs/LOAD_TESTS.md).");
  }
}

/** Supabase's password sign-in: the session the app's browser client would hold. */
export function signIn(email) {
  const res = http.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { apikey: ANON_KEY, "content-type": "application/json" },
    tags: { kind: "auth" },
  });
  if (res.status !== 200) return null;
  return res.json();
}

/**
 * The cookie @supabase/ssr 0.5 reads: sb-<project ref>-auth-token holding "base64-" and the session
 * in base64url, split into .0, .1 ... pieces past 3180 characters (its MAX_CHUNK_SIZE).
 */
export function sessionCookie(session) {
  const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
  const name = `sb-${ref}-auth-token`;
  const value = `base64-${encoding.b64encode(JSON.stringify(session), "rawurl")}`;
  if (value.length <= 3180) return `${name}=${value}`;
  const parts = [];
  for (let i = 0; i * 3180 < value.length; i++) parts.push(`${name}.${i}=${value.slice(i * 3180, (i + 1) * 3180)}`);
  return parts.join("; ");
}

/** Headers for a page or API request to the app as this person. */
export function appHeaders(session, json = false) {
  const headers = { cookie: sessionCookie(session), origin: APP_URL };
  if (json) headers["content-type"] = "application/json";
  return headers;
}

/** Headers for a database function called straight through the API with this person's token. */
export function apiHeaders(session) {
  return { apikey: ANON_KEY, authorization: `Bearer ${session.access_token}`, "content-type": "application/json" };
}

/** A random UUID (v4) without a remote library. */
export function uuid() {
  const b = new Uint8Array(crypto.randomBytes(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Today in South Africa, the day a reading is dated. */
export function todaySast() {
  return new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);
}
