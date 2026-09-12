import assert from "node:assert/strict";
import test from "node:test";
import { uploadJobCardMedia } from "./jobcard-media";
import { uploadWorkRequestMedia } from "./workrequest-media";

type UploadClient = Parameters<typeof uploadJobCardMedia>[0];

function mockClient(options: { uploadFails?: boolean; attachmentFails?: boolean; attachmentThrows?: boolean } = {}) {
  const uploads: string[] = [];
  const removals: string[][] = [];
  const attachments: Record<string, unknown>[] = [];
  const client = {
    storage: {
      from(bucket: string) {
        assert.equal(bucket, "jobcard-photos");
        return {
          async upload(path: string) {
            uploads.push(path);
            return { error: options.uploadFails ? new Error("upload failed") : null };
          },
          async remove(paths: string[]) {
            removals.push(paths);
            return { error: null };
          },
        };
      },
    },
    from(table: string) {
      assert.equal(table, "attachments");
      return {
        async insert(row: Record<string, unknown>) {
          attachments.push(row);
          if (options.attachmentThrows) throw new Error("connection failed");
          return { error: options.attachmentFails ? new Error("insert failed") : null };
        },
      };
    },
  } as unknown as UploadClient;
  return { client, uploads, removals, attachments };
}

for (const [parentType, upload] of [
  ["job_card", uploadJobCardMedia],
  ["work_request", uploadWorkRequestMedia],
] as const) {
  const file = () => new File(["test photo"], "test.jpg", { type: "image/jpeg" });

  test(`${parentType}: success requires uploaded object and attachment row`, async () => {
    const m = mockClient();
    assert.equal(await upload(m.client, file(), "photo", "farm", "parent", "user"), true);
    assert.equal(m.uploads.length, 1);
    assert.equal(m.attachments.length, 1);
    assert.deepEqual(m.attachments[0], {
      farm_id: "farm", parent_type: parentType, parent_id: "parent", kind: "photo",
      storage_path: m.uploads[0], created_by: "user",
    });
    assert.deepEqual(m.removals, []);
  });

  for (const failure of ["attachmentFails", "attachmentThrows"] as const) {
    test(`${parentType}: ${failure} removes only the newly uploaded object`, async () => {
      const m = mockClient({ [failure]: true });
      assert.equal(await upload(m.client, file(), "quote", "farm", "parent", "user"), false);
      assert.equal(m.uploads.length, 1);
      assert.match(m.uploads[0], /^farm\/parent\/doc-[0-9a-f-]+\.jpg$/);
      assert.deepEqual(m.removals, [[m.uploads[0]]]);
    });
  }

  test(`${parentType}: failed upload neither writes an attachment nor deletes objects`, async () => {
    const m = mockClient({ uploadFails: true });
    assert.equal(await upload(m.client, file(), "photo", "farm", "parent", "user"), false);
    assert.deepEqual(m.attachments, []);
    assert.deepEqual(m.removals, []);
  });

  test(`${parentType}: missing and oversized files cause no writes`, async () => {
    const m = mockClient();
    assert.equal(await upload(m.client, null, "photo", "farm", "parent", "user"), false);
    const oversized = new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.jpg");
    assert.equal(await upload(m.client, oversized, "photo", "farm", "parent", "user"), false);
    assert.deepEqual(m.uploads, []);
    assert.deepEqual(m.attachments, []);
    assert.deepEqual(m.removals, []);
  });
}
