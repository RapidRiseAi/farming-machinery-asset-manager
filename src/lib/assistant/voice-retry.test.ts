import assert from "node:assert/strict";
import test from "node:test";
import { freshVoiceRetryFor } from "./voice-retry";

test("a submitted voice retry gets a fresh capture and supersedes its lineage", () => {
  const original = "11111111-1111-4111-8111-111111111111";
  const submitted = "22222222-2222-4222-8222-222222222222";
  const retry = freshVoiceRetryFor({
    input: "Corrected transcript",
    locale: "en-ZA",
    channel: "voice",
    voiceCaptureId: submitted,
    supersedesVoiceCaptureIds: [original],
  });

  assert.ok(retry);
  assert.notEqual(retry.voiceCaptureId, submitted);
  assert.deepEqual(retry.supersedesVoiceCaptureIds, [original, submitted]);
});

test("typed requests do not acquire voice correction metadata", () => {
  const retry = freshVoiceRetryFor({
    input: "Typed request",
    locale: "en-ZA",
    channel: "typed",
  });

  assert.equal(retry, null);
});
