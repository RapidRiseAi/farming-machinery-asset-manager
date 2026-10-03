#!/usr/bin/env node
/**
 * Hands-free voice mode, driven end to end in a real browser, with no speech secrets.
 *
 * == Why it exists ==========================================================
 * Hands-free is a loop of listen, answer aloud, listen again, and every step of it
 * continues after an await that started renders earlier. That is exactly the code a
 * unit test cannot reach and a person testing on a phone cannot see inside: the first
 * run of this check found Stop, pressed in the ~100 ms while the last words were being
 * finished, leaving the whole screen disabled on "Thinking".
 *
 * == What is real and what is stood in ======================================
 * Real: the production bundle, the Azure Speech SDK itself, the microphone path
 * (Chrome's fake device), Web Audio playback, and clicks as genuine user gestures.
 * Stood in, by `voice_check_fake_azure.js`, injected before the page runs:
 *   · Azure's two websockets (recognition and synthesis), speaking the SDK's own wire
 *     protocol from a script: what each listening turn "hears", how long each reply is;
 *   · `/api/assistant/turn`, `/confirm` and `/speech-token`, so nothing reaches the LLM
 *     or the database, and a run against production writes nothing;
 *   · the screen wake lock, which headless Chrome has no screen for.
 *
 * == What it asserts ========================================================
 * The turn goes when the person pauses, not before; the reply plays through the audio
 * channel the tap unlocked; the mic reopens only after the reply ends; silence pauses
 * rather than holding the mic open; a change is read back and then WAITS for a tap,
 * never saving by voice; a tap during the read-back saves at once; Interrupt, a spoken
 * clarification and one re-ask after a non-answer; Stop at every stage hands the screen
 * back with nothing lost; the wake lock is taken and given back once per session.
 *
 * == What it cannot tell you ================================================
 * How well Azure hears mixed Afrikaans and English (that needs real recordings), and how
 * iOS Safari behaves: Chrome lets audio play anywhere once the page has been tapped, so
 * the unlock is exercised here, but only a real iPhone proves it necessary.
 *
 *   node scripts/voice_check.mjs                       # against http://localhost:3111
 *   node scripts/voice_check.mjs --base=http://localhost:3000
 *   node scripts/voice_check.mjs --shots=<dir>         # keep screenshots and the event log
 *   node scripts/voice_check.mjs --require             # fail, rather than skip, with no Chrome
 *
 * Needs the app running and a `.env.local` with the Supabase URL and anon key. Signs in
 * as the throwaway click-through owner, as `ui_check.mjs` does, whose screens are in
 * English. Node 22 or later, for the global WebSocket.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import os from "node:os";

const ROOT = process.cwd();
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const BASE = arg("base") ?? "http://localhost:3111";
const SHOTS = arg("shots");
const REQUIRE = process.argv.includes("--require");
const PORT = Number(arg("port") ?? 9466);
const CHROMES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const CHROME = CHROMES.find((p) => p && existsSync(p));
if (!CHROME) {
  const note = "voice_check: no Chrome found, skipping.";
  if (REQUIRE) {
    console.error(note.replace("skipping", "REQUIRED but cannot run"));
    process.exit(1);
  }
  console.log(note);
  process.exit(0);
}
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
// Load .env.local exactly as Next does (quoting, inline comments).
const require = createRequire(join(ROOT, "package.json"));
createRequire(require.resolve("next/package.json"))("@next/env").loadEnvConfig(ROOT);

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
};

// == Session for the repo's throwaway click-through owner (as ui_check.mjs does) ==
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "clickthrough@fleetwise.test", password: "Clickthrough!2026" }),
});
if (!auth.ok) throw new Error(`sign-in failed: ${auth.status}`);
const session = await auth.json();
const ref = new URL(SUPABASE_URL).hostname.split(".")[0];
const encoded = "base64-" + Buffer.from(JSON.stringify({
  access_token: session.access_token, token_type: "bearer", expires_in: session.expires_in,
  expires_at: session.expires_at, refresh_token: session.refresh_token, user: session.user,
}), "utf8").toString("base64");
const cookies = [];
for (let i = 0, n = 0; i < encoded.length; i += 3180, n += 1) cookies.push([`sb-${ref}-auth-token.${n}`, encoded.slice(i, i + 3180)]);
if (cookies.length === 1) cookies[0][0] = `sb-${ref}-auth-token`;

// == Chrome ==
const profile = mkdtempSync(join(os.tmpdir(), "fw-voice-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-gpu",
  "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
  "--autoplay-policy=user-gesture-required", "--window-size=390,844", "about:blank",
], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true }); } catch {} };
process.on("exit", cleanup);

let target;
for (let i = 0; i < 80 && !target; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch {}
  if (!target) await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error("Chrome never opened a debugging port");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const consoleLines = [];
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params.type)) {
    consoleLines.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300)}`);
  }
  if (msg.method === "Runtime.exceptionThrown") consoleLines.push(`exception: ${msg.params.exceptionDetails.exception?.description?.slice(0, 300) ?? msg.params.exceptionDetails.text}`);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (msg) => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, expression, timeout = 15_000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(expression)) return Date.now() - started;
    await sleep(100);
  }
  throw new Error(`timed out waiting for: ${label}`);
};
const text = () => evaluate("document.body?.innerText ?? \"\"");
const has = (s) => `(document.body?.innerText ?? "").includes(${JSON.stringify(s)})`;
const buttonExpr = (label) => `[...document.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)} && !b.disabled)`;
async function click(label) {
  // A disabled button means work is still settling: wait for it, never click through.
  await waitFor(`enabled "${label}"`, `Boolean(${buttonExpr(label)})`, 10_000).catch(async (e) => {
    console.log("page text:", (await text()).slice(0, 600));
    throw e;
  });
  const point = await evaluate(`(() => { const b = ${buttonExpr(label)}; if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  if (!point) throw new Error(`no enabled button "${label}"`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
}
let shot = 0;
async function screenshot(name) {
  if (!SHOTS) return;
  const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(SHOTS, `${String(++shot).padStart(2, "0")}-${name}.png`), Buffer.from(data, "base64"));
}
const voiceLog = () => evaluate("window.__voiceLog");
const events = async (ev) => (await voiceLog()).filter((e) => e.ev === ev);

// == Page ==
await send("Network.enable");
// The cookie follows the host, or a run against the live site measures the login page.
for (const [name, value] of cookies) await send("Network.setCookie", { name, value, domain: new URL(BASE).hostname, path: "/" });
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Page.addScriptToEvaluateOnNewDocument", { source: readFileSync(join(ROOT, "scripts/voice_check_fake_azure.js"), "utf8") });
await send("Page.navigate", { url: `${BASE}/assistant` });
await waitFor("assistant page", has("Talk hands-free"), 45_000).catch(async (e) => {
  console.log((await text()).slice(0, 800));
  throw e;
});
check("assistant page renders the hands-free entry", true);
await screenshot("composer-idle");

const ANSWER = "The Test Bakkie has one open job card: new brake pads, waiting for parts.";
const PROPOSAL = (id) => ({
  proposalId: id, title: "Log a meter reading", intent: "log_reading", machineName: "Test Tractor",
  facts: [{ label: "Machine", value: "Test Tractor" }, { label: "Reading", value: "1900 hours" }],
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});
await evaluate(`Object.assign(window.__voiceScript, ${JSON.stringify({
  stt: [
    { text: "What's the status of the test bakkie se repairs?" }, // 0
    null,                                                           // 1: nobody speaks
    { text: "Log nineteen hundred hours on the test tractor." },    // 2
    null,                                                           // 3: listening, then Stop
    { text: "Log hours on the test tractor." },                     // 4
    { text: "I'm not sure." },                                      // 5: not an answer
    { text: "1900." },                                              // 6: the answer
    null,                                                           // 7: listening after the save, then Stop
    { text: "Is the test tractor due for a service?", endDelayMs: 2500 }, // 8: Stop while finishing
    { text: "What's the status of the desk bucket repairs?" },     // 9: the live recogniser garbles the name
    { text: "Wat se status van die test bakkie repairs?", locale: "af-ZA" }, // 10: the fixed Afrikaans re-hearing
    null,                                                           // 11: listening after the answer, then Stop
  ],
  ttsMs: [900, 1500, 700, 6000, 900, 7000, 700, 900],
  turns: [
    { kind: "answer", conversationId: "a0000000-0000-4000-8000-000000000001", message: ANSWER, speakText: ANSWER },
    { kind: "confirm", conversationId: "a0000000-0000-4000-8000-000000000002", proposal: PROPOSAL("b0000000-0000-4000-8000-000000000002") },
    { kind: "clarify", conversationId: "a0000000-0000-4000-8000-000000000003", question: "What is the hour meter reading on the Test Tractor?",
      fields: [{ name: "reading", type: "number", label: "Hour meter reading", min: 0, step: 0.1 }] },
    { kind: "confirm", conversationId: "a0000000-0000-4000-8000-000000000003", proposal: PROPOSAL("b0000000-0000-4000-8000-000000000003") },
    { kind: "answer", conversationId: "a0000000-0000-4000-8000-000000000005", message: ANSWER, speakText: ANSWER },
  ],
  confirm: [
    { ok: true, message: "Nothing was saved.", linkedRecordType: "none", linkedRecordId: "", href: "/assistant" },
    { ok: true, message: "Saved 1900 hours for the Test Tractor.", linkedRecordType: "meter_reading", linkedRecordId: "c0000000-0000-4000-8000-000000000001", href: "/assistant" },
  ],
})})`);

// == 1. A question: heard, answered aloud, then listening again; silence pauses ==
await click("Talk hands-free");
await waitFor("listening", has("Listening… just talk"), 15_000);
check("tap starts listening hands-free", true);
check("the screen is kept awake while hands-free runs", (await events("wakelock-request")).length === 1);
await waitFor("partial transcript shows", has("what's the status"), 8_000);
await screenshot("listening-partial");
await waitFor("first turn sent", "window.__voiceLog.some((e) => e.ev === 'turn')", 10_000);
let log = await voiceLog();
const final0 = log.find((e) => e.ev === "stt-final" && e.index === 0);
const turn0 = log.find((e) => e.ev === "turn");
check("the turn waits for the pause after the last words", turn0.t - final0.t >= 1200 && turn0.t - final0.t < 2600, `${turn0.t - final0.t} ms after the final phrase`);
check("what was heard goes as a voice request", turn0.body.channel === "voice" && turn0.body.input === "What's the status of the test bakkie se repairs?" && turn0.body.locale === "en-ZA" && /^[0-9a-f-]{36}$/.test(turn0.body.voiceCaptureId ?? ""), JSON.stringify(turn0.body));
await waitFor("answer is spoken", "window.__voiceLog.some((e) => e.ev === 'audio-start' && e.ms > 500)", 10_000);
await screenshot("speaking-answer");
log = await voiceLog();
const unlock = log.find((e) => e.ev === "audio-start");
const reply = log.find((e) => e.ev === "audio-start" && e.ms > 500);
check("the tap unlocked one silent frame first", unlock && unlock.ms === 0, JSON.stringify(unlock));
check("the reply played through the unlocked context, long after the tap", reply.ctx === "running", JSON.stringify(reply));
check("the reply spoke the answer text", log.some((e) => e.ev === "tts-ssml" && e.text.includes("one open job card")));
check("the panel says it is answering", (await text()).includes("Answering…"));
await waitFor("listening again after the answer", "window.__voiceLog.filter((e) => e.ev === 'stt-listening').length >= 2", 10_000);
log = await voiceLog();
const ended = log.find((e) => e.ev === "audio-ended" && e.ms > 500);
const relisten = log.filter((e) => e.ev === "mic-open")[1];
check("the mic reopened only after the reply finished", ended && relisten && relisten.t >= ended.t, `ended ${ended?.t}, mic ${relisten?.t}`);
check("the answered exchange moved up into the thread", await evaluate(`(() => { const t = document.querySelector('section[aria-labelledby="assistant-thread-title"]'); return Boolean(t && t.innerText.includes("one open job card")); })()`));
await waitFor("silence pauses hands-free", has("Hands-free paused: nothing was heard."), 14_000);
log = await voiceLog();
const listen1 = log.find((e) => e.ev === "stt-listening" && e.index === 1);
const end1 = log.find((e) => e.ev === "stt-end-of-stream" && e.index === 1);
check("nothing said for ~8 s pauses rather than holding the mic open", end1 && end1.t - listen1.t > 7000 && end1.t - listen1.t < 10500, `${end1 ? end1.t - listen1.t : "?"} ms`);
check("the wake lock is let go when hands-free pauses", (await events("wakelock-release")).length === 1);
check("the panel is gone and the typing row is back", !(await text()).includes("Stop hands-free") && (await text()).includes("Talk hands-free"));
await screenshot("paused-no-speech");

// == 2. A change: read back, wait for the tap, never save by voice ==
await click("Talk hands-free");
await waitFor("proposal read back", "window.__voiceLog.some((e) => e.ev === 'tts-ssml' && e.index === 1)", 20_000);
log = await voiceLog();
const readback = log.find((e) => e.ev === "tts-ssml" && e.index === 1);
check("the change is read back with every fact and the tap prompt", /Log a meter reading\. Machine: Test Tractor\. Reading: 1900 hours\. Tap Confirm and save to save it, or Do not save\./.test(readback.text), readback.text);
await waitFor("read-back finished", "window.__voiceLog.filter((e) => e.ev === 'audio-ended' && e.ms > 1000).length >= 1", 10_000);
await sleep(3000);
log = await voiceLog();
const micsAfterReadback = log.filter((e) => e.ev === "mic-open").length;
check("after the read-back it waits for a tap and does NOT listen", micsAfterReadback === 3 && !log.some((e) => e.ev === "stt-listening" && e.index === 3), `mic opens so far: ${micsAfterReadback}`);
check("the panel tells you to tap", (await text()).includes("Check the details above, then tap Confirm and save or Do not save."));
check("nothing was confirmed without a tap", !log.some((e) => e.ev === "confirm"));
await screenshot("waiting-for-tap");
await click("Do not save");
await waitFor("result spoken", "window.__voiceLog.some((e) => e.ev === 'tts-ssml' && e.index === 2)", 10_000);
log = await voiceLog();
check("the tap rejected exactly that proposal", JSON.stringify(log.find((e) => e.ev === "confirm").body) === JSON.stringify({ proposalId: "b0000000-0000-4000-8000-000000000002", action: "reject" }));
check("the result is said aloud", log.find((e) => e.ev === "tts-ssml" && e.index === 2).text.includes("Nothing was saved."));
await waitFor("listening after the result", "window.__voiceLog.some((e) => e.ev === 'stt-listening' && e.index === 3)", 10_000);
await waitFor("listening label", has("Listening… just talk"), 5_000);
await click("Stop hands-free");
await waitFor("stopped", `!${has("Stop hands-free")} && ${has("Talk hands-free")}`, 8_000);
log = await voiceLog();
check("Stop closes the mic", log.some((e) => e.ev === "stt-end-of-stream" && e.index === 3));
check("Stop leaves no stray notice", !(await text()).includes("Hands-free paused"));

// == 3. A follow-up question answered by voice, with a talk-over and a retry ==
await click("Talk hands-free");
await waitFor("clarifying question spoken", "window.__voiceLog.some((e) => e.ev === 'audio-start' && e.ms >= 5000)", 20_000);
check("the clarifying question is spoken", (await voiceLog()).some((e) => e.ev === "tts-ssml" && e.index === 3 && e.text.includes("hour meter reading")));
check("the question card stays on screen while it is asked", (await text()).includes("What is the hour meter reading on the Test Tractor?"));
await screenshot("speaking-question");
await sleep(600);
await click("Interrupt");
await waitFor("listening after the talk-over", "window.__voiceLog.some((e) => e.ev === 'stt-listening' && e.index === 5)", 8_000);
log = await voiceLog();
check("Interrupt cut the question short", log.some((e) => e.ev === "audio-stop-called") && !log.some((e) => e.ev === "audio-ended" && e.ms >= 5000 && e.t - log.find((x) => x.ev === "audio-start" && x.ms >= 5000).t > 5500));
await waitFor("asked again after a non-answer", "window.__voiceLog.some((e) => e.ev === 'tts-ssml' && e.index === 4)", 12_000);
check("a non-answer is asked again, not sent", (await events("turn")).length === 3);
await waitFor("the answer goes as a clarification", "window.__voiceLog.filter((e) => e.ev === 'turn').length >= 4", 15_000);
const turn3 = (await events("turn"))[3];
check("the spoken number continues the same exchange", turn3.body.clarification?.interactionId === "a0000000-0000-4000-8000-000000000003" && turn3.body.clarification?.reading === 1900 && turn3.body.channel === "voice" && turn3.body.input === "1900.", JSON.stringify(turn3.body));
await waitFor("second proposal being read back", "window.__voiceLog.some((e) => e.ev === 'audio-start' && e.ms === 7000)", 10_000);
await sleep(800);
const stopsBefore = (await events("audio-stop-called")).length;
await click("Confirm and save");
await waitFor("saved by the tap", "window.__voiceLog.filter((e) => e.ev === 'confirm').length >= 2", 6_000);
log = await voiceLog();
const readStart = log.find((e) => e.ev === "audio-start" && e.ms === 7000);
const saved = log.filter((e) => e.ev === "confirm")[1];
check("a tap during the read-back saves at once, without waiting it out", saved.t - readStart.t < 3000 && JSON.stringify(saved.body) === JSON.stringify({ proposalId: "b0000000-0000-4000-8000-000000000003", action: "confirm" }), `${saved.t - readStart.t} ms into a 7000 ms read-back`);
check("and the read-back stops when tapped", (await events("audio-stop-called")).length > stopsBefore);
await waitFor("the save is said aloud", "window.__voiceLog.some((e) => e.ev === 'tts-ssml' && e.index === 6)", 8_000);
check("the save is said aloud", (await voiceLog()).find((e) => e.ev === "tts-ssml" && e.index === 6).text.includes("Saved 1900 hours"));
await waitFor("listening after the save", "window.__voiceLog.some((e) => e.ev === 'stt-listening' && e.index === 7)", 10_000);
await screenshot("listening-after-save");
await waitFor("listening label", has("Listening… just talk"), 5_000);
await click("Stop hands-free");
await waitFor("stopped", `!${has("Stop hands-free")} && ${has("Talk hands-free")}`, 8_000);

// == 4. Stop while the last words are still being finished ==
await click("Talk hands-free");
await waitFor("final words heard", "window.__voiceLog.some((e) => e.ev === 'stt-final' && e.index === 8)", 15_000);
await waitFor("turn finishing", "window.__voiceLog.some((e) => e.ev === 'stt-end-of-stream' && e.index === 8)", 5_000);
await waitFor("thinking label", has("Thinking…"), 2_000);
await click("Stop hands-free");
await waitFor("screen handed back", `!${has("Stop hands-free")} && ${has("Interpret transcript")}`, 6_000);
await sleep(500);
const after = await text();
check("Stop while thinking hands the screen back instead of sticking", !after.includes("Thinking…") && !after.includes("Finishing the transcript…") && after.includes("Ready when you are"));
check("what was heard is kept, to send or edit", await evaluate(`document.querySelector("#assistant-transcript")?.value === "Is the test tractor due for a service?"`));
check("and nothing was sent", (await events("turn")).length === 4);
await screenshot("stopped-while-thinking");

// == 5. A garbled name is heard again, in the other language, before the turn is sent ==
await click("Talk hands-free");
await waitFor("the hard turn is sent", "window.__voiceLog.filter((e) => e.ev === 'turn').length >= 5", 25_000);
log = await voiceLog();
const reheard = log.find((e) => e.ev === "ws-open" && e.kind === "stt" && e.index === 10);
check("a turn the live transcript cannot carry is heard again, by a second recognition", Boolean(reheard));
const hardTurn = log.filter((e) => e.ev === "turn")[4];
check("the shown transcript is what was heard live", hardTurn.body.input === "What's the status of the desk bucket repairs?", JSON.stringify(hardTurn.body.input));
check("the second hearing travels with it for the server to weigh",
  JSON.stringify(hardTurn.body.alternatives) === JSON.stringify([{ text: "Wat se status van die test bakkie repairs?", locale: "af-ZA", source: "second-pass" }]),
  JSON.stringify(hardTurn.body.alternatives));
const easyTurns = log.filter((e) => e.ev === "turn").slice(0, 4);
check("easy turns were sent at once, with no second hearing", easyTurns.every((turn) => !turn.body.alternatives));
await waitFor("listening after the answer", "window.__voiceLog.some((e) => e.ev === 'stt-listening' && e.index === 11)", 12_000);
await waitFor("listening label", has("Listening… just talk"), 5_000);
await click("Stop hands-free");
await waitFor("stopped", `!${has("Stop hands-free")} && ${has("Talk hands-free")}`, 8_000);

log = await voiceLog();
const held = log.filter((e) => e.ev === "wakelock-request").length;
const let_go = log.filter((e) => e.ev === "wakelock-release").length;
check("every hands-free session takes the wake lock once and gives it back", held === 5 && let_go === 5, `${held} taken, ${let_go} released`);
const problems = log.filter((e) => ["page-error", "unhandled-rejection"].includes(e.ev));
check("no page errors or unhandled rejections", problems.length === 0, JSON.stringify(problems));
if (SHOTS) writeFileSync(join(SHOTS, "voice-log.json"), JSON.stringify(log, null, 1));
if (consoleLines.length) console.log("\nconsole:\n" + consoleLines.join("\n"));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
ws.close();
cleanup();
process.exit(failed.length ? 1 : 0);
