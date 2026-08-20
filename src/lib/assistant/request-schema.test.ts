import assert from "node:assert/strict";
import test from "node:test";
import { assistantTurnRequestSchema } from "./request-schema";

const baseRequest = {
  input: "When is the John Deere due for service?",
  locale: "en-ZA" as const,
  channel: "typed" as const,
  clarification: {
    interactionId: "11111111-1111-4111-8111-111111111111",
  },
};

test("accepts deterministic PostgreSQL machine UUIDs during clarification", () => {
  const parsed = assistantTurnRequestSchema.safeParse({
    ...baseRequest,
    clarification: {
      ...baseRequest.clarification,
      machineId: "20000000-0000-0000-0000-000000000001",
    },
  });

  assert.equal(parsed.success, true);
});

test("rejects malformed machine identifiers during clarification", () => {
  const parsed = assistantTurnRequestSchema.safeParse({
    ...baseRequest,
    clarification: {
      ...baseRequest.clarification,
      machineId: "not-a-machine-id",
    },
  });

  assert.equal(parsed.success, false);
});

test("accepts a corrected voice turn only with a fresh capture ID", () => {
  const parsed = assistantTurnRequestSchema.safeParse({
    input: "Report a corrected hydraulic leak description.",
    locale: "en-ZA",
    channel: "voice",
    voiceCaptureId: "22222222-2222-4222-8222-222222222222",
    supersedesVoiceCaptureIds: ["11111111-1111-4111-8111-111111111111"],
  });

  assert.equal(parsed.success, true);
});

test("rejects correction attempts that reuse the submitted capture ID", () => {
  const captureId = "11111111-1111-4111-8111-111111111111";
  const parsed = assistantTurnRequestSchema.safeParse({
    input: "Report a corrected hydraulic leak description.",
    locale: "en-ZA",
    channel: "voice",
    voiceCaptureId: captureId,
    supersedesVoiceCaptureIds: [captureId],
  });

  assert.equal(parsed.success, false);
});

test("rejects capture supersession on typed or clarification turns", () => {
  const correction = {
    input: "Report a corrected hydraulic leak description.",
    locale: "en-ZA" as const,
    voiceCaptureId: "22222222-2222-4222-8222-222222222222",
    supersedesVoiceCaptureIds: ["11111111-1111-4111-8111-111111111111"],
  };

  assert.equal(
    assistantTurnRequestSchema.safeParse({ ...correction, channel: "typed" }).success,
    false,
  );
  assert.equal(
    assistantTurnRequestSchema.safeParse({
      ...correction,
      channel: "voice",
      clarification: { interactionId: "33333333-3333-4333-8333-333333333333" },
    }).success,
    false,
  );
});
