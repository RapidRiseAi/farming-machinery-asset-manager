import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sweepUploads } from "./sweep";

function svc(objects: Array<{ id: string; bucket: string; path: string }>, failBucket?: string) {
  const removed: string[] = [];
  const marked: string[][] = [];
  const client = {
    async rpc(fn: string, args: { p_ids?: string[] }) {
      if (fn === "cron_upload_expire_sweep") return { data: { expired: 2, objects }, error: null };
      if (fn === "cron_upload_mark_removed") { marked.push(args.p_ids ?? []); return { data: args.p_ids?.length ?? 0, error: null }; }
      throw new Error(fn);
    },
    storage: {
      from(bucket: string) {
        return {
          async remove(paths: string[]) {
            if (bucket === failBucket) return { data: null, error: { message: "down" } };
            removed.push(...paths.map((p) => `${bucket}:${p}`));
            return { data: [], error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { client, removed, marked };
}

test("the sweep removes lapsed and refused objects and marks each removed once", async () => {
  const s = svc([
    { id: "1", bucket: "fault-photos", path: "f/a/photo-1.jpg" },
    { id: "2", bucket: "fault-photos", path: "f/a/photo-2.jpg" },
    { id: "3", bucket: "command-audio", path: "f/u/command-3.webm" },
  ]);
  assert.equal(await sweepUploads(s.client), "ok (expired 2, removed 3)");
  assert.deepEqual(s.removed.sort(), ["command-audio:f/u/command-3.webm", "fault-photos:f/a/photo-1.jpg", "fault-photos:f/a/photo-2.jpg"]);
  assert.deepEqual(s.marked, [["1", "2", "3"]]);
});

test("a bucket that will not remove keeps its objects named for the next night, and the step reports it", async () => {
  const s = svc([
    { id: "1", bucket: "fault-photos", path: "a" },
    { id: "2", bucket: "jobcard-photos", path: "b" },
  ], "jobcard-photos");
  await assert.rejects(sweepUploads(s.client), /1 object\(s\) could not be removed, 1 removed/);
  assert.deepEqual(s.marked, [["1"]]);
});
