import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

import { signedUrlsByPath } from "./signed-urls";

/**
 * One request per bucket, answers mapped back by path, and one missing object never blanks
 * the others: the reason the photo pages could move off signing one URL at a time.
 */

type Row = { error: string | null; path: string | null; signedURL: string | null; signedUrl: string | null };

function storage(answer: (paths: string[]) => { data: Row[] | null; error: { message: string } | null }) {
  const calls: { bucket: string; paths: string[]; ttl: number }[] = [];
  const client = {
    storage: {
      from(bucket: string) {
        return {
          async createSignedUrls(paths: string[], ttl: number) {
            calls.push({ bucket, paths, ttl });
            return answer(paths);
          },
        };
      },
    },
  } as unknown as Pick<SupabaseClient, "storage">;
  return { client, calls };
}

const ok = (path: string): Row => ({ error: null, path, signedURL: `/sign/${path}`, signedUrl: `https://s.test/sign/${path}` });

test("every path is signed in one call and found again by its path", async () => {
  const { client, calls } = storage((paths) => ({ data: [...paths].reverse().map(ok), error: null }));
  const { urls, error } = await signedUrlsByPath(client, "fault-photos", ["a.jpg", null, "b.jpg", "a.jpg", undefined], 3600);
  assert.deepEqual(calls, [{ bucket: "fault-photos", paths: ["a.jpg", "b.jpg"], ttl: 3600 }]);
  assert.equal(urls.get("a.jpg"), "https://s.test/sign/a.jpg");
  assert.equal(urls.get("b.jpg"), "https://s.test/sign/b.jpg");
  assert.equal(error, null);
});

test("one missing object leaves the others signed, and is reported", async () => {
  const { client } = storage((paths) => ({
    data: paths.map((p) => (p === "gone.jpg"
      ? { error: "Either the object does not exist or you do not have access to it", path: p, signedURL: null, signedUrl: null }
      : ok(p))),
    error: null,
  }));
  const { urls, error } = await signedUrlsByPath(client, "fault-photos", ["a.jpg", "gone.jpg", "b.jpg"], 3600);
  assert.deepEqual([...urls.keys()].sort(), ["a.jpg", "b.jpg"]);
  assert.match(error?.message ?? "", /does not exist/);
});

test("a path the answer leaves out is reported as missing", async () => {
  const { client } = storage((paths) => ({ data: paths.slice(1).map(ok), error: null }));
  const { urls, error } = await signedUrlsByPath(client, "x", ["a.jpg", "b.jpg"], 60);
  assert.deepEqual([...urls.keys()], ["b.jpg"]);
  assert.ok(error);
});

test("a failed call signs nothing and says so", async () => {
  const { client } = storage(() => ({ data: null, error: { message: "storage down" } }));
  const { urls, error } = await signedUrlsByPath(client, "x", ["a.jpg"], 60);
  assert.equal(urls.size, 0);
  assert.equal(error?.message, "storage down");
});

test("nothing to sign makes no request", async () => {
  const { client, calls } = storage(() => ({ data: [], error: null }));
  const { urls, error } = await signedUrlsByPath(client, "x", [null, undefined, ""], 60);
  assert.equal(calls.length, 0);
  assert.equal(urls.size, 0);
  assert.equal(error, null);
});
