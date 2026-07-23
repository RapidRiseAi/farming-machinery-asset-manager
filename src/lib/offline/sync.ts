// Flush engine: replays queued mutations to /api/sync, idempotently.
// A module-level guard prevents overlapping flushes; auto-flush registration is
// idempotent so both the app shell and the public QR page can arm it safely.

import { dequeue, listMutations, pendingCount } from "./queue";
import type { QueuedMutation } from "./types";

let flushing = false;
let armed = false;

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

/** Rebuild the multipart body the /api/sync route expects for one mutation. */
export function buildFormData(m: QueuedMutation): FormData {
  const fd = new FormData();
  fd.set("client_id", m.client_id);
  fd.set("client_ts", m.client_ts);
  fd.set("type", m.type);
  fd.set("scope", m.scope);
  fd.set("payload", JSON.stringify(m.fields));
  if (m.photo) fd.set("photo", m.photo, "photo.jpg");
  if (m.voice) fd.set("voice", m.voice, "voice.webm");
  return fd;
}

function dispatch(name: string, detail?: unknown) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(name, detail === undefined ? undefined : { detail }));
  }
}

async function safeCount(): Promise<number> {
  try {
    return await pendingCount();
  } catch {
    return 0;
  }
}

/**
 * Flush the queue. Each mutation is POSTed once; the server dedupes by client UUID so
 * replays are safe. Response handling:
 *   2xx            → applied/duplicate/conflict all recorded server-side → drop locally.
 *   401/429/5xx    → transient (session refresh / rate limit / server) → stop, retry later.
 *   4xx (other)    → permanent (malformed / access / gone) → drop so the queue can't wedge.
 *   network error  → stop, retry on next online/visibility event.
 */
export async function flush(): Promise<{ applied: number; remaining: number }> {
  if (flushing || !isOnline()) return { applied: 0, remaining: await safeCount() };
  flushing = true;
  dispatch("fleetwise:syncing");
  let applied = 0;
  try {
    const items = await listMutations();
    for (const m of items) {
      let res: Response;
      try {
        res = await fetch("/api/sync", { method: "POST", body: buildFormData(m) });
      } catch {
        break; // network dropped mid-flush
      }
      if (res.ok) {
        await dequeue(m.client_id);
        applied += 1;
      } else if (res.status === 401 || res.status === 429 || res.status >= 500) {
        break; // transient — keep queued, retry later
      } else {
        await dequeue(m.client_id); // permanent — drop
      }
    }
  } finally {
    flushing = false;
    dispatch("fleetwise:flushed", { applied });
  }
  return { applied, remaining: await safeCount() };
}

/** Arm auto-flush on reconnect / tab-focus. Idempotent. */
export function registerAutoFlush(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const trigger = () => void flush();
  window.addEventListener("online", trigger);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && isOnline()) trigger();
  });
  if (isOnline()) trigger();
}
