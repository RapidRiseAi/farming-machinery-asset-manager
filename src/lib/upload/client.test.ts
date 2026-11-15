import assert from "node:assert/strict";
import test from "node:test";
import { stableRequestId, uploadFile, type UploadProgress } from "./client";
import type { HttpRequest, Transport } from "./tus";
import { RESUMABLE_CHUNK_BYTES } from "@/lib/limits";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key-for-tests";

const INTENT = "a1900000-0000-4000-9000-000000000001";
const TARGET = { kind: "fault" as const, id: "a1300000-0000-4000-9000-000000000001", farmId: "a1000000-0000-4000-9000-000000000001" };

/** A stand-in TUS server: keeps the bytes it was sent, can drop a request after N chunks. */
function tusServer(options: { dropAfterChunks?: number; forgetUploads?: boolean } = {}) {
  const uploads = new Map<string, number>();
  const log: string[] = [];
  let chunks = 0;
  let next = 1;
  const transport: Transport = async (request: HttpRequest) => {
    log.push(`${request.method} ${request.url.replace(/^https:\/\/project\.supabase\.co/, "")}`);
    if (request.signal?.aborted) throw new DOMException("Paused", "AbortError");
    const header = (map: Record<string, string>) => (name: string) => map[name] ?? null;
    if (request.method === "POST") {
      assert.equal(request.headers["x-signature"], "signed-token", "the signed token goes in x-signature");
      assert.equal(request.headers["x-upsert"], "false", "never overwrites");
      const url = `/storage/v1/upload/resumable/sign/upload-${next++}`;
      uploads.set(url, 0);
      return { status: 201, header: header({ Location: url }) };
    }
    const path = request.url.replace(/^https:\/\/project\.supabase\.co/, "");
    if (request.method === "HEAD") {
      if (options.forgetUploads || !uploads.has(path)) return { status: 404, header: header({}) };
      return { status: 200, header: header({ "Upload-Offset": String(uploads.get(path)) }) };
    }
    if (request.method === "PATCH") {
      if (options.dropAfterChunks !== undefined && chunks >= options.dropAfterChunks) {
        options.dropAfterChunks = undefined;
        throw new Error("network lost");
      }
      const offset = Number(request.headers["Upload-Offset"]);
      assert.equal(offset, uploads.get(path), "each chunk starts where the server is");
      const size = request.body?.size ?? 0;
      request.onProgress?.(size);
      uploads.set(path, offset + size);
      chunks++;
      return { status: 204, header: header({ "Upload-Offset": String(offset + size) }) };
    }
    if (request.method === "PUT") return { status: 200, header: header({}) };
    return { status: 405, header: header({}) };
  };
  return { transport, uploads, log };
}

function api(resumable: boolean, finalise: { status: number; body: unknown } = { status: 200, body: { ok: true, recordId: INTENT } }) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url === "/api/uploads/begin") {
      return new Response(JSON.stringify({
        state: "upload", intentId: INTENT, bucket: "fault-voice", path: "farm/fault/voice-x.webm", token: "signed-token",
        signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/fault-voice/farm/fault/voice-x.webm?token=signed-token",
        resumable, tusEndpoint: "https://project.supabase.co/storage/v1/upload/resumable/sign",
        chunkBytes: RESUMABLE_CHUNK_BYTES, expiresAt: "2026-11-14T12:00:00Z",
      }), { status: 200 });
    }
    return new Response(JSON.stringify(finalise.body), { status: finalise.status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

const file = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: "audio/webm" });

test("a small file goes in one signed PUT, then the server judges and saves it", async () => {
  const server = tusServer();
  const { fetchImpl, calls } = api(false);
  const seen: UploadProgress[] = [];
  const outcome = await uploadFile({
    file: file(1000), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: server.transport, fetchImpl, storage: memoryStorage(), onProgress: (p) => seen.push(p),
  });
  assert.deepEqual(outcome, { ok: true, intentId: INTENT, recordId: INTENT });
  assert.deepEqual(server.log, ["PUT /storage/v1/object/upload/sign/fault-voice/farm/fault/voice-x.webm?token=signed-token"]);
  assert.deepEqual(calls, ["/api/uploads/begin", "/api/uploads/finalise"]);
  assert.deepEqual(seen.map((p) => p.phase).filter((p, i, a) => a.indexOf(p) === i), ["starting", "sending", "checking", "done"]);
});

test("scenario 23: a large file interrupted mid-way resumes from where the server got to, never twice", async () => {
  const size = RESUMABLE_CHUNK_BYTES * 3 + 123;
  const server = tusServer({ dropAfterChunks: 2 });
  const storage = memoryStorage();
  const first = await uploadFile({
    file: file(size), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: server.transport, fetchImpl: api(true).fetchImpl, storage,
  });
  assert.deepEqual(first, { ok: false, code: "upload-interrupted", intentId: INTENT });
  assert.equal([...server.uploads.values()][0], RESUMABLE_CHUNK_BYTES * 2, "two chunks landed before the drop");
  // Tried again (the same tab, or after a reload with the same file): HEAD, then only what is missing.
  server.log.length = 0;
  const again = await uploadFile({
    file: file(size), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: server.transport, fetchImpl: api(true).fetchImpl, storage,
  });
  assert.equal(again.ok, true);
  assert.deepEqual(server.log.map((l) => l.split(" ")[0]), ["HEAD", "PATCH", "PATCH"]);
  assert.equal([...server.uploads.values()][0], size);
  assert.equal(storage.data.size, 0, "a finished upload forgets its resume point");
});

test("scenario 23: pausing stops the upload and keeps its place", async () => {
  const size = RESUMABLE_CHUNK_BYTES * 2 + 5;
  const server = tusServer();
  const controller = new AbortController();
  controller.abort();
  const paused = await uploadFile({
    file: file(size), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: server.transport, fetchImpl: api(true).fetchImpl, storage: memoryStorage(), signal: controller.signal,
  });
  assert.equal(paused.ok, false);
  assert.equal(!paused.ok && paused.code, "paused");
});

test("scenario 23: an expired upload URL starts a fresh upload instead of failing", async () => {
  const size = RESUMABLE_CHUNK_BYTES + 10;
  const server = tusServer({ forgetUploads: true });
  const storage = memoryStorage();
  storage.setItem(`fleetwise:upload:${INTENT}`, "https://project.supabase.co/storage/v1/upload/resumable/sign/old-and-gone");
  const outcome = await uploadFile({
    file: file(size), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: server.transport, fetchImpl: api(true).fetchImpl, storage,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(server.log.map((l) => l.split(" ")[0]), ["HEAD", "POST", "PATCH", "PATCH"]);
});

test("a refusal comes back as its code, so the form can say why and keep what was typed", async () => {
  const outcome = await uploadFile({
    file: file(1000), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: tusServer().transport,
    fetchImpl: api(false, { status: 415, body: { error: "upload-wrong-type" } }).fetchImpl, storage: memoryStorage(),
  });
  assert.deepEqual(outcome, { ok: false, code: "upload-wrong-type", intentId: INTENT });
  const refusedAtBegin = await uploadFile({
    file: file(1000), mime: "audio/webm", mediaClass: "voice", target: TARGET, label: "voice", requestId: INTENT,
    finish: "generic", transport: tusServer().transport, storage: memoryStorage(),
    fetchImpl: (async () => new Response(JSON.stringify({ error: "upload-storage-full" }), { status: 507 })) as unknown as typeof fetch,
  });
  assert.deepEqual(refusedAtBegin, { ok: false, code: "upload-storage-full" });
});

test("the request id is the same for the same capture and file, and differs for another", async () => {
  const f = Object.assign(new Blob([new Uint8Array(10)], { type: "image/jpeg" }), { name: "a.jpg", lastModified: 1 });
  const a = await stableRequestId("capture-1|photo", f);
  assert.equal(await stableRequestId("capture-1|photo", f), a);
  assert.notEqual(await stableRequestId("capture-1|voice", f), a);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});
