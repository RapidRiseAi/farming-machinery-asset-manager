/**
 * The small rules the AI usage ledger leans on: how long a recording is (billed per
 * second), how a failure is named (alerts and the circuit breaker read it), how a farm's
 * own key is sealed, and what every Gateway call is tagged with (the monthly
 * reconciliation groups by it).
 */

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { gatewayCallCost } from "./gateway-cost";
import { gatewayOptions } from "./gateway-options";
import { answerHoldUnits, hearingHoldUnits } from "./hold-units";
import { KeySecretMismatch, keyHint, keySecretConfigured, looksLikeOpenAiKey, openFarmKey, sealFarmKey } from "./key-crypto";
import { openAiModelId, transcriptionResponseBody, transcriptionTokenUnits } from "./openai-direct";
import { classifyAiFailure } from "./outcome";
import { AI_RESULTS, aiResult } from "./results";
import { strictPcmDurationMs, wavDurationMs } from "./wav";

/** A PCM WAV of `ms` milliseconds at 16 kHz mono 16-bit, optionally with a LIST chunk first. */
function wav(ms: number, { listChunk = false, dataSize }: { listChunk?: boolean; dataSize?: number } = {}) {
  const byteRate = 16000 * 2;
  const audio = Math.round((byteRate * ms) / 1000);
  const extra = listChunk ? 8 + 6 : 0;
  const bytes = new Uint8Array(44 + extra + audio);
  const view = new DataView(bytes.buffer);
  const put = (offset: number, text: string) => [...text].forEach((c, i) => (bytes[offset + i] = c.charCodeAt(0)));
  put(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  let at = 36;
  if (listChunk) {
    put(at, "LIST");
    view.setUint32(at + 4, 6, true);
    at += 14;
  }
  put(at, "data");
  view.setUint32(at + 4, dataSize ?? audio, true);
  return bytes;
}

test("a recording is billed for its real length, read from its own header", () => {
  assert.equal(wavDurationMs(wav(4000)), 4000);
  assert.equal(wavDurationMs(wav(2500, { listChunk: true })), 2500, "extra chunks before the audio");
  assert.equal(wavDurationMs(wav(1000, { dataSize: 0xffffffff })), 1000, "a streamed header runs to the end");
});

test("anything that is not a WAV has no duration to bill", () => {
  assert.equal(wavDurationMs(new Uint8Array(0)), null);
  assert.equal(wavDurationMs(new TextEncoder().encode("RIFF....AVI LIST")), null);
  const noFormat = wav(1000);
  noFormat.set([0, 0, 0, 0], 28);
  assert.equal(wavDurationMs(noFormat), null, "a zero byte rate cannot be divided by");
});

test("failures are named from the gateway error, through the SDK's wrappers", () => {
  const gateway = (type: string, statusCode: number) => ({ name: "GatewayError", type, statusCode });
  assert.equal(classifyAiFailure(gateway("rate_limit_exceeded", 429)).outcome, "rate_limited");
  assert.equal(classifyAiFailure({ name: "AI_RetryError", lastError: gateway("internal_server_error", 502) }).code, "provider_502");
  assert.equal(classifyAiFailure({ name: "Error", cause: { name: "AbortError" } }).outcome, "timeout");
  assert.equal(classifyAiFailure(gateway("model_not_found", 404)).outcome, "failed");
  assert.equal(classifyAiFailure(new Error("socket hang up")).code, "unknown");
});

test("out of credit is the founder's problem on our key and the farm's on theirs", () => {
  const noMoney = { name: "GatewayError", type: "invalid_request_error", statusCode: 402 };
  assert.equal(classifyAiFailure(noMoney).outcome, "no_credit");
  assert.equal(classifyAiFailure(noMoney, true).outcome, "key_invalid");
});

test("a refused credential alerts the founder only when it is the platform's", () => {
  const refused = { name: "GatewayAuthenticationError", type: "authentication_error", statusCode: 401 };
  assert.deepEqual(classifyAiFailure(refused), { outcome: "failed", code: "gateway_auth", platformAuth: true });
  assert.deepEqual(classifyAiFailure(refused, true), { outcome: "key_invalid", code: "farm_key_refused", platformAuth: false });
});

const SECRET = randomBytes(32).toString("base64");
const FARM = "00000000-0000-4000-8000-000000000001";
const KEY = "sk-proj-" + "a".repeat(40) + "WXYZ";

test("a sealed key opens only with the same secret on the same farm", () => {
  const sealed = sealFarmKey(KEY, FARM, SECRET);
  assert.ok(sealed.startsWith("v2.") && !sealed.includes(KEY));
  assert.equal(openFarmKey(sealed, FARM, SECRET), KEY);
  assert.throws(() => openFarmKey(sealed, "00000000-0000-4000-8000-000000000002", SECRET), "copied onto another farm");
  assert.notEqual(sealFarmKey(KEY, FARM, SECRET), sealed, "a fresh IV every time");
});

test("another deployment's secret is told apart from a damaged value", () => {
  const sealed = sealFarmKey(KEY, FARM, SECRET);
  // A Preview or local copy with its own valid secret, on the same database: not the
  // farm's fault, so it must not read as a broken key.
  assert.throws(() => openFarmKey(sealed, FARM, randomBytes(32).toString("base64")), (e: unknown) => e instanceof KeySecretMismatch);
  const [v, id, iv, tag, data] = sealed.split(".");
  const flipped = data.slice(0, -2) + (data.at(-2) === "A" ? "B" : "A") + data.at(-1);
  // Sealed under this very secret and changed: damaged, which IS the farm's to re-link.
  assert.throws(() => openFarmKey([v, id, iv, tag, flipped].join("."), FARM, SECRET), (e: unknown) => !(e instanceof KeySecretMismatch));
});

test("any change to a sealed key is detected, and a bad secret is refused", () => {
  const [v, id, iv, tag, data] = sealFarmKey(KEY, FARM, SECRET).split(".");
  const flipped = data.slice(0, -2) + (data.at(-2) === "A" ? "B" : "A") + data.at(-1);
  assert.throws(() => openFarmKey([v, id, iv, tag, flipped].join("."), FARM, SECRET));
  assert.throws(() => openFarmKey(["v1", iv, tag, data].join("."), FARM, SECRET), /Unrecognised/);
  assert.throws(() => sealFarmKey(KEY, FARM, "c2hvcnQ="), /32 bytes/);
});

test("a key is shown only by its last four characters, and its shape is checked first", () => {
  assert.equal(keyHint(`  ${KEY}  `), "WXYZ");
  assert.equal(looksLikeOpenAiKey(KEY), true);
  assert.equal(looksLikeOpenAiKey("sk-short"), false);
  assert.equal(looksLikeOpenAiKey("pk-" + "a".repeat(40)), false);
});

test("every gateway call is tagged for reconciliation, and never carries a farm's key", () => {
  const plain = gatewayOptions({ farmId: FARM, userId: "u1", feature: "ai_hearing" });
  assert.deepEqual(plain, { user: "u1", tags: [`farm:${FARM}`, "feature:ai_hearing"] });
  const zdr = gatewayOptions({ farmId: FARM, userId: null, feature: "ai_answer", zeroDataRetention: true });
  assert.equal(zdr.zeroDataRetention, true);
  // Request-scoped BYOK falls back to the platform's credentials when the key fails; a
  // farm's key goes to OpenAI directly instead (openai-direct.ts).
  assert.equal("byok" in zdr, false);
  assert.equal(gatewayOptions({ farmId: FARM, userId: null, feature: "canary" }).user, "platform:canary");
});

test("an OpenAI account out of quota is the farm's to fix, though OpenAI answers it with 429", () => {
  const quota = { name: "AI_APICallError", statusCode: 429, data: { error: { type: "insufficient_quota", code: "insufficient_quota", message: "x" } } };
  assert.deepEqual(classifyAiFailure(quota, true), { outcome: "key_invalid", code: "farm_key_quota", platformAuth: false });
  assert.equal(classifyAiFailure(quota).outcome, "no_credit");
  const burst = { name: "AI_APICallError", statusCode: 429, data: { error: { type: "requests", code: "rate_limit_exceeded", message: "x" } } };
  assert.equal(classifyAiFailure(burst, true).outcome, "rate_limited");
  const badKey = { name: "AI_APICallError", statusCode: 401, data: { error: { type: "invalid_request_error", code: "invalid_api_key", message: "x" } } };
  assert.deepEqual(classifyAiFailure(badKey, true), { outcome: "key_invalid", code: "farm_key_refused", platformAuth: false });
  const billing = { name: "AI_APICallError", statusCode: 400, data: { error: { type: "invalid_request_error", code: "billing_hard_limit_reached", message: "x" } } };
  assert.equal(classifyAiFailure(billing, true).code, "farm_key_quota");
});

test("a hold is an upper bound: a hearing holds its audio, its prompt and a transcript allowance", () => {
  assert.deepEqual(hearingHoldUnits("microsoft/mai-transcribe-2", 4000, 700), { audio_ms: 4000 });
  const gpt = hearingHoldUnits("openai/gpt-4o-transcribe", 4000, 780);
  assert.equal(gpt.audio_ms, 4000);
  assert.equal(gpt.input_tokens, 280);
  assert.equal(gpt.output_tokens, 74);
  assert.deepEqual(answerHoldUnits(3000, 900), { input_tokens: 1000, output_tokens: 900 });
});

test("an own-key hearing is billed on the tokens OpenAI reports, never the audio twice", () => {
  const body = { text: "x", usage: { type: "tokens", input_tokens: 290, input_token_details: { audio_tokens: 70, text_tokens: 220 }, output_tokens: 18, total_tokens: 308 } };
  assert.deepEqual(transcriptionTokenUnits(body), { audio_input_tokens: 70, input_tokens: 220, output_tokens: 18 });
  assert.equal(transcriptionTokenUnits({ text: "x", usage: { type: "duration", seconds: 4 } }), null);
  assert.equal(transcriptionTokenUnits({ text: "x" }), null);
  assert.equal(transcriptionResponseBody({ responses: [{ body }] }), body);
});

test("only an OpenAI model can run on a farm's OpenAI key", () => {
  assert.equal(openAiModelId("openai/gpt-4o-transcribe"), "gpt-4o-transcribe");
  assert.equal(openAiModelId("openai/gpt-5-mini"), "gpt-5-mini");
  assert.equal(openAiModelId("microsoft/mai-transcribe-2"), null);
  assert.equal(openAiModelId("openai/"), null);
});

test("a missing sealing secret is the platform's misconfiguration, not a broken farm key", () => {
  assert.equal(keySecretConfigured(SECRET), true);
  assert.equal(keySecretConfigured(undefined), false);
  assert.equal(keySecretConfigured("c2hvcnQ="), false);
});

test("only the recorder's exact format is billed: PCM, 16 kHz, mono, 16-bit, with its data present", () => {
  assert.equal(strictPcmDurationMs(wav(4000)), 4000);
  assert.equal(strictPcmDurationMs(wav(2500, { listChunk: true })), 2500);
  const forged = wav(4000);
  new DataView(forged.buffer).setUint32(28, 4_000_000_000, true);
  assert.equal(strictPcmDurationMs(forged), null, "a forged byte rate would make two megabytes look like nothing");
  const mulaw = wav(1000);
  new DataView(mulaw.buffer).setUint16(20, 7, true);
  assert.equal(strictPcmDurationMs(mulaw), null, "mu-law is minutes of audio in a small file");
  const stereo = wav(1000);
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal(strictPcmDurationMs(stereo), null);
  assert.equal(strictPcmDurationMs(wav(1000, { dataSize: 0xffffffff })), null, "a header that claims more audio than is there");
  assert.equal(strictPcmDurationMs(wav(1000).subarray(0, 600)), null, "truncated audio");
});

test("the gateway's reported cost is read as a number or a numeric string, and is optional", () => {
  assert.deepEqual(gatewayCallCost({ gateway: { cost: 0.0004, generationId: "gen_1" } }), { costUsd: 0.0004, generationId: "gen_1" });
  assert.deepEqual(gatewayCallCost({ gateway: { cost: "0.000012" } }), { costUsd: 0.000012, generationId: null });
  assert.deepEqual(gatewayCallCost({ gateway: { cost: "n/a" } }), { costUsd: null, generationId: null });
  assert.deepEqual(gatewayCallCost(undefined), { costUsd: null, generationId: null });
});

test("every result the owner's AI page can show is a sentence in both languages", () => {
  const read = (lang: string) => JSON.parse(readFileSync(join(process.cwd(), `src/lib/i18n/${lang}.json`), "utf8"));
  const en = read("en");
  const af = read("af");
  for (const code of Object.keys(AI_RESULTS)) {
    assert.ok(typeof en.aiUsage?.result?.[code] === "string", `en aiUsage.result.${code}`);
    assert.ok(typeof af.aiUsage?.result?.[code] === "string", `af aiUsage.result.${code}`);
    assert.notEqual(af.aiUsage.result[code], en.aiUsage.result[code], `af aiUsage.result.${code} is the English copied`);
  }
  assert.equal(aiResult("key-linked")?.tone, "success");
  assert.equal(aiResult("not-a-code"), null, "an unknown code shows nothing rather than itself");
});
