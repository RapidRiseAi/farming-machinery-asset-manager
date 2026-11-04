import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { processWhatsAppInbox, workerDeps } from "./worker";
import { JPEG, voiceNote } from "./media-fixtures";

/**
 * Voice notes and photos through the whole worker (20261104210000), against mocked Meta
 * and database endpoints: what is fetched, what is written and with whose credential,
 * and what the person is sent.
 */

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://database.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-public",
  NEXT_PUBLIC_SITE_URL: "https://fleetwise.example.test", SUPABASE_SERVICE_ROLE_KEY: "test-server",
  WHATSAPP_ENABLED: "1", WHATSAPP_GRAPH_VERSION: "v25.0", WHATSAPP_PHONE_NUMBER_ID: "100",
  WHATSAPP_ACCESS_TOKEN: "test-access", WHATSAPP_BUSINESS_ACCOUNT_ID: "200", WHATSAPP_BUSINESS_PHONE: "27820000000",
  WHATSAPP_APP_SECRET: "test-app", WHATSAPP_VERIFY_TOKEN: "test-verify",
  WHATSAPP_AUTH_PRIVATE_JWK: JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid: "test-only" }),
};

type Inbox = { message_text: string; media_kind?: string; media_id?: string };
type World = {
  inbox: Inbox;
  conversation: unknown;
  profile?: Record<string, unknown>;
  media?: Uint8Array;
  faults?: { id: string; machine_id: string; description: string }[];
  staged?: Record<string, unknown> | null;
};
type Seen = {
  sent: string; conversation: unknown; requests: string[];
  attachments: { body: Record<string, unknown>; sub: string | null }[];
  mediaPatches: Record<string, unknown>[]; uploads: string[]; removals: unknown[];
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const subOf = (init?: RequestInit) => {
  const token = new Headers(init?.headers).get("Authorization")?.replace("Bearer ", "") ?? "";
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).sub ?? null; } catch { return null; }
};

async function run(world: World): Promise<Seen> {
  const seen: Seen = { sent: "", conversation: undefined, requests: [], attachments: [], mediaPatches: [], uploads: [], removals: [] };
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  const original = globalThis.fetch;
  Object.assign(process.env, ENV);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    seen.requests.push(`${method} ${url.hostname}${url.pathname}`);
    if (url.hostname === "graph.facebook.com") {
      if (method === "POST") { seen.sent = body.text.body; return json({ messages: [{ id: "wamid.reply" }] }); }
      return json({ url: "https://lookaside.fbsbx.com/media", file_size: world.media?.length ?? 0 });
    }
    if (url.hostname === "lookaside.fbsbx.com") return new Response(world.media ? world.media.slice() : null);
    assert.equal(url.hostname, "database.example.test", `unexpected host ${url.hostname}`);
    if (url.pathname.startsWith("/storage/v1/object/")) {
      if (method === "DELETE") { seen.removals.push(body); return json([]); }
      seen.uploads.push(url.pathname.replace("/storage/v1/object/", ""));
      return json({ Key: "ok" });
    }
    const route = url.pathname.replace("/rest/v1/", "");
    if (route === "rpc/whatsapp_claim") return json([{ id: "inbox-1", link_id: "link", message_at: new Date().toISOString(),
      reply: null, media_kind: null, media_id: null, media_mime: null, ...world.inbox }]);
    if (route === "rpc/whatsapp_delivery_target") return json({ id: "link", user_id: "employee", farm_id: "farm",
      phone: "27820000001", revoked_at: null, assistant_enabled: true,
      expires_at: new Date(Date.now() + 3600000).toISOString(), assistant_until: new Date(Date.now() + 3600000).toISOString(),
      conversation: world.conversation, conversation_at: world.conversation ? new Date().toISOString() : null,
      conversation_authority_tag: "tag", authority_tag: "tag" });
    if (route === "rpc/whatsapp_assistant_role") return json("mechanic");
    if (route === "users") return json({ id: "employee", active: true, language: "en", tone: "friendly", ...world.profile });
    if (route === "rpc/whatsapp_save_reply") { seen.conversation = body.p_conversation; return json(true); }
    if (route === "whatsapp_links" && method === "PATCH") return json(null);
    if (route === "whatsapp_inbox" && method === "PATCH") return json(url.searchParams.has("select") ? { id: "inbox-1" } : null);
    if (route === "machines" && url.searchParams.get("id")?.startsWith("in.")) return json([{ id: "m1", name: "JD 6120" }]);
    if (route === "machines") return json([]);
    if (route === "faults" && url.searchParams.get("id")) {
      assert.equal(subOf(init), "employee", "the fault is read as the person, not the service");
      return json(world.faults?.find((f) => `eq.${f.id}` === url.searchParams.get("id")) ? { id: url.searchParams.get("id")!.slice(3) } : null);
    }
    if (route === "faults") { assert.equal(subOf(init), "employee"); return json(world.faults ?? []); }
    if (route === "whatsapp_media" && method === "GET") return json(world.staged ?? null);
    if (route === "whatsapp_media" && method === "POST") {
      return json({ id: "media-row", storage_path: body.storage_path, farm_id: body.farm_id, state: "staged" });
    }
    if (route === "whatsapp_media" && method === "PATCH") { seen.mediaPatches.push(body); return json(null); }
    if (route === "attachments" && method === "POST") { seen.attachments.push({ body, sub: subOf(init) }); return json(null, 201); }
    throw new Error(`Unexpected mock route ${method} ${route}`);
  };
  try {
    const result = await processWhatsAppInbox();
    assert.equal(result.processed, 1);
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return seen;
}

const AI_ON = { ai_notice_seen_at: "2026-10-01T00:00:00Z", ai_processing_opt_in: true, ai_processing_withdrawn_at: null };

test("a photo is staged in the farm's folder and the person is asked what it is for", async () => {
  const seen = await run({ inbox: { message_text: "leak under the cab", media_kind: "image", media_id: "img-1" }, conversation: null, media: JPEG });
  assert.equal(seen.uploads.length, 1);
  assert.match(seen.uploads[0], /^fault-photos\/farm\/whatsapp\/link\/[a-f0-9]{32}\.jpg$/);
  assert.match(seen.sent, /Photo received\.\nCaption: leak under the cab\nWhat is it for\?/);
  assert.deepEqual(seen.conversation, { kind: "photo", mediaId: "media-row", stage: "choose", caption: "leak under the cab" });
});

test("a file that is not an image is not stored, whatever it was labelled", async () => {
  const seen = await run({ inbox: { message_text: "", media_kind: "image", media_id: "img-2" }, conversation: null,
    media: new TextEncoder().encode("<svg onload=alert(1)>") });
  assert.equal(seen.uploads.length, 0);
  assert.match(seen.sent, /could not be read/);
  assert.equal(seen.conversation, null);
});

test("adding a photo to a logged fault: the list, then the attachment, written as the person", async () => {
  const faults = [{ id: "fault-1", machine_id: "m1", description: "Hydraulic leak" }];
  const choose = { kind: "photo", mediaId: "media-row", stage: "choose", caption: null };
  const listed = await run({ inbox: { message_text: "2" }, conversation: choose, faults });
  assert.match(listed.sent, /Which problem does the photo belong to\?.*\n1\. JD 6120: Hydraulic leak/s);
  assert.deepEqual(listed.conversation, { ...choose, stage: "pick_fault", faults: [{ id: "fault-1", label: "JD 6120: Hydraulic leak" }] });

  const attached = await run({ inbox: { message_text: "1" }, conversation: listed.conversation, faults,
    staged: { id: "media-row", storage_path: "farm/whatsapp/link/abc.jpg", farm_id: "farm", state: "staged" } });
  assert.equal(attached.attachments.length, 1);
  assert.equal(attached.attachments[0].sub, "employee", "the attachment goes in under the person's own access");
  assert.deepEqual(attached.attachments[0].body, { id: "media-row", farm_id: "farm", parent_type: "fault", parent_id: "fault-1",
    kind: "photo", storage_path: "farm/whatsapp/link/abc.jpg", created_by: "employee" });
  assert.equal(attached.mediaPatches[0].state, "attached");
  assert.match(attached.sent, /Photo added to: JD 6120: Hydraulic leak\nhttps:\/\/fleetwise\.example\.test\/faults/);
  assert.equal(attached.conversation, null);
});

test("a photo for a fault the person cannot see is not attached", async () => {
  const pick = { kind: "photo", mediaId: "media-row", stage: "pick_fault", caption: null, faults: [{ id: "hidden", label: "X" }] };
  const seen = await run({ inbox: { message_text: "1" }, conversation: pick, faults: [],
    staged: { id: "media-row", storage_path: "farm/whatsapp/link/abc.jpg", farm_id: "farm", state: "staged" } });
  assert.equal(seen.attachments.length, 0);
  assert.match(seen.sent, /could not be added/);
});

test("discarding a photo removes the object and records why", async () => {
  const seen = await run({ inbox: { message_text: "3" }, conversation: { kind: "photo", mediaId: "media-row", stage: "choose", caption: null },
    staged: { id: "media-row", storage_path: "farm/whatsapp/link/abc.jpg", state: "staged" } });
  assert.deepEqual(seen.removals, [{ prefixes: ["farm/whatsapp/link/abc.jpg"] }]);
  assert.equal(seen.mediaPatches[0].state, "discarded");
  assert.match(seen.sent, /Photo discarded\. Nothing was saved\./);
});

test("a voice note is heard and answered as if typed, with what was heard shown first", async () => {
  const original = workerDeps.transcribeVoiceNote;
  const calls: { durationMs: number; farmId: string; userId: string }[] = [];
  workerDeps.transcribeVoiceNote = async (input) => { calls.push(input); return { ok: true, text: "help" }; };
  try {
    const seen = await run({ inbox: { message_text: "", media_kind: "audio", media_id: "aud-1" }, conversation: null,
      media: voiceNote(5), profile: AI_ON });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].durationMs, 5000);
    assert.equal(calls[0].farmId, "farm");
    assert.equal(calls[0].userId, "employee");
    assert.match(seen.sent, /^Heard: "help"\n\nFor help from a person/);
  } finally {
    workerDeps.transcribeVoiceNote = original;
  }
});

test("a voice note is not sent to a speech model when AI help is off, too long, or not a voice note", async () => {
  const original = workerDeps.transcribeVoiceNote;
  let called = 0;
  workerDeps.transcribeVoiceNote = async () => { called++; return { ok: true, text: "x" }; };
  try {
    const off = await run({ inbox: { message_text: "", media_kind: "audio", media_id: "a" }, conversation: null, media: voiceNote(5) });
    assert.match(off.sent, /AI help, which is switched off/);
    const long = await run({ inbox: { message_text: "", media_kind: "audio", media_id: "a" }, conversation: null,
      media: voiceNote(200), profile: AI_ON });
    assert.match(long.sent, /up to 3 minutes/);
    const mp3 = await run({ inbox: { message_text: "", media_kind: "audio", media_id: "a" }, conversation: null,
      media: new TextEncoder().encode("ID3........................................................"), profile: AI_ON });
    assert.match(mp3.sent, /could not be played/);
    assert.equal(called, 0);
  } finally {
    workerDeps.transcribeVoiceNote = original;
  }
});

test("a voice note at the spending limit says so, and keeps what was waiting", async () => {
  const original = workerDeps.transcribeVoiceNote;
  workerDeps.transcribeVoiceNote = async () => ({ ok: false, reason: "farm_limit" });
  const waiting = { kind: "photo", mediaId: "media-row", stage: "describe", caption: null };
  try {
    const seen = await run({ inbox: { message_text: "", media_kind: "audio", media_id: "a" }, conversation: waiting,
      media: voiceNote(4), profile: AI_ON });
    assert.match(seen.sent, /spending limit/);
    assert.deepEqual(seen.conversation, waiting);
  } finally {
    workerDeps.transcribeVoiceNote = original;
  }
});

test("documents and videos get the new explanation, not a model call", async () => {
  const seen = await run({ inbox: { message_text: "[unsupported message]" }, conversation: null });
  assert.match(seen.sent, /I can read text messages, voice notes and photos/);
  assert.ok(!seen.requests.some((r) => r.includes("lookaside")));
});
