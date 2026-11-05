import assert from "node:assert/strict";
import test from "node:test";
import { uploadWorkRequestMedia } from "./workrequest-media";

/** A storage and attachments fake that remembers what was stored. */
function fakeService() {
  const objects = new Set<string>();
  const rows = new Map<string, Record<string, unknown>>();
  const calls = { uploads: 0, upserts: 0 };
  const svc = {
    storage: {
      from: () => ({
        upload: async (path: string) => {
          calls.uploads++;
          if (objects.has(path)) return { data: null, error: { statusCode: "409", message: "exists" } };
          objects.add(path);
          return { data: { path }, error: null };
        },
        remove: async (paths: string[]) => { paths.forEach((p) => objects.delete(p)); return { data: [], error: null }; },
      }),
    },
    from: () => {
      let id = "";
      const q = {
        select: () => q,
        eq: (_c: string, v: string) => { id = v; return q; },
        is: () => q,
        maybeSingle: async () => ({ data: rows.has(id) ? { id } : null, error: null }),
        upsert: async (row: Record<string, unknown>) => {
          calls.upserts++;
          if (!rows.has(String(row.id))) rows.set(String(row.id), row);
          return { error: null };
        },
      };
      return q;
    },
  };
  return { svc: svc as never, objects, rows, calls };
}

const photo = (bytes: number[]) => new File([new Uint8Array(bytes)], "p.jpg", { type: "image/jpeg" });

test("the same photo uploaded twice for one work request is stored once", async () => {
  const f = fakeService();
  assert.equal(await uploadWorkRequestMedia(f.svc, photo([1, 2, 3]), "photo", "farm", "wr", "user"), true);
  assert.equal(await uploadWorkRequestMedia(f.svc, photo([1, 2, 3]), "photo", "farm", "wr", "user"), true);
  assert.equal(f.rows.size, 1, "one attachment row");
  assert.equal(f.objects.size, 1, "one stored object");
  assert.equal(f.calls.uploads, 1, "the second tap found the first and uploaded nothing");
});

test("a different photo, or the same photo on another request, is its own attachment", async () => {
  const f = fakeService();
  await uploadWorkRequestMedia(f.svc, photo([1, 2, 3]), "photo", "farm", "wr", "user");
  await uploadWorkRequestMedia(f.svc, photo([4, 5, 6]), "photo", "farm", "wr", "user");
  await uploadWorkRequestMedia(f.svc, photo([1, 2, 3]), "photo", "farm", "wr-2", "user");
  assert.equal(f.rows.size, 3);
});

test("a lost response (object stored, row not) is completed on the retry, not duplicated", async () => {
  const f = fakeService();
  await uploadWorkRequestMedia(f.svc, photo([7, 8, 9]), "photo", "farm", "wr", "user");
  f.rows.clear(); // as if the row write was lost after the object landed
  assert.equal(await uploadWorkRequestMedia(f.svc, photo([7, 8, 9]), "photo", "farm", "wr", "user"), true);
  assert.equal(f.rows.size, 1);
  assert.equal(f.objects.size, 1);
});
