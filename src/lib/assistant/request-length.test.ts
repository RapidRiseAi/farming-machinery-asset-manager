import assert from "node:assert/strict";
import test from "node:test";
import { assistantTurnRequestSchema } from "./request-schema";
import { ASSISTANT_SPOKEN_MAX_CHARS, ASSISTANT_TYPED_MAX_CHARS } from "@/lib/limits";

const base = { locale: "en-ZA", voiceCaptureId: "a1900000-0000-4000-9000-000000000001" } as const;

test("scenario 22: a ten-minute spoken request is accepted; the same length typed is not", () => {
  // About ten minutes of speech: roughly 1,500 words.
  const tenMinutes = "The tractor's hydraulic hose is leaking near the loader again. ".repeat(140).trim();
  assert.ok(tenMinutes.length > ASSISTANT_TYPED_MAX_CHARS && tenMinutes.length <= ASSISTANT_SPOKEN_MAX_CHARS);
  assert.equal(assistantTurnRequestSchema.safeParse({ ...base, channel: "voice", input: tenMinutes }).success, true);
  assert.equal(assistantTurnRequestSchema.safeParse({ input: tenMinutes, locale: "en-ZA", channel: "typed" }).success, false);
  assert.equal(assistantTurnRequestSchema.safeParse({ input: "x".repeat(ASSISTANT_TYPED_MAX_CHARS), locale: "en-ZA", channel: "typed" }).success, true);
  assert.equal(assistantTurnRequestSchema.safeParse({ ...base, channel: "voice", input: "x".repeat(ASSISTANT_SPOKEN_MAX_CHARS + 1) }).success, false);
});
