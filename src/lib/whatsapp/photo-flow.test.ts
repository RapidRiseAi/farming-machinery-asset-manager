import assert from "node:assert/strict";
import test from "node:test";
import { faultLabel, faultListPrompt, isPhotoState, photoPrompt, photoStep, reportInput, type PhotoState } from "./photo-flow";
import { inboundContent, parseWebhook, UNSUPPORTED_MESSAGE } from "./protocol";

const base: PhotoState = { kind: "photo", mediaId: "m1", stage: "choose", caption: null };

test("choosing what a photo is for", () => {
  assert.deepEqual(photoStep(base, "1"), { do: "describe" });
  assert.deepEqual(photoStep({ ...base, caption: "JD 6120 leaking oil" }, "1"),
    { do: "report", input: reportInput("JD 6120 leaking oil") });
  assert.deepEqual(photoStep(base, "2"), { do: "list_faults" });
  assert.deepEqual(photoStep(base, " 3 "), { do: "discard" });
  // A description straight away is a new problem; a stray word or number is asked again.
  assert.deepEqual(photoStep(base, "Tractor 4 flat tyre"), { do: "report", input: reportInput("Tractor 4 flat tyre") });
  assert.deepEqual(photoStep(base, "ok"), { do: "repeat" });
  assert.deepEqual(photoStep(base, "7"), { do: "repeat" });
});

test("describing, picking a logged fault, and discarding at any stage", () => {
  const describe: PhotoState = { ...base, stage: "describe" };
  assert.deepEqual(photoStep(describe, "Bakkie brakes squeal"), { do: "report", input: reportInput("Bakkie brakes squeal") });
  assert.deepEqual(photoStep(describe, "12"), { do: "repeat" });
  const pick: PhotoState = { ...base, stage: "pick_fault", faults: [{ id: "f1", label: "JD: leak" }, { id: "f2", label: "Bakkie: brakes" }] };
  assert.deepEqual(photoStep(pick, "2"), { do: "attach", fault: { id: "f2", label: "Bakkie: brakes" } });
  // In the list, 3 is a fault number, not "discard": only the word discards there.
  assert.deepEqual(photoStep(pick, "3"), { do: "repeat" });
  assert.deepEqual(photoStep(pick, "0"), { do: "repeat" });
  for (const word of ["DISCARD", "cancel", "weggooi", "Nee"]) {
    assert.deepEqual(photoStep(pick, word), { do: "discard" }, word);
    assert.deepEqual(photoStep(describe, word), { do: "discard" }, word);
  }
});

test("only a well-formed photo state is treated as one", () => {
  assert.equal(isPhotoState(base), true);
  assert.equal(isPhotoState({ kind: "confirm" }), false);
  assert.equal(isPhotoState({ kind: "photo", mediaId: 4, stage: "choose" }), false);
  assert.equal(isPhotoState({ kind: "photo", mediaId: "m", stage: "anything" }), false);
  assert.equal(isPhotoState(null), false);
});

test("the prompts carry the caption and the list, in the person's language", () => {
  const en = photoPrompt("en", "Leaking under the cab");
  assert.match(en, /Photo received\./);
  assert.match(en, /Caption: Leaking under the cab/);
  assert.match(en, /1\. Report a new problem/);
  assert.match(photoPrompt("af", null), /Foto ontvang\./);
  assert.doesNotMatch(photoPrompt("en", null), /Caption/);
  const list = faultListPrompt("en", [{ id: "a", label: "JD 6120: Hydraulic leak" }]);
  assert.match(list, /\n1\. JD 6120: Hydraulic leak$/);
  assert.equal(faultLabel("JD 6120", "x".repeat(80), "en"), `JD 6120: ${"x".repeat(57)}...`);
  assert.equal(faultLabel(null, null, "en"), "Vehicle");
  // The text the assistant gets is bounded well inside its 2000-character input.
  assert.ok(reportInput("y".repeat(5000)).length <= 1900);
});

test("the webhook keeps text, button replies, voice notes and photos, and marks the rest unsupported", () => {
  const msg = (extra: Record<string, unknown>) => ({ id: "wamid.1", from: "27820000001", timestamp: "1", ...extra }) as never;
  assert.deepEqual(inboundContent(msg({ type: "text", text: { body: "status" } })), { text: "status", media: null });
  assert.deepEqual(inboundContent(msg({ type: "interactive", interactive: { button_reply: { id: "yes" } } })), { text: "yes", media: null });
  assert.deepEqual(inboundContent(msg({ type: "text", text: { body: "x".repeat(2001) } })), { text: UNSUPPORTED_MESSAGE, media: null });
  assert.deepEqual(inboundContent(msg({ type: "audio", audio: { id: "media-a", mime_type: "audio/ogg; codecs=opus" } })),
    { text: "", media: { kind: "audio", id: "media-a", mime: "audio/ogg; codecs=opus" } });
  assert.deepEqual(inboundContent(msg({ type: "image", image: { id: "media-i", mime_type: "image/jpeg", caption: "  leak  " } })),
    { text: "leak", media: { kind: "image", id: "media-i", mime: "image/jpeg" } });
  for (const type of ["video", "document", "sticker", "location"]) {
    assert.deepEqual(inboundContent(msg({ type })), { text: UNSUPPORTED_MESSAGE, media: null }, type);
  }
  // A signed envelope with a photo and a voice note parses; the media ids come through.
  const values = parseWebhook({
    object: "whatsapp_business_account",
    entry: [{ id: "200", changes: [{ field: "messages", value: {
      metadata: { phone_number_id: "100" },
      messages: [
        { id: "a", from: "27820000001", timestamp: "1", type: "image", image: { id: "img-1", mime_type: "image/jpeg" } },
        { id: "b", from: "27820000001", timestamp: "2", type: "audio", audio: { id: "aud-1", mime_type: "audio/ogg" } },
      ],
    } }] }],
  }, "200", "100");
  assert.equal(values?.[0].messages?.[0].image?.id, "img-1");
  assert.equal(values?.[0].messages?.[1].audio?.id, "aud-1");
});
