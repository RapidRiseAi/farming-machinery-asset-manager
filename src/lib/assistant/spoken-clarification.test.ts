import assert from "node:assert/strict";
import test from "node:test";
import { clarificationFromSpeech } from "./spoken-clarification";
import type { AssistantField } from "./types";

const interactionId = "11111111-1111-4111-8111-111111111111";

test("uses a spoken machine name as a server-resolved query, never an ID", () => {
  const field: AssistantField = { name: "machineId", type: "select", label: "Which machine?", options: [] };
  assert.deepEqual(clarificationFromSpeech(interactionId, field, "die Mercedes trok"), {
    interactionId,
    machineQuery: "die Mercedes trok",
  });
});

test("keeps the spoken fault answer separate from the original generic intent", () => {
  const field: AssistantField = { name: "description", type: "text", label: "Wat is die probleem?" };
  assert.deepEqual(clarificationFromSpeech(interactionId, field, "Die venster is gebreek"), {
    interactionId,
    description: "Die venster is gebreek",
  });
});

test("understands Afrikaans urgency answers", () => {
  const field: AssistantField = { name: "urgency", type: "select", label: "Kan dit werk?", options: [] };
  assert.equal(clarificationFromSpeech(interactionId, field, "Nee, dit staan stil")?.urgency, "stopped");
  assert.equal(clarificationFromSpeech(interactionId, field, "Ja, dit kan nog werk")?.urgency, "can_work");
});

test("keeps grouped spoken readings as thousands rather than decimals", () => {
  const field: AssistantField = { name: "reading", type: "number", label: "Reading" };
  assert.equal(clarificationFromSpeech(interactionId, field, "4,323 engine hours")?.reading, 4323);
  assert.equal(clarificationFromSpeech(interactionId, field, "4 323 ure")?.reading, 4323);
  assert.equal(clarificationFromSpeech(interactionId, field, "4323.5 hours")?.reading, 4323.5);
});
