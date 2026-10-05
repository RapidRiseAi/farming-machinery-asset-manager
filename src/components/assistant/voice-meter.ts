/**
 * Meters the browser's Azure Speech use against server-held voice sessions
 * (docs/AI_USAGE.md).
 *
 * Azure recognition and speech run in the browser on a token that works for the whole
 * Speech resource, so only the browser knows how much it used. Every token the server
 * hands out opens a session (holding budget), which the meter adopts; before each use the
 * meter makes sure the open session can take it, opening another when it is full or old
 * (the server refuses when the farm is paused, and shrinks a session to the budget left).
 * After each use it reports the running totals within a couple of seconds, and also every
 * 30 seconds; when the app is hidden or the page closes it closes the session with a final
 * report (a beacon, which outlives the page). Reporting promptly matters twice over: the
 * server bills a session that never reports at its full maximum (right for an app that
 * never reports, wrong for one that did not get the chance), and an open session's hold
 * counts against the farm's month until it is closed. The server clamps every report to
 * the session's maximum.
 */

/** Sent with every token and session request; the server keeps it with the session. */
export const VOICE_CLIENT_VERSION = "voice-3";

/** One session covers this much, and is replaced when it fills (server cap: 120 s, 4000). */
const SESSION_AUDIO_MS = 120_000;
const SESSION_CHARACTERS = 1_500;
const REPORT_EVERY_MS = 30_000;
/** A report goes out this soon after any use, so a swiped-away app has already reported. */
const REPORT_AFTER_USE_MS = 1_500;
/**
 * A session older than this is not used again: the nightly sweep closes sessions under a
 * tab left open, and use reported to a closed session would go unmetered.
 */
const SESSION_MAX_AGE_MS = 9 * 60_000;
const SESSION_ENDPOINT = "/api/assistant/voice-session";
const USAGE_ENDPOINT = "/api/assistant/voice-usage";

/** A session as the server returns it, with a token or on its own. */
export type HeldSession = { sessionId: string; maxAudioMs: number; maxCharacters: number };

/** Use by the operation still running, since the last time it was read. */
export type InFlightUse = { liveMs: number; fixedMs: number };

type Session = {
  id: string;
  maxAudioMs: number;
  maxCharacters: number;
  audioMs: number;
  audioFixedMs: number;
  characters: number;
  dirty: boolean;
  openedAt: number;
};

type Use = { audioMs?: number; audioFixedMs?: number; characters?: number };

export class VoiceMeter {
  private session: Session | null = null;
  private opening: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  /** Use that did not fit the session it happened in, added to the next one opened. */
  private carry: Required<Use> = { audioMs: 0, audioFixedMs: 0, characters: 0 };
  private inFlight: (() => InFlightUse) | null = null;
  private readonly onPageHide = () => {
    this.flushInFlight();
    void this.close(true);
  };
  private readonly onVisibility = () => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") return;
    // Hidden is often the last thing an installed app on a phone ever sees (a swiped-away
    // app gets no pagehide). Close the session now, so its hold stops counting against the
    // month at once; the next use after coming back opens another.
    this.flushInFlight();
    void this.close(true);
  };

  /** `refused` turns a refused session response into the client's own error (limit, voice off). */
  constructor(private readonly refused: (response: Response) => Promise<Error>) {
    if (typeof window !== "undefined") window.addEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  /**
   * How to read the operation still running (a recognition in progress): the use since the
   * last read, restarting its count from now, so a report sent while it runs includes it
   * and nothing is counted twice when it ends.
   */
  setInFlight(read: (() => InFlightUse) | null): void {
    this.inFlight = read;
  }

  /**
   * Takes the session the server opened with an Azure token; the one held before is closed
   * in the background, so speech never waits on a report. Waits for a session being opened
   * first, or that one would replace this and leave it never reported.
   */
  async adopt(held: HeldSession): Promise<void> {
    if (this.opening) await this.opening.catch(() => undefined);
    if (this.session?.id === held.sessionId) return;
    this.replace(this.fresh(held));
  }

  /**
   * Makes sure the open session can take this much more use, opening a new one (and
   * closing the full or old one) if not. Throws the refusal when the farm is paused:
   * nothing is started without budget held for it.
   */
  async ensure(need: { audioMs?: number; characters?: number }): Promise<void> {
    if (this.opening) await this.opening;
    const audio = Math.max(0, need.audioMs ?? 0);
    const characters = Math.max(0, need.characters ?? 0);
    const s = this.session;
    if (s && Date.now() - s.openedAt < SESSION_MAX_AGE_MS) {
      const audioRoom = s.maxAudioMs - s.audioMs - s.audioFixedMs;
      const charRoom = s.maxCharacters - s.characters;
      if (audioRoom >= audio && charRoom >= characters) return;
      // A session the server shrank to the month's last budget is all there is: another
      // would only be refused, and tell the owner the limit is reached while budget
      // remains. Use what is left; anything past it is carried, then refused next time.
      const shrunk = s.maxAudioMs < SESSION_AUDIO_MS || s.maxCharacters < SESSION_CHARACTERS;
      if (shrunk && audioRoom > 0 && (characters === 0 || charRoom > 0)) return;
    }
    const opening = (async () => {
      // Release first, so the old session's hold is settled before the new one is sized
      // and, near the limit, the new one is sized on what is really left.
      if (this.session) await this.close(false);
      const held = await this.open(Math.max(SESSION_AUDIO_MS, audio), Math.max(SESSION_CHARACTERS, characters));
      this.replace(this.fresh(held));
    })();
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  /** Live recognition (continuous language ID), measured as time with the microphone open. */
  addLive(ms: number): void {
    this.add({ audioMs: ms });
  }

  /** A clip recognised in one fixed language (the second hearing). */
  addFixed(ms: number): void {
    this.add({ audioFixedMs: ms });
  }

  /** Characters sent to speech synthesis. */
  addCharacters(count: number): void {
    this.add({ characters: count });
  }

  /** Sends the final report for the open session, by beacon when the page is closing. */
  async close(pageClosing = false): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.stopTimers();
    await this.send(s, true, pageClosing);
  }

  /** The last report, by beacon in case the page is going; call after recognition has stopped. */
  dispose(): void {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.flushInFlight();
    this.inFlight = null;
    void this.close(true);
  }

  /** Makes `next` the open session and sends the previous one's final report in the background. */
  private replace(next: Session): void {
    const previous = this.session;
    this.session = next;
    this.startTimer();
    this.reportSoon();
    if (previous) void this.send(previous, true, false);
  }

  private fresh(held: HeldSession): Session {
    const s: Session = {
      id: held.sessionId,
      maxAudioMs: Math.max(0, held.maxAudioMs),
      maxCharacters: Math.max(0, held.maxCharacters),
      audioMs: 0,
      audioFixedMs: 0,
      characters: 0,
      // A session reports at least once, even with nothing used, so it is settled at
      // what was used rather than at its maximum.
      dirty: true,
      openedAt: Date.now(),
    };
    const carried = this.carry;
    this.carry = { audioMs: 0, audioFixedMs: 0, characters: 0 };
    this.addTo(s, carried);
    return s;
  }

  private flushInFlight(): void {
    const read = this.inFlight;
    if (!read) return;
    const use = read();
    if (use.liveMs > 0 || use.fixedMs > 0) this.add({ audioMs: use.liveMs, audioFixedMs: use.fixedMs });
  }

  private add(use: Use): void {
    const s = this.session;
    if (!s) {
      this.carryOver(use);
      return;
    }
    this.addTo(s, use);
    this.reportSoon();
  }

  /** Adds what fits; what does not fit is carried to the next session. */
  private addTo(s: Session, use: Use): void {
    const audioRoom = Math.max(0, s.maxAudioMs - s.audioMs - s.audioFixedMs);
    const wantLive = Math.max(0, use.audioMs ?? 0);
    const wantFixed = Math.max(0, use.audioFixedMs ?? 0);
    const live = Math.min(wantLive, audioRoom);
    const fixed = Math.min(wantFixed, audioRoom - live);
    const wantChars = Math.max(0, use.characters ?? 0);
    const chars = Math.min(wantChars, Math.max(0, s.maxCharacters - s.characters));
    s.audioMs += live;
    s.audioFixedMs += fixed;
    s.characters += chars;
    s.dirty = true;
    this.carryOver({ audioMs: wantLive - live, audioFixedMs: wantFixed - fixed, characters: wantChars - chars });
  }

  private carryOver(use: Use): void {
    this.carry.audioMs += Math.max(0, use.audioMs ?? 0);
    this.carry.audioFixedMs += Math.max(0, use.audioFixedMs ?? 0);
    this.carry.characters += Math.max(0, use.characters ?? 0);
  }

  private startTimer(): void {
    if (!this.timer) {
      this.timer = setInterval(() => {
        // A long recognition still running is in the report, not only when it ends: an
        // app killed without warning is then billed what it had used.
        this.flushInFlight();
        void this.report(false, false);
      }, REPORT_EVERY_MS);
    }
  }

  private stopTimers(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.soon) {
      clearTimeout(this.soon);
      this.soon = null;
    }
  }

  private reportSoon(): void {
    if (this.soon) clearTimeout(this.soon);
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.report(false, false);
    }, REPORT_AFTER_USE_MS);
  }

  private async report(final: boolean, beacon: boolean): Promise<void> {
    const s = this.session;
    if (s && (s.dirty || final)) await this.send(s, final, beacon);
  }

  private async send(s: Session, final: boolean, beacon: boolean): Promise<void> {
    s.dirty = false;
    const body = JSON.stringify({
      sessionId: s.id,
      audioMs: Math.round(s.audioMs),
      audioFixedMs: Math.round(s.audioFixedMs),
      characters: Math.round(s.characters),
      final,
    });
    if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      // A closing or hidden page cannot count on a fetch finishing; a beacon is delivered
      // after it is gone.
      if (navigator.sendBeacon(USAGE_ENDPOINT, new Blob([body], { type: "text/plain" }))) return;
    }
    const response = await fetch(USAGE_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body,
    }).catch(() => null);
    if (response?.status === 410) {
      // Closed already (the nightly sweep under a tab left open): never report to it again;
      // the next use opens another.
      if (this.session === s) {
        this.session = null;
        this.stopTimers();
      }
      return;
    }
    // Not delivered: try again with the next report.
    if (!response || !response.ok) s.dirty = true;
  }

  private async open(maxAudioMs: number, maxCharacters: number): Promise<HeldSession> {
    const response = await fetch(SESSION_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        maxAudioMs: Math.min(Math.round(maxAudioMs), 120_000),
        maxCharacters: Math.min(Math.round(maxCharacters), 4_000),
        clientVersion: VOICE_CLIENT_VERSION,
      }),
    });
    if (!response.ok) throw await this.refused(response);
    const value = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!value || typeof value.sessionId !== "string") throw await this.refused(response);
    return {
      sessionId: value.sessionId,
      maxAudioMs: Number(value.maxAudioMs) || 0,
      maxCharacters: Number(value.maxCharacters) || 0,
    };
  }
}

/** Reads the session an Azure token came with (speech-token), if the response carried one. */
export function tokenSession(value: Record<string, unknown>): HeldSession | null {
  const session = value.session as Record<string, unknown> | undefined;
  if (!session || typeof session.sessionId !== "string") return null;
  return {
    sessionId: session.sessionId,
    maxAudioMs: Number(session.maxAudioMs) || 0,
    maxCharacters: Number(session.maxCharacters) || 0,
  };
}

/** Playing time of the recorder's WAV (16 kHz mono 16-bit: 32 bytes a millisecond). */
export function clipDurationMs(file: { size: number }): number {
  return Math.max(0, Math.round((file.size - 44) / 32));
}
