"use client";

// Recording a drive in the Android app (task B6). The person starts it on the drive's page; the
// background-geolocation plugin then runs a foreground service with a notification, so positions
// keep coming with the screen locked or another app in front. They wait on the device, one queue per
// drive (position-queue.ts), and go to /api/positions through native HTTP, which Android does not
// throttle the way it throttles a backgrounded WebView. Recording stops when the person stops it,
// when the server says the drive has ended (or the map is off, or the business is stopped), and on
// sign-out or a different person signing in. Nothing here runs in a browser: isNativeApp() first.

import { isNativeApp } from "./platform";
import {
  addPoints, afterSend, emptyQueue, nextBatch, outcomeOf, prune, readQueue,
  type QueueState, type QueuedPoint, type SendOutcome,
} from "./position-queue";

const QUEUE_PREFIX = "fw-native:positions:";
const RECORDING_KEY = "fw-native:recording";
const SEND_EVERY_MS = 30_000;

export type NativeRecordingState =
  | { status: "idle" }
  | { status: "recording"; sessionId: string; queued: number }
  | { status: "denied" }
  | { status: "stopped"; reason: "ended" | "signed_out" };

export type NativeLabels = { title: string; message: string };
type Watcher = { id: string; owner: string; sessionId: string; timer: ReturnType<typeof setInterval> };

let watcher: Watcher | null = null;
let state: NativeRecordingState = { status: "idle" };
let sending = false;
const listeners = new Set<(s: NativeRecordingState) => void>();

function publish(next: NativeRecordingState) {
  state = next;
  for (const l of listeners) l(state);
}

export function nativeRecordingState(): NativeRecordingState {
  return state;
}

export function subscribeNativeRecording(listener: (s: NativeRecordingState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Storage that cannot be read (a full disk, a locked profile) must never stop a drive recording.
function queueKeys(): string[] {
  try { return Object.keys(localStorage).filter((k) => k.startsWith(QUEUE_PREFIX)); } catch { return []; }
}
function readKey(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function removeKey(key: string) {
  try { localStorage.removeItem(key); } catch { /* already unreadable */ }
}
function load(owner: string, sessionId: string): QueueState | null {
  try { return readQueue(localStorage.getItem(QUEUE_PREFIX + sessionId), owner); } catch { return null; }
}
function save(q: QueueState) {
  try {
    if (q.points.length > 0) localStorage.setItem(QUEUE_PREFIX + q.sessionId, JSON.stringify(q));
    else localStorage.removeItem(QUEUE_PREFIX + q.sessionId);
  } catch { /* the points are lost only if the app closes before the next save */ }
}

async function plugins() {
  const { registerPlugin, CapacitorHttp } = await import("@capacitor/core");
  type Plugin = import("@capacitor-community/background-geolocation").BackgroundGeolocationPlugin;
  return { geo: registerPlugin<Plugin>("BackgroundGeolocation"), http: CapacitorHttp };
}

/** Send one drive's queue, a batch at a time, until it is empty or a send does not succeed. */
async function flushQueue(owner: string, sessionId: string): Promise<SendOutcome | null> {
  let q = load(owner, sessionId);
  let last: SendOutcome | null = null;
  while (q) {
    q = prune(q, Date.now());
    const batch = nextBatch(q, Date.now());
    if (batch.length === 0) break;
    let status = 0;
    try {
      const { http } = await plugins();
      const response = await http.post({
        url: `${window.location.origin}/api/positions`,
        headers: { "content-type": "application/json" },
        data: { session_id: sessionId, points: batch },
      });
      status = response.status;
    } catch {
      status = 0; // no response: no network
    }
    last = outcomeOf(status);
    q = afterSend(q, last, batch.length, Date.now());
    save(q);
    if (last !== "sent") break;
  }
  if (q) save(q);
  return last;
}

/** Every queue this person has on the device (a drive that ended before its points were sent too). */
async function flushAll(owner: string): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    for (const key of queueKeys()) {
      const sessionId = key.slice(QUEUE_PREFIX.length);
      const outcome = await flushQueue(owner, sessionId);
      if (outcome === "stop" && watcher?.sessionId === sessionId) await stopNativeRecording("ended");
    }
    if (watcher && state.status === "recording") {
      publish({ status: "recording", sessionId: watcher.sessionId, queued: load(owner, watcher.sessionId)?.points.length ?? 0 });
    }
  } finally {
    sending = false;
  }
}

/**
 * Start recording one drive, on the person's explicit tap. The plugin asks for location with
 * Android's own prompt; a refusal leaves the drive unrecorded and says so.
 */
export async function startNativeRecording(input: { owner: string; sessionId: string; labels: NativeLabels }): Promise<NativeRecordingState> {
  if (!isNativeApp()) return state;
  if (watcher && watcher.sessionId === input.sessionId && watcher.owner === input.owner) return state;
  if (watcher) await stopNativeRecording(null);
  const { geo } = await plugins();
  const id = await geo.addWatcher(
    {
      // With a message the plugin runs a foreground service and keeps reporting in the background.
      backgroundMessage: input.labels.message,
      backgroundTitle: input.labels.title,
      requestPermissions: true,
      stale: false,
      distanceFilter: 20,
    },
    (location, error) => {
      if (error) {
        if (error.code === "NOT_AUTHORIZED") void stopNativeRecording(null).then(() => publish({ status: "denied" }));
        return;
      }
      if (!location) return;
      const point: QueuedPoint = {
        lat: location.latitude,
        lng: location.longitude,
        at: new Date(location.time ?? Date.now()).toISOString(),
        speed: location.speed == null ? null : location.speed * 3.6,
        accuracy: location.accuracy ?? null,
      };
      const next = addPoints(load(input.owner, input.sessionId) ?? emptyQueue(input.owner, input.sessionId), [point], Date.now());
      save(next);
      if (state.status === "recording") publish({ status: "recording", sessionId: input.sessionId, queued: next.points.length });
    },
  );
  const timer = setInterval(() => void flushAll(input.owner), SEND_EVERY_MS);
  watcher = { id, owner: input.owner, sessionId: input.sessionId, timer };
  try { localStorage.setItem(RECORDING_KEY, JSON.stringify({ owner: input.owner, sessionId: input.sessionId, labels: input.labels })); } catch { /* resume is best effort */ }
  if (state.status !== "denied") publish({ status: "recording", sessionId: input.sessionId, queued: load(input.owner, input.sessionId)?.points.length ?? 0 });
  return state;
}

/** Stop recording. With no reason (the person stopped it) what is queued is sent first. */
export async function stopNativeRecording(reason: "ended" | "signed_out" | null = null): Promise<void> {
  const current = watcher;
  watcher = null;
  try { localStorage.removeItem(RECORDING_KEY); } catch { /* nothing to resume either way */ }
  if (current) {
    clearInterval(current.timer);
    try {
      const { geo } = await plugins();
      await geo.removeWatcher({ id: current.id });
    } catch { /* the foreground service ends with the app in any case */ }
    if (reason === null) await flushAll(current.owner);
  }
  publish(reason ? { status: "stopped", reason } : { status: "idle" });
}

/** When the app opens or a page loads: carry on a drive this person started; send what is waiting. */
export async function resumeNativeRecording(owner: string | null): Promise<void> {
  if (!isNativeApp()) return;
  let marker: { owner?: string; sessionId?: string; labels?: NativeLabels } | null = null;
  try { marker = JSON.parse(localStorage.getItem(RECORDING_KEY) ?? "null"); } catch { marker = null; }
  // Nobody signed in, or a different person: what was recorded before is not theirs to send or see.
  if (!owner || (marker?.owner && marker.owner !== owner)) {
    await clearNativeData();
    if (!owner) return;
    marker = null;
  }
  for (const key of queueKeys()) {
    if (!readQueue(readKey(key), owner)) removeKey(key);
  }
  if (marker?.owner === owner && marker.sessionId && marker.labels && !watcher) {
    await startNativeRecording({ owner, sessionId: marker.sessionId, labels: marker.labels });
  }
  await flushAll(owner);
}

/** Sign-out: stop recording and forget everything recorded on this device. */
export async function clearNativeData(): Promise<void> {
  if (watcher) await stopNativeRecording("signed_out");
  for (const key of queueKeys()) { try { localStorage.removeItem(key); } catch { /* already gone */ } }
  try { localStorage.removeItem(RECORDING_KEY); } catch { /* already gone */ }
  publish({ status: "idle" });
}

/** The plugin's shortcut to the app's settings, after a refused permission. */
export async function openNativeSettings(): Promise<void> {
  if (!isNativeApp()) return;
  const { geo } = await plugins();
  await geo.openSettings();
}
