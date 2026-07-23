// Minimal IndexedDB wrapper (no dependency) for the offline mutation queue.
// One object store, keyed by the mutation's client_id. Blobs (photos/voice) are
// stored natively by IndexedDB, so offline media survives a reload/close.

import type { QueuedMutation } from "./types";

const DB_NAME = "fleetwise-offline";
const DB_VERSION = 1;
const STORE = "mutations";

let dbPromise: Promise<IDBDatabase> | null = null;

/** True when IndexedDB is usable (guards SSR + private-mode failures). */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined";
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "client_id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const req = run(transaction.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut(m: QueuedMutation): Promise<void> {
  await tx("readwrite", (s) => s.put(m));
}

export async function idbDelete(clientId: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(clientId));
}

export async function idbGetAll(): Promise<QueuedMutation[]> {
  const all = await tx<QueuedMutation[]>("readonly", (s) => s.getAll() as IDBRequest<QueuedMutation[]>);
  return (all ?? []).sort((a, b) => a.queued_at - b.queued_at);
}

export async function idbCount(): Promise<number> {
  return tx<number>("readonly", (s) => s.count());
}
