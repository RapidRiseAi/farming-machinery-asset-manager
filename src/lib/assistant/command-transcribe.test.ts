import assert from "node:assert/strict";
import test from "node:test";
import { hearCommand, type HearDeps } from "./command-transcribe";
import { inspect } from "@/lib/upload/sniff";
import { oggOpus, webmOpus } from "@/lib/upload/media-fixtures";
import { COMMAND_AUDIO_MAX_MS, VOICE_NOTE_MAX_BYTES } from "@/lib/limits";

type Held = { model: string; units: Record<string, number>; credential?: string };

function deps(over: Partial<HearDeps> & { answers?: Array<string | Error> } = {}) {
  const holds: Held[] = [];
  const settled: Array<{ id: string; attempts: unknown[] }> = [];
  const calls: Array<{ model: string; bytes: number; ownKey: string | null }> = [];
  const answers = [...(over.answers ?? ["Die trekker se hidroulika lek."])];
  const d: Partial<HearDeps> = {
    models: () => ["openai/gpt-4o-transcribe", "microsoft/mai-transcribe-2"],
    farmKey: async () => ({ state: "none" }) as never,
    hold: async (input) => { holds.push({ model: input.model, units: input.units as Record<string, number>, credential: input.credential }); return { ok: true, id: `hold-${holds.length}` } as never; },
    settle: async (id, attempts) => { settled.push({ id, attempts }); return null; },
    call: async ({ model, audio, ownKey }) => {
      calls.push({ model, bytes: audio.length, ownKey });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return { text: next ?? "", costUsd: 0.06, generationId: "g", tokens: null };
    },
    markKeyFailed: async () => undefined,
    deadlineMs: 240_000,
    ...over,
  };
  return { d, holds, settled, calls };
}

const input = (audio: Uint8Array, durationMs: number | null) => ({
  farmId: "a1000000-0000-4000-9000-000000000001", userId: "a1100000-0000-4000-9000-000000000001",
  audio, durationMs, terms: ["Groen John Deere"], locale: "af-ZA" as const,
});

test("scenario 22: a generated ten-minute recording goes through sniffing and the ledger to the provider whole", async () => {
  const recording = oggOpus(600);
  // What the server reads back from Storage: the length from the container itself.
  const judged = inspect(recording.subarray(0, 16_384), recording.subarray(recording.length - 16_384), recording.length, "command_audio");
  assert.equal(judged.ok, true);
  assert.equal(judged.ok && judged.durationMs, COMMAND_AUDIO_MAX_MS);
  assert.ok(recording.length < VOICE_NOTE_MAX_BYTES / 4, "ten minutes at the set bitrate is a few MB");

  const { d, holds, calls, settled } = deps();
  const heard = await hearCommand(input(recording, judged.ok ? judged.durationMs : null), d);
  assert.deepEqual(heard, { state: "heard", text: "Die trekker se hidroulika lek.", model: "openai/gpt-4o-transcribe" });
  // The hold covers all ten minutes before the provider hears any of it.
  assert.equal(holds[0].units.audio_ms, COMMAND_AUDIO_MAX_MS);
  assert.ok((holds[0].units.output_tokens ?? 0) >= 600 * 6, "the transcript allowance grows with the length");
  // One call, the whole file: nothing cut mid-sentence.
  assert.deepEqual(calls, [{ model: "openai/gpt-4o-transcribe", bytes: recording.length, ownKey: null }]);
  assert.equal(settled.length, 1);
});

test("a recording whose container states no length is held for the full ten minutes", async () => {
  const { d, holds } = deps();
  await hearCommand(input(webmOpus(30), null), d);
  assert.equal(holds[0].units.audio_ms, COMMAND_AUDIO_MAX_MS);
});

test("a budget refusal stops before any provider call, and the fallback is not tried", async () => {
  const { d, calls } = deps({ hold: async () => ({ ok: false, reason: "farm_limit" }) as never });
  assert.deepEqual(await hearCommand(input(oggOpus(5), 5000), d), { state: "refused", reason: "farm_limit" });
  assert.deepEqual(calls, []);
});

test("a failed first hearing is settled, then the fallback is tried with a hold of its own", async () => {
  const { d, holds, settled, calls } = deps({ answers: [Object.assign(new Error("boom"), { statusCode: 500 }), "Pomp lek"] });
  const heard = await hearCommand(input(oggOpus(5), 5000), d);
  assert.equal(heard.state, "heard");
  assert.deepEqual(calls.map((c) => c.model), ["openai/gpt-4o-transcribe", "microsoft/mai-transcribe-2"]);
  assert.equal(holds.length, 2);
  assert.equal(settled.length, 2, "every hold is settled exactly once");
});

test("when every hearing fails the job is told to try again, with a code, and nothing is left held", async () => {
  const { d, settled } = deps({ answers: [new Error("a"), new Error("b")] });
  const heard = await hearCommand(input(oggOpus(5), 5000), d);
  assert.equal(heard.state, "failed");
  assert.match(heard.state === "failed" ? heard.code : "", /^[a-z_]+$/);
  assert.equal(settled.length, 2);
});

test("a farm's own key is used for OpenAI and a broken key with pause chosen pauses", async () => {
  const own = deps({ farmKey: async () => ({ state: "active", key: "farm-key-" + "for-tests", fallback: "pause" }) as never });
  await hearCommand(input(oggOpus(5), 5000), own.d);
  assert.equal(own.holds[0].credential, "farm_openai");
  assert.equal(own.calls[0].ownKey, "farm-key-for-tests");
  const broken = deps({ farmKey: async () => ({ state: "broken", fallback: "pause" }) as never });
  assert.deepEqual(await hearCommand(input(oggOpus(5), 5000), broken.d), { state: "refused", reason: "own_key_broken" });
  assert.deepEqual(broken.calls, []);
});
