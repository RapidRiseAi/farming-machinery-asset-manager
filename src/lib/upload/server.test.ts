import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { beginUpload, commitUpload, parseBeginInput, refusalFromDb, verifyUpload, type IntentRow, type ObjectReader } from "./server";
import { jpeg, oggOpus, pdf } from "./media-fixtures";
import { PHOTO_MAX_BYTES, RESUMABLE_THRESHOLD_BYTES } from "@/lib/limits";

const FARM = "a1000000-0000-4000-9000-000000000001";
const MACHINE = "a1200000-0000-4000-9000-000000000001";
const USER = "a1100000-0000-4000-9000-000000000001";
const INTENT = "a1900000-0000-4000-9000-000000000001";

type Call = { fn: string; args: unknown };

function fakeDb(answers: Record<string, { data?: unknown; error?: { code?: string; message?: string } | null }>) {
  const calls: Call[] = [];
  const db = {
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      const answer = answers[fn] ?? { data: null, error: null };
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

function fakeSvc(intent: Partial<IntentRow> | null, rpcAnswers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const removed: string[] = [];
  const svc = {
    from() {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: intent, error: null }) };
      return q;
    },
    async rpc(fn: string, args: unknown) {
      calls.push({ fn, args });
      return { data: rpcAnswers[fn] ?? null, error: null };
    },
    storage: {
      from(bucket: string) {
        return {
          async createSignedUploadUrl(path: string) {
            return { data: { signedUrl: `https://project.supabase.co/storage/v1/object/upload/sign/${bucket}/${path}?token=t`, token: "t", path }, error: null };
          },
          async remove(paths: string[]) { removed.push(...paths.map((p) => `${bucket}/${p}`)); return { data: null, error: null }; },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { svc, calls, removed };
}

function readerOf(file: Uint8Array | null): ObjectReader & { reads: number } {
  const reader = {
    reads: 0,
    async read(_bucket: string, _path: string, start: number, end: number) {
      reader.reads++;
      if (!file) return null;
      return { bytes: file.subarray(start, Math.min(end + 1, file.length)), total: file.length };
    },
  };
  return reader;
}

const input = (bytes: number, mime = "image/jpeg") => parseBeginInput({
  target: { kind: "machine", id: MACHINE, farmId: FARM }, label: "photo", mediaClass: mime.startsWith("image") ? "photo" : "pdf",
  mime, bytes, requestId: "a1800000-0000-4000-9000-000000000001",
})!;

const reserved = { id: INTENT, bucket: "machine-photos", object_path: `${FARM}/${MACHINE}/photo-${INTENT}.jpg`, expires_at: "2026-11-14T12:00:00Z", status: "reserved", failure: null };

test("begin refuses what the catalogue refuses before asking the database", async () => {
  const { db, calls } = fakeDb({});
  const { svc } = fakeSvc(null);
  assert.deepEqual(await beginUpload(db, svc, input(PHOTO_MAX_BYTES + 1), "https://p.supabase.co"), { state: "refused", code: "upload-too-large", status: 413 });
  assert.deepEqual(await beginUpload(db, svc, input(1000, "image/gif"), "https://p.supabase.co"), { state: "refused", code: "upload-wrong-type", status: 415 });
  // The project's Storage limit set below what the app accepts: refused up front, with its own sentence.
  assert.deepEqual(await beginUpload(db, svc, input(10_000_000), "https://p.supabase.co", 5_000_000),
    { state: "refused", code: "upload-too-large-for-storage", status: 413 });
  assert.equal(calls.length, 0);
  assert.equal(parseBeginInput({ target: { kind: "machine", id: "not-a-uuid", farmId: FARM } }), null);
  assert.equal(parseBeginInput({ ...input(1), target: { kind: "machine", id: MACHINE, farmId: FARM, workshopId: FARM } }), null);
});

test("begin signs the reserved path; small files go in one PUT, larger ones resumable", async () => {
  const { db, calls } = fakeDb({ upload_begin: { data: reserved } });
  const { svc } = fakeSvc(null);
  const small = await beginUpload(db, svc, input(RESUMABLE_THRESHOLD_BYTES), "https://p.supabase.co/");
  assert.equal(small.state, "upload");
  if (small.state !== "upload") return;
  assert.equal(small.resumable, false);
  assert.equal(small.path, reserved.object_path);
  assert.equal(small.tusEndpoint, "https://p.supabase.co/storage/v1/upload/resumable/sign");
  const large = await beginUpload(db, svc, input(RESUMABLE_THRESHOLD_BYTES + 1), "https://p.supabase.co");
  assert.equal(large.state === "upload" && large.resumable, true);
  assert.deepEqual((calls[0].args as Record<string, unknown>).p_ext, "jpg");
});

test("begin passes on what the database says: finished, already uploaded, refusals", async () => {
  const { svc } = fakeSvc(null);
  const done = await beginUpload(fakeDb({ upload_begin: { data: { ...reserved, status: "finalised" } } }).db, svc, input(1000), "https://p");
  assert.deepEqual(done, { state: "finalised", intentId: INTENT });
  const up = await beginUpload(fakeDb({ upload_begin: { data: { ...reserved, status: "uploaded" } } }).db, svc, input(1000), "https://p");
  assert.deepEqual(up, { state: "uploaded", intentId: INTENT });
  const full = await beginUpload(fakeDb({ upload_begin: { error: { code: "P0001", message: "upload:storage_full" } } }).db, svc, input(1000), "https://p");
  assert.deepEqual(full, { state: "refused", code: "upload-storage-full", status: 507 });
  assert.deepEqual(refusalFromDb({ code: "42501", message: "farm-not-active" }), { state: "refused", code: "farm-not-active", status: 402 });
  assert.deepEqual(refusalFromDb({ code: "42501", message: "forbidden" }), { state: "refused", code: "forbidden", status: 403 });
});

test("scenario 25: a full pool tells the owners (the refusal rolled its own work back), and the answer stays the refusal", async () => {
  const { svc } = fakeSvc(null);
  const fake = fakeDb({
    upload_begin: { error: { code: "P0001", message: "upload:storage_full" } },
    storage_note_full: { error: { code: "XX000", message: "boom" } },
  });
  const full = await beginUpload(fake.db, svc, input(1000), "https://p");
  assert.deepEqual(full, { state: "refused", code: "upload-storage-full", status: 507 });
  assert.deepEqual(fake.calls.map((c) => c.fn), ["upload_begin", "storage_note_full"]);
  assert.deepEqual(fake.calls[1].args, { p_farm: FARM });
  // Any other refusal tells nobody.
  const big = fakeDb({ upload_begin: { error: { code: "P0001", message: "upload:too_large" } } });
  await beginUpload(big.db, svc, input(1000), "https://p");
  assert.deepEqual(big.calls.map((c) => c.fn), ["upload_begin"]);
  assert.deepEqual(refusalFromDb({ code: "42501", message: "forbidden" }), { state: "refused", code: "forbidden", status: 403 });
});

const intentRow = (over: Partial<IntentRow> = {}): IntentRow => ({
  id: INTENT, user_id: USER, farm_id: FARM, workshop_id: null, target_kind: "machine", target_id: MACHINE,
  bucket: "machine-photos", object_path: reserved.object_path, media_class: "photo", declared_mime: "image/jpeg",
  status: "reserved", failure: null, actual_bytes: null, actual_mime: null, duration_ms: null, record_id: null, ...over,
});

test("scenario 23: an upload that never arrived is not judged and keeps its reservation", async () => {
  const { svc, calls, removed } = fakeSvc(intentRow());
  const answer = await verifyUpload(svc, readerOf(null), INTENT, USER);
  assert.deepEqual(answer, { state: "refused", code: "upload-not-received", status: 409 });
  assert.deepEqual(calls, []);
  assert.deepEqual(removed, []);
});

test("scenario 21: a PDF uploaded as a photo is refused, recorded as failed and removed", async () => {
  const { svc, calls, removed } = fakeSvc(intentRow());
  const answer = await verifyUpload(svc, readerOf(pdf()), INTENT, USER);
  assert.deepEqual(answer, { state: "refused", code: "upload-wrong-type", status: 415 });
  assert.deepEqual(calls.map((c) => c.fn), ["upload_fail"]);
  assert.deepEqual(removed, [`machine-photos/${reserved.object_path}`]);
});

test("a real photo is verified with what its bytes say, and only the ends of a large file are read", async () => {
  const photo = jpeg(4000, 3000, 0, 600_000);
  const { svc, calls } = fakeSvc(intentRow(), { upload_mark_verified: "uploaded" });
  const reader = readerOf(photo);
  const answer = await verifyUpload(svc, reader, INTENT, USER);
  assert.equal(answer.state, "verified");
  assert.equal(reader.reads, 2, "head and tail, never the whole file");
  assert.deepEqual(calls[0], { fn: "upload_mark_verified", args: {
    p_intent: INTENT, p_actual_bytes: photo.length, p_actual_mime: "image/jpeg", p_duration_ms: null, p_width: 4000, p_height: 3000 } });
});

test("scenario 23: verifying again after a lost response does no second work", async () => {
  const { svc, calls } = fakeSvc(intentRow({ status: "uploaded", actual_bytes: 10, actual_mime: "image/jpeg" }));
  const reader = readerOf(jpeg(10, 10));
  const answer = await verifyUpload(svc, reader, INTENT, USER);
  assert.equal(answer.state, "verified");
  assert.equal(reader.reads, 0);
  assert.deepEqual(calls, []);
});

test("another person's intent, and an expired one, are refused", async () => {
  assert.deepEqual(await verifyUpload(fakeSvc(intentRow()).svc, readerOf(jpeg(1, 1)), INTENT, "a1100000-0000-4000-9000-000000000009"),
    { state: "refused", code: "forbidden", status: 403 });
  assert.deepEqual(await verifyUpload(fakeSvc(intentRow({ status: "expired" })).svc, readerOf(jpeg(1, 1)), INTENT, USER),
    { state: "refused", code: "upload-expired", status: 410 });
});

test("a ten-minute recording is verified with its length", async () => {
  const note = oggOpus(600);
  const { svc, calls } = fakeSvc(intentRow({ media_class: "voice", bucket: "fault-voice", declared_mime: "audio/ogg" }), { upload_mark_verified: "uploaded" });
  const answer = await verifyUpload(svc, readerOf(note), INTENT, USER);
  assert.equal(answer.state, "verified");
  assert.equal((calls[0].args as Record<string, unknown>).p_duration_ms, 600_000);
});

test("scenario 23: membership revoked between begin and commit removes the file and frees the space", async () => {
  const { db } = fakeDb({ upload_commit: { error: { code: "42501", message: "forbidden" } } });
  const { svc, calls, removed } = fakeSvc(null);
  const answer = await commitUpload(db, svc, intentRow({ status: "uploaded" }));
  assert.deepEqual(answer, { state: "refused", code: "forbidden", status: 403 });
  assert.deepEqual(calls.map((c) => c.fn), ["upload_fail"]);
  assert.equal(removed.length, 1);
});

test("a commit answers the record, the same on a retry", async () => {
  const { db } = fakeDb({ upload_commit: { data: { status: "finalised", record_id: INTENT, reused: true } } });
  const { svc, removed } = fakeSvc(null);
  assert.deepEqual(await commitUpload(db, svc, intentRow({ status: "uploaded" })), { state: "finalised", recordId: INTENT });
  assert.deepEqual(removed, []);
});

test("every refusal the pipeline gives has a sentence in both languages, with the catalogue's numbers", async () => {
  const { errorMessage } = await import("@/lib/errors");
  const codes = ["upload-too-large", "upload-too-large-for-storage", "upload-wrong-type", "upload-storage-full",
    "upload-target", "upload-too-many", "upload-request-reused", "upload-expired", "upload-too-long",
    "upload-not-received", "upload-malformed", "upload-too-many-pixels", "upload-unsupported-codec",
    "upload-video-not-supported", "upload-empty", "upload-not-attached", "upload-unavailable", "upload-interrupted"];
  const generic = errorMessage("no-such-code-at-all", "en");
  for (const code of codes) {
    for (const lang of ["en", "af"] as const) {
      const text = errorMessage(code, lang) ?? "";
      assert.notEqual(text, generic, `${code} has its own sentence in ${lang}`);
      assert.doesNotMatch(text, /\{(photoMb|pdfMb|voiceMb|minutes)\}/, `${code} in ${lang} fills its numbers`);
    }
  }
  assert.match(errorMessage("upload-too-large", "en") ?? "", /20 MB.*50 MB.*20 MB/);
  assert.match(errorMessage("upload-too-long", "af") ?? "", /10 minute/);
});
