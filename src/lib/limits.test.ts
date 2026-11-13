import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import {
  BUCKETS, LIMITS, MEDIA_CLASSES, PDF_MAX_BYTES, PHOTO_MAX_BYTES, RESUMABLE_THRESHOLD_BYTES,
  STORAGE_GLOBAL_LIMIT_NEEDED_BYTES, FUNCTION_BODY_MAX_BYTES, LEGACY_MULTIPART_MAX_BYTES,
  VOICE_NOTE_MAX_BYTES, maxBytesForMime, mediaClassOf, megabytes, minutes,
} from "./limits";

const SRC = join(import.meta.dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * What a raw byte size looks like when someone writes one in place instead of reading the
 * catalogue. Each pattern names the shape it catches, so a failure says what to move.
 */
const RAW_SIZE_PATTERNS: Array<[string, RegExp]> = [
  ["n * 1024 * 1024 (a binary megabyte figure)", /\b1024\s*\*\s*1024\b/],
  ["n * 1024 (a binary kilobyte figure)", /\b\d+\s*\*\s*1024\b/],
  ["a binary size written out", /\b(?:1_?048_?576|2_?097_?152|4_?194_?304|6_?291_?456|8_?388_?608|10_?485_?760|16_?777_?216|26_?214_?400)\b/],
  ["a constant named for bytes given a number", /\b[A-Z][A-Z0-9_]*(?:BYTES|_MAX_FILE|MAX_SIZE)\s*=\s*\d/],
  ["a file size compared with a number",
    /\b(?:file|blob|photo|voice|proof|audio|clip|upload|bytes|buf)\w*\.(?:size|byteLength)\s*[<>]=?\s*\d[\d_]{2,}/i],
  ["a bounded form read given a number", /readBoundedFormData\([^,]+,\s*\d/],
];

test("no raw byte size outside the limits catalogue", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file).split(sep).join("/");
    if (rel === "lib/limits.ts") continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      for (const [what, pattern] of RAW_SIZE_PATTERNS) {
        if (pattern.test(code)) offenders.push(`src/${rel}:${index + 1} ${what}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `read these from src/lib/limits.ts instead:\n${offenders.join("\n")}`);
});

test("the guard catches each shape it exists for", () => {
  const caught = (line: string) => RAW_SIZE_PATTERNS.some(([, pattern]) => pattern.test(line));
  assert.equal(caught("const MAX_FILE = 8 * 1024 * 1024;"), true);
  assert.equal(caught("const MAX_BODY = 16 * 1024;"), true);
  assert.equal(caught("if (file.size > 8_388_608) return;"), true);
  assert.equal(caught("const PROOF_MAX_BYTES = 4194304;"), true);
  assert.equal(caught("if (bytes.byteLength > 2_000_000) redirect(x);"), true);
  assert.equal(caught("form = await readBoundedFormData(request, 9000000);"), true);
  assert.equal(caught("if (file.size > PHOTO_MAX_BYTES) return;"), false);
  assert.equal(caught("const total = amount_cents * 100;"), false);
  assert.equal(caught("if (buckets.size > 2_000) prune();"), false, "a Map's size is not a file size");
});

test("a declared type maps to its class and limit, and nothing else is accepted", () => {
  assert.equal(mediaClassOf("image/jpeg"), "photo");
  assert.equal(mediaClassOf("IMAGE/HEIC"), "photo");
  assert.equal(mediaClassOf("application/pdf"), "pdf");
  assert.equal(mediaClassOf("audio/webm;codecs=opus"), "voice");
  assert.equal(mediaClassOf("video/webm"), "voice");
  assert.equal(mediaClassOf("audio/mp4", "command_audio"), "command_audio");
  assert.equal(mediaClassOf("video/mp4"), null, "video is not supported at launch");
  assert.equal(mediaClassOf("application/x-msdownload"), null);
  assert.equal(maxBytesForMime("image/png"), PHOTO_MAX_BYTES);
  assert.equal(maxBytesForMime("application/pdf"), PDF_MAX_BYTES);
  assert.equal(maxBytesForMime("audio/ogg"), VOICE_NOTE_MAX_BYTES);
  assert.equal(maxBytesForMime("text/html"), 0);
  assert.equal(maxBytesForMime("video/quicktime"), 0);
});

test("the founder's media limits are decimal and read back as whole numbers", () => {
  // Decimal units (decision 14's convention): 20 MB is 20,000,000 bytes, not 20 MiB.
  assert.equal(megabytes(PHOTO_MAX_BYTES), 20);
  assert.equal(PHOTO_MAX_BYTES % 1_000_000, 0);
  assert.equal(megabytes(PDF_MAX_BYTES), 50);
  assert.equal(minutes(MEDIA_CLASSES.voice.maxMs ?? 0), 10);
  assert.equal(minutes(MEDIA_CLASSES.command_audio.maxMs ?? 0), 10);
});

test("every bucket can hold the largest file of each class it is for, and the project limit covers every bucket", () => {
  const holds: Record<string, Array<keyof typeof MEDIA_CLASSES>> = {
    "machine-photos": ["photo"], "fault-photos": ["photo"], "checklist-photos": ["photo"],
    "fault-voice": ["voice"], "jobcard-photos": ["photo", "pdf"], "machine-docs": ["photo", "pdf"],
    "partner-docs": ["photo", "pdf"], "partner-receipts": ["photo", "pdf"], "finance-docs": ["photo", "pdf"],
    "billing-proofs": ["photo", "pdf"], "command-audio": ["command_audio"],
  };
  for (const [bucket, classes] of Object.entries(holds)) {
    const spec = BUCKETS[bucket as keyof typeof BUCKETS];
    for (const cls of classes) {
      assert.ok(spec.maxBytes >= MEDIA_CLASSES[cls].maxBytes, `${bucket} must take a full-size ${cls}`);
    }
    assert.ok(spec.maxBytes <= STORAGE_GLOBAL_LIMIT_NEEDED_BYTES, `${bucket} exceeds the project limit we ask for`);
  }
});

test("what still passes through a function fits Vercel's body limit; resumable chunks fit under every bucket", () => {
  assert.ok(LEGACY_MULTIPART_MAX_BYTES < FUNCTION_BODY_MAX_BYTES);
  // A file at the resumable threshold is the smallest one sent in chunks; it must be a
  // size every media bucket accepts, or the TUS path would be unreachable for that bucket.
  for (const [bucket, spec] of Object.entries(BUCKETS)) {
    if (bucket === "partner-branding") continue;
    assert.ok(spec.maxBytes > RESUMABLE_THRESHOLD_BYTES, `${bucket} must accept a resumable upload`);
  }
});

test("every catalogue entry is labelled and positive", () => {
  for (const [name, entry] of Object.entries(LIMITS)) {
    assert.ok(entry.value > 0, `${name} must be positive`);
    assert.ok(["commercial", "abuse", "provider", "window"].includes(entry.kind), `${name} has a kind`);
    assert.ok(entry.why.length > 10, `${name} says why`);
  }
});
