import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFLINE_VOICE_RETENTION_MS,
  partitionOfflineCaptures,
  type OfflineVoiceCapture,
} from "../../components/assistant/offline-voice";

function capture(id: string, contextKey: string, createdAt: number): OfflineVoiceCapture {
  return {
    id,
    contextKey,
    locale: "en-ZA",
    audio: new Blob(),
    mimeType: "audio/webm",
    durationMs: 1_000,
    createdAt,
  };
}

test("partitions expired captures across every context and exposes only the active context", () => {
  const now = 2_000_000_000_000;
  const result = partitionOfflineCaptures(
    [
      capture("expired-current", "farm-a", now - OFFLINE_VOICE_RETENTION_MS - 1),
      capture("expired-other", "farm-b", now - OFFLINE_VOICE_RETENTION_MS - 1),
      capture("current-newer", "farm-a", now - 1_000),
      capture("other-current", "farm-b", now - 500),
      capture("current-older", "farm-a", now - 2_000),
    ],
    "farm-a",
    now,
  );

  assert.deepEqual(result.expiredIds, ["expired-current", "expired-other"]);
  assert.deepEqual(result.visible.map(({ id }) => id), ["current-older", "current-newer"]);
});

test("keeps a capture exactly on the seven-day retention boundary", () => {
  const now = 2_000_000_000_000;
  const result = partitionOfflineCaptures(
    [capture("boundary", "farm-a", now - OFFLINE_VOICE_RETENTION_MS)],
    "farm-a",
    now,
  );

  assert.deepEqual(result.expiredIds, []);
  assert.deepEqual(result.visible.map(({ id }) => id), ["boundary"]);
});
