import assert from "node:assert/strict";
import test from "node:test";

import { contentRequestId, readRequestId } from "./request-id";

test("the same clip is the same request, any other clip or language a new one", async () => {
  const clip = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/wav" });
  const again = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: "audio/wav" });
  const other = new Blob([new Uint8Array([1, 2, 3, 4, 6])], { type: "audio/wav" });
  const id = await contentRequestId("transcribe:en-ZA", clip);
  assert.equal(await contentRequestId("transcribe:en-ZA", again), id, "a resend of the same bytes is recognised");
  assert.notEqual(await contentRequestId("transcribe:en-ZA", other), id, "one byte different is a different request");
  assert.notEqual(await contentRequestId("transcribe:af-ZA", clip), id, "the same clip heard in another language is a different request");
  // It must be an id the server accepts, or every clip would go unclaimed.
  assert.equal(readRequestId(id), id);
});
