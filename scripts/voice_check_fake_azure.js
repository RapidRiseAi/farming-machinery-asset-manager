/**
 * Injected by `voice_check.mjs` before any page script runs. Stands in for Azure Speech
 * (the recognition and synthesis websockets) and the three assistant routes, so the real
 * production bundle and the real Speech SDK run end to end with no secrets and no writes.
 *
 * The websocket half speaks the SDK's own framing: text frames of CRLF headers and a
 * body, binary frames with a two-byte header length. Every reply echoes the request's
 * X-RequestId, which the SDK checks before it reads anything; synthesis announces a
 * stream id in a "response" message, which its audio frames must then carry. The audio
 * is a WAV tone: the SDK passes the bytes through untouched, and decodeAudioData reads
 * WAV.
 *
 * Everything it sees, and every sound and microphone the page asks for, goes to
 * window.__voiceLog for the driver to assert on.
 */
(() => {
  try { localStorage.setItem("farmgear:tour-done", "1"); } catch {}
  const log = (window.__voiceLog = []);
  const note = (ev, extra = {}) => log.push({ t: Math.round(performance.now()), ev, ...extra });
  // Filled in by the driver after load. stt[i] = what connection i "hears" (null = silence).
  window.__voiceScript = { stt: [], ttsMs: [], turns: [], confirm: [] };
  const script = () => window.__voiceScript;

  // == Azure Speech websocket stand-in ======================================
  const RealWebSocket = window.WebSocket;
  let sttCount = 0;
  let ttsCount = 0;
  const encoder = new TextEncoder();
  const headerText = (headers) => Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  const parseHeaders = (text) => {
    const headers = {};
    for (const line of text.split("\r\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return headers;
  };
  function wavTone(ms) {
    const rate = 16000;
    const n = Math.round((rate * ms) / 1000);
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i += 1) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i += 1) v.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 2500), true);
    return new Uint8Array(buf);
  }

  class FakeSpeechSocket {
    constructor(url) {
      this.CONNECTING = 0; this.OPEN = 1; this.CLOSING = 2; this.CLOSED = 3;
      this.url = url;
      this.readyState = 0;
      this.binaryType = "blob";
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.kind = /\.stt\.speech\./.test(url) ? "stt" : "tts";
      this.index = this.kind === "stt" ? sttCount++ : ttsCount++;
      this.timers = [];
      this.requestId = "";
      note("ws-open", { kind: this.kind, index: this.index, lid: /universal\/v2/.test(url) });
      setTimeout(() => { this.readyState = 1; this.onopen?.({ type: "open" }); }, 25);
    }
    later(ms, fn) { this.timers.push(setTimeout(() => { if (this.readyState === 1) fn(); }, ms)); }
    emitText(path, body) {
      if (this.readyState !== 1) return;
      const headers = { Path: path, "X-RequestId": this.requestId, "Content-Type": "application/json; charset=utf-8" };
      this.onmessage?.({ data: `${headerText(headers)}\r\n${body}` });
    }
    emitAudio(streamId, bytes) {
      if (this.readyState !== 1) return;
      const head = encoder.encode(headerText({ Path: "audio", "X-RequestId": this.requestId, "X-StreamId": streamId, "Content-Type": "audio/mpeg" }));
      const out = new Uint8Array(2 + head.length + bytes.length);
      out[0] = (head.length >> 8) & 0xff; out[1] = head.length & 0xff;
      out.set(head, 2); out.set(bytes, 2 + head.length);
      this.onmessage?.({ data: out.buffer });
    }
    send(data) {
      if (typeof data === "string") {
        const split = data.indexOf("\r\n\r\n");
        const headers = parseHeaders(data.slice(0, split));
        const body = data.slice(split + 4);
        if (headers["x-requestid"]) this.requestId = headers["x-requestid"];
        if (this.kind === "stt" && headers.path === "speech.context") {
          try {
            const context = JSON.parse(body);
            const phrases = context?.dgi?.Groups?.flatMap((g) => g.Items?.map((i) => i.Text) ?? []) ?? [];
            note("stt-context", { index: this.index, phrases: phrases.length, hasRooiBakkie: phrases.includes("rooi bakkie") || phrases.includes("bakkie"), languageId: Boolean(context?.languageId) });
          } catch { note("stt-context", { index: this.index, unparsed: true }); }
        }
        if (this.kind === "tts" && headers.path === "ssml") this.synthesize(body);
        return;
      }
      const view = new DataView(data);
      const length = view.getInt16(0);
      let text = "";
      for (let i = 0; i < length; i += 1) text += String.fromCharCode(view.getUint8(i + 2));
      const headers = parseHeaders(text);
      if (headers["x-requestid"]) this.requestId = headers["x-requestid"];
      const bodyLength = data.byteLength - 2 - length;
      if (this.kind !== "stt") return;
      if (!this.audioStarted) { this.audioStarted = true; this.recognize(); }
      if (bodyLength === 0 && !this.ended) {
        this.ended = true;
        note("stt-end-of-stream", { index: this.index });
        // endDelayMs stretches Azure's closing of the turn, to widen the "Thinking" window.
        // A file is streamed in a moment, so the turn also waits for its scripted phrase.
        const phraseLeft = Math.max(0, (this.phraseDoneAt ?? 0) - Date.now() + 60);
        this.later(Math.max(script().stt[this.index]?.endDelayMs ?? 40, phraseLeft), () => {
          this.emitText("speech.endDetected", JSON.stringify({ Offset: 0 }));
          this.emitText("turn.end", "{}");
        });
      }
    }
    recognize() {
      const say = script().stt[this.index] ?? null;
      note("stt-listening", { index: this.index, says: say ? say.text : null });
      this.later(80, () => this.emitText("turn.start", JSON.stringify({ context: { serviceTag: "fake" } })));
      if (!say) return;
      const words = say.text.split(" ");
      const locale = say.locale ?? "en-ZA";
      let at = say.delayMs ?? 700;
      this.later(at, () => this.emitText("speech.startDetected", JSON.stringify({ Offset: 5_000_000 })));
      for (let i = 1; i <= words.length; i += 1) {
        at += 160;
        const partial = words.slice(0, i).join(" ").toLowerCase().replace(/[?.!,]/g, "");
        const last = i === words.length;
        this.later(at, () => {
          if (last) note("stt-last-word", { index: this.index });
          this.emitText("speech.hypothesis", JSON.stringify({
            Text: partial, Offset: 5_000_000, Duration: i * 2_000_000,
            PrimaryLanguage: { Language: locale, Confidence: "High" },
          }));
        });
      }
      at += 450;
      this.phraseDoneAt = Date.now() + at;
      // noFinal: beside a running engine Azure hears sound, not silence, and never closes
      // the phrase. The app must still end the turn on its own.
      if (say.noFinal) return;
      this.later(at, () => {
        note("stt-final", { index: this.index, text: say.text });
        this.emitText("speech.phrase", JSON.stringify({
          RecognitionStatus: "Success", Offset: 5_000_000, Duration: words.length * 2_000_000, DisplayText: say.text,
          NBest: [{ Confidence: 0.91, Lexical: say.text.toLowerCase(), ITN: say.text, MaskedITN: say.text, Display: say.text }],
          PrimaryLanguage: { Language: locale, Confidence: "High" },
        }));
      });
    }
    synthesize(ssml) {
      const ms = script().ttsMs[this.index] ?? 900;
      note("tts-ssml", { index: this.index, ms, text: ssml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400) });
      const streamId = `stream-${this.index}`;
      this.later(120, () => {
        this.emitText("turn.start", JSON.stringify({ context: { serviceTag: "fake" } }));
        this.emitText("response", JSON.stringify({ context: { serviceTag: "fake" }, audio: { type: "inline", streamId } }));
        this.emitAudio(streamId, wavTone(ms));
        this.emitText("turn.end", "{}");
      });
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this.timers.forEach(clearTimeout);
      note("ws-close", { kind: this.kind, index: this.index });
      setTimeout(() => { this.readyState = 3; this.onclose?.({ code, reason, wasClean: true }); }, 10);
    }
    addEventListener() {}
    removeEventListener() {}
  }
  function PatchedWebSocket(url, protocols) {
    if (/\.(stt|tts)\.speech\.microsoft\.com/.test(String(url))) return new FakeSpeechSocket(String(url));
    return protocols === undefined ? new RealWebSocket(url) : new RealWebSocket(url, protocols);
  }
  Object.assign(PatchedWebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  PatchedWebSocket.prototype = RealWebSocket.prototype;
  window.WebSocket = PatchedWebSocket;

  // == The assistant routes ==================================================
  const realFetch = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.href).pathname;
    if (path === "/api/assistant/speech-token") {
      // Every real token comes with the voice session it opened (docs/AI_USAGE.md).
      const sent = JSON.parse(init?.body ?? "{}");
      note("token", { clientVersion: sent.clientVersion ?? null });
      return json({
        token: `fake-${"t".repeat(40)}`,
        region: "southafricanorth",
        expiresAt: Date.now() + 9 * 60_000,
        session: { sessionId: crypto.randomUUID(), maxAudioMs: 120000, maxCharacters: 1500 },
      });
    }
    if (path === "/api/assistant/turn") {
      const body = JSON.parse(init?.body ?? "{}");
      const next = script().turns.shift() ?? { kind: "error", code: "script_exhausted", message: "No scripted reply left." };
      note("turn", { body, reply: next.kind });
      await new Promise((r) => setTimeout(r, 250));
      return json(next);
    }
    if (path === "/api/assistant/confirm") {
      const body = JSON.parse(init?.body ?? "{}");
      const next = script().confirm.shift() ?? { ok: false, code: "script_exhausted", message: "No scripted reply left." };
      note("confirm", { body });
      await new Promise((r) => setTimeout(r, 200));
      return json(next);
    }
    // The AI notice, voice metering and the AI hearing (docs/AI_USAGE.md) are stood in as
    // well, so a run, against production included, still writes nothing.
    if (path === "/api/assistant/notice") {
      const body = JSON.parse(init?.body ?? "{}");
      note("notice", { keepOn: body.keepOn });
      return json({ aiOn: Boolean(body.keepOn), withdrawn: false, noticeSeenAt: new Date().toISOString() });
    }
    if (path === "/api/assistant/voice-session") {
      const body = JSON.parse(init?.body ?? "{}");
      note("voice-session", body);
      return json({ ok: true, sessionId: crypto.randomUUID(), maxAudioMs: body.maxAudioMs ?? 120000, maxCharacters: body.maxCharacters ?? 1500 });
    }
    if (path === "/api/assistant/voice-usage") {
      note("voice-usage", JSON.parse(init?.body ?? "{}"));
      return new Response(null, { status: 204 });
    }
    if (path === "/api/assistant/transcribe") {
      note("transcribe");
      return json({ error: "transcription_unavailable" }, 503);
    }
    return realFetch(input, init);
  };
  // The closing page's last usage report goes by beacon, past fetch: stand that in too.
  const realBeacon = navigator.sendBeacon?.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    if (new URL(String(url), location.href).pathname === "/api/assistant/voice-usage") {
      const read = data instanceof Blob ? data.text() : Promise.resolve(String(data ?? "{}"));
      void read.then((body) => note("voice-usage-beacon", JSON.parse(body || "{}"))).catch(() => note("voice-usage-beacon"));
      return true;
    }
    return realBeacon ? realBeacon(url, data) : false;
  };

  // == What actually reached the speakers and the microphone ==================
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    // Resampling a recorded clip renders on an OfflineAudioContext: not sound, not counted.
    if (typeof OfflineAudioContext !== "undefined" && this.context instanceof OfflineAudioContext) return start.apply(this, args);
    const duration = this.buffer ? Math.round(this.buffer.duration * 1000) : null;
    note("audio-start", { ms: duration, ctx: this.context.state });
    this.addEventListener("ended", () => note("audio-ended", { ms: duration }));
    return start.apply(this, args);
  };
  const realStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.stop = function (...args) {
    note("audio-stop-called");
    return realStop.apply(this, args);
  };
  if (navigator.mediaDevices?.getUserMedia) {
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => { note("mic-open"); return gum(constraints); };
  }
  // Headless Chrome has no screen to keep awake: a stand-in records what the page asks for.
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: {
      request: async (type) => {
        note("wakelock-request", { type });
        const sentinel = {
          type, released: false, onrelease: null,
          release: async () => { if (!sentinel.released) { sentinel.released = true; note("wakelock-release"); } },
          addEventListener() {}, removeEventListener() {},
        };
        return sentinel;
      },
    },
  });
  window.addEventListener("error", (e) => note("page-error", { message: String(e.message).slice(0, 200) }));
  window.addEventListener("unhandledrejection", (e) => note("unhandled-rejection", { reason: String(e.reason).slice(0, 200) }));
})();
