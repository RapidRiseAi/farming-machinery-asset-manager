// Offline mutation queue — persistence + change notification.
// Subscribers (the shell sync-status pill) are notified locally and across tabs
// (BroadcastChannel) whenever the queue changes.

import { idbCount, idbDelete, idbGetAll, idbPut } from "./db";
import type { QueuedMutation } from "./types";

const CHANNEL = "fleetwise-offline";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function ensureChannel() {
  if (channel === null && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = () => listeners.forEach((l) => l());
  }
}

function emit() {
  listeners.forEach((l) => l());
  ensureChannel();
  channel?.postMessage("changed");
}

/** Subscribe to queue changes; returns an unsubscribe fn. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureChannel();
  return () => listeners.delete(cb);
}

export async function enqueue(m: QueuedMutation): Promise<void> {
  await idbPut(m);
  emit();
}

export async function dequeue(clientId: string): Promise<void> {
  await idbDelete(clientId);
  emit();
}

export async function listMutations(): Promise<QueuedMutation[]> {
  return idbGetAll();
}

export async function pendingCount(): Promise<number> {
  try {
    return await idbCount();
  } catch {
    return 0;
  }
}

/** A fresh client idempotency key for a captured mutation. */
export function newMutationId(): string {
  return crypto.randomUUID();
}
