import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readExportFiles } from "./farm-export-files";

function storage(refuse = false) {
  const reads: string[] = [];
  const session = { storage: { from: (bucket: string) => ({ download: async (path: string) => {
    reads.push(`${bucket}/${path}`);
    return refuse ? { data: null, error: { message: "not allowed" } } : { data: new Blob(["evidence"]), error: null };
  } }) } } as unknown as SupabaseClient;
  return { session, reads };
}

test("file bytes are read through the supplied requester session, one file at a time", async () => {
  const { session, reads } = storage();
  const iterator = readExportFiles(session, [{ bucket_id: "machine-docs", name: "f/a.pdf" }, { bucket_id: "machine-docs", name: "f/b.pdf" }], "f");
  assert.equal(reads.length, 0);
  const first = await iterator.next();
  assert.deepEqual(reads, ["machine-docs/f/a.pdf"]);
  assert.equal(new TextDecoder().decode(first.value?.bytes), "evidence");
  await iterator.next();
  assert.equal(reads.length, 2);
  assert.equal((await iterator.next()).done, true);
});

test("a restricted or missing file cannot be presented as a successful complete ZIP", async () => {
  const { session } = storage(true);
  await assert.rejects(readExportFiles(session, [{ bucket_id: "finance-docs", name: "f/restricted.pdf" }], "f").next(), /file unavailable/);
});

test("chat, command audio and another business's files are refused before any read", async () => {
  const { session, reads } = storage();
  for (const file of [{ bucket_id: "chat-files", name: "f/private.ogg" }, { bucket_id: "command-audio", name: "f/command.ogg" }, { bucket_id: "machine-docs", name: "other/file.pdf" }]) {
    await assert.rejects(readExportFiles(session, [file], "f").next());
  }
  assert.deepEqual(reads, []);
});

test("both HTTP paths use lifecycle refusal and file downloads use the session client", () => {
  for (const path of ["../app/api/farm/export/route.ts", "../app/api/farm/export/files/route.ts"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /exportRefusal\(role, lifecycle\?\.gate \?\? null, lifecycle\)/);
    assert.match(source, /if \(refusal\) return NextResponse\.json/);
  }
  const source = readFileSync(new URL("../app/api/farm/export/files/route.ts", import.meta.url), "utf8");
  assert.match(source, /readExportFiles\(session, files, farmId\)/);
  assert.doesNotMatch(source, /svc\.storage/);
});
