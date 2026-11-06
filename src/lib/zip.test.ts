import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as nodeCrc32 } from "node:zlib";

import { crc32, zipStream } from "./zip";

async function* entries(list: { name: string; bytes: Uint8Array }[]) {
  for (const e of list) yield e;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts);
    parts.push(value);
  }
}

const hello = new TextEncoder().encode("hello");

test("the checksum matches Node's own", () => {
  assert.equal(crc32(hello), nodeCrc32(hello));
  assert.equal(crc32(new Uint8Array()), 0);
});

test("the end of the file says how many entries there are and where they start", async () => {
  const zip = await collect(zipStream(entries([{ name: "a.txt", bytes: hello }, { name: "b/c.txt", bytes: hello }])));
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  assert.equal(zip.readUInt16LE(end + 10), 2);
  const directory = zip.readUInt32LE(end + 16);
  assert.equal(zip.readUInt32LE(directory), 0x02014b50);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
});

test("a real unzip program reads it back byte for byte", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fw-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const photo = new Uint8Array(5000).map((_, i) => i % 251);
  const file = join(dir, "out.zip");
  writeFileSync(file, await collect(zipStream(entries([
    { name: "machine-photos/a/one.jpg", bytes: photo },
    { name: "notes/hello.txt", bytes: hello },
  ]))));
  try {
    execFileSync("tar", ["-xf", file, "-C", dir], { stdio: "pipe" });
  } catch {
    t.skip("no tar that reads zip on this machine");
    return;
  }
  assert.deepEqual(new Uint8Array(readFileSync(join(dir, "machine-photos/a/one.jpg"))), photo);
  assert.equal(readFileSync(join(dir, "notes/hello.txt"), "utf8"), "hello");
});

test("a file that cannot be read fails the download instead of ending it early", async () => {
  async function* broken() {
    yield { name: "a.txt", bytes: hello };
    throw new Error("storage went away");
  }
  await assert.rejects(collect(zipStream(broken())), /storage went away/);
});
