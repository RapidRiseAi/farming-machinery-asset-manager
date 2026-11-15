import assert from "node:assert/strict";
import test from "node:test";
import { finishRecordedCommand, runRecordedCommand, type CommandJobView } from "./command-client";
import type { Transport } from "@/lib/upload/tus";
import { webmOpus } from "@/lib/upload/media-fixtures";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://project.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key-for-tests";

const INTENT = "a1900000-0000-4000-9000-000000000009";
const job = (over: Partial<CommandJobView> = {}): CommandJobView => ({
  id: "a1800000-0000-4000-9000-000000000009", status: "queued", attempts: 0, maxAttempts: 3, transcript: null,
  error: null, recoverUntil: "2026-11-18T10:00:00Z", audioKept: true, ...over,
});

const okTransport: Transport = async () => ({ status: 200, header: () => null });

function server(runs: Array<CommandJobView | "drop">) {
  const actions: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url === "/api/uploads/begin") {
      assert.equal(body.mediaClass, "command_audio");
      assert.equal(body.target.kind, "assistant_command");
      return new Response(JSON.stringify({
        state: "upload", intentId: INTENT, bucket: "command-audio", path: "f/c/command-x.webm", token: "t",
        signedUrl: "https://project.supabase.co/storage/v1/object/upload/sign/command-audio/f/c/command-x.webm?token=t",
        resumable: false, tusEndpoint: "https://project.supabase.co/storage/v1/upload/resumable/sign", chunkBytes: 6291456,
        expiresAt: "2026-11-15T12:00:00Z",
      }));
    }
    actions.push(body.action);
    if (body.action === "start") return new Response(JSON.stringify({ job: job() }));
    if (body.action === "done") return new Response(JSON.stringify({ job: job({ status: "completed" }) }));
    const next = runs.shift();
    if (next === "drop") throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ job: next ?? job({ status: "failed", error: "provider_timeout" }) }));
  }) as unknown as typeof fetch;
  return { fetchImpl, actions };
}

const recording = new Blob([webmOpus(90) as BlobPart], { type: "audio/webm;codecs=opus" });
const run = (fetchImpl: typeof fetch) => runRecordedCommand(
  { captureId: "a1700000-0000-4000-9000-000000000009", audio: recording, mimeType: recording.type, locale: "en-ZA", farmId: "a1000000-0000-4000-9000-000000000001" },
  { fetchImpl, transport: okTransport, storage: null, sleep: async () => undefined },
);

test("scenario 22: a recorded command is uploaded as command audio, its job run until heard", async () => {
  const s = server([job({ status: "transcribed", attempts: 1, transcript: "The bakkie needs a service" })]);
  const outcome = await run(s.fetchImpl);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.job.transcript, "The bakkie needs a service");
  assert.deepEqual(s.actions, ["start", "run"]);
});

test("a run already held elsewhere is polled until it is heard", async () => {
  const s = server([job({ status: "running", attempts: 1 }), job({ status: "running", attempts: 1 }), job({ status: "transcribed", transcript: "Pomp lek" })]);
  const outcome = await run(s.fetchImpl);
  assert.equal(outcome.ok, true);
  assert.deepEqual(s.actions, ["start", "run", "status", "status"]);
});

test("scenario 28: a failed command answers its job, so the person can try again within the window", async () => {
  const s = server([job({ status: "failed", attempts: 3, error: "provider_timeout" })]);
  const outcome = await run(s.fetchImpl);
  assert.equal(outcome.ok, false);
  assert.equal(!outcome.ok && outcome.job?.audioKept, true);
  assert.equal(!outcome.ok && outcome.code, "provider_timeout");
});

test("a lost answer from a run is a failure the person sees, never a silent loss", async () => {
  const s = server(["drop"]);
  await assert.rejects(run(s.fetchImpl), /fetch failed/);
});

test("done tells the server once the words reached the assistant", async () => {
  const s = server([]);
  assert.equal(await finishRecordedCommand("a1800000-0000-4000-9000-000000000009", { fetchImpl: s.fetchImpl }), true);
  assert.deepEqual(s.actions, ["done"]);
});
