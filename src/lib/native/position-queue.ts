// The Android app's queue of recorded positions (task B6). Pure: storage, clock and sending are
// passed in, so the rules can be tested without a phone. Positions wait on the device until
// /api/positions takes them; they belong to one person and one driving session, and are dropped
// rather than sent under anyone else.

export type QueuedPoint = { lat: number; lng: number; at: string; speed: number | null; accuracy: number | null };

export type QueueState = {
  /** The signed-in person the points were recorded for. */
  owner: string;
  /** The driving session they belong to (/api/positions decides vehicle and business from it). */
  sessionId: string;
  points: QueuedPoint[];
  /** Failed sends in a row, for the backoff. */
  attempt: number;
  /** Not before this time (ms since epoch). */
  nextAt: number;
};

/** /api/positions takes at most 200 points a request (cleanPoints). */
export const BATCH_SIZE = 200;
/** /api/positions refuses points older than a day; the device does not keep them longer. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** About eleven hours of points every ten seconds: a bound on what a phone holds. */
export const MAX_POINTS = 4000;

export function emptyQueue(owner: string, sessionId: string): QueueState {
  return { owner, sessionId, points: [], attempt: 0, nextAt: 0 };
}

/** A stored queue, or null when there is none, it is unreadable, or it is someone else's. */
export function readQueue(raw: string | null, owner: string | null): QueueState | null {
  if (!raw || !owner) return null;
  try {
    const q = JSON.parse(raw) as Partial<QueueState>;
    if (q.owner !== owner || typeof q.sessionId !== "string" || !Array.isArray(q.points)) return null;
    return {
      owner: q.owner,
      sessionId: q.sessionId,
      points: q.points.filter(isPoint),
      attempt: Number.isInteger(q.attempt) && q.attempt! >= 0 ? q.attempt! : 0,
      nextAt: Number.isFinite(q.nextAt) ? q.nextAt! : 0,
    };
  } catch {
    return null;
  }
}

function isPoint(p: unknown): p is QueuedPoint {
  const q = p as Partial<QueuedPoint> | null;
  return !!q && typeof q.lat === "number" && typeof q.lng === "number" && typeof q.at === "string" && Number.isFinite(Date.parse(q.at));
}

/** Points too old for the server are dropped, then the oldest beyond the cap. */
export function addPoints(state: QueueState, points: QueuedPoint[], now: number): QueueState {
  const fresh = [...state.points, ...points.filter(isPoint)].filter((p) => now - Date.parse(p.at) <= MAX_AGE_MS);
  return { ...state, points: fresh.slice(-MAX_POINTS) };
}

/** Points the server would refuse as too old leave the queue (call before nextBatch). */
export function prune(state: QueueState, now: number): QueueState {
  const points = state.points.filter((p) => now - Date.parse(p.at) <= MAX_AGE_MS);
  return points.length === state.points.length ? state : { ...state, points };
}

/** The next batch to send (the front of the queue), or none while waiting out a backoff. */
export function nextBatch(state: QueueState, now: number): QueuedPoint[] {
  if (now < state.nextAt) return [];
  return state.points.slice(0, BATCH_SIZE);
}

/** 5 s, 10 s, 20 s ... at most five minutes between tries. */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 5 * 60_000);
}

export type SendOutcome =
  /** Taken: the batch leaves the queue. */
  | "sent"
  /** No signal or the server failed: keep everything, try again later. */
  | "retry"
  /** Signed out (401): keep the points until the person signs in again. */
  | "signed_out"
  /** The drive ended, the map is off, the business is stopped or this person may not add to it: stop and drop. */
  | "stop";

/** What a response means for the queue. Status 0 is no response at all (no network). */
export function outcomeOf(status: number): SendOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 401) return "signed_out";
  if ([400, 402, 403, 404, 409].includes(status)) return "stop";
  return "retry";
}

/** The queue after one send of `sent` points. */
export function afterSend(state: QueueState, outcome: SendOutcome, sent: number, now: number): QueueState {
  if (outcome === "sent") return { ...state, points: state.points.slice(sent), attempt: 0, nextAt: 0 };
  if (outcome === "stop") return { ...state, points: [], attempt: 0, nextAt: 0 };
  const attempt = state.attempt + 1;
  return { ...state, attempt, nextAt: now + backoffMs(attempt) };
}
