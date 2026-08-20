"use client";

import type { AssistantLocale } from "@/lib/assistant/types";

const DB_NAME = "fleetwise-voice-assistant";
const DB_VERSION = 1;
const STORE = "captures";
const SIGN_OUT_LOCK = "fleetwise-voice-storage-locked";
export const OFFLINE_VOICE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_OFFLINE_RECORDING_MS = 60_000;
const pendingWrites = new Set<Promise<void>>();
let writesBlockedForSignOut = false;

function deviceWritesBlocked(): boolean {
  if (writesBlockedForSignOut) return true;
  try {
    return localStorage.getItem(SIGN_OUT_LOCK) === "1";
  } catch {
    return false;
  }
}

export type OfflineVoiceCapture = {
  id: string;
  contextKey: string;
  locale: AssistantLocale;
  audio: Blob;
  mimeType: string;
  durationMs: number;
  createdAt: number;
};

export function partitionOfflineCaptures(
  captures: OfflineVoiceCapture[],
  contextKey: string,
  now = Date.now(),
): { expiredIds: string[]; visible: OfflineVoiceCapture[] } {
  const cutoff = now - OFFLINE_VOICE_RETENTION_MS;
  const expiredIds: string[] = [];
  const visible: OfflineVoiceCapture[] = [];

  for (const capture of captures) {
    if (capture.createdAt < cutoff) {
      expiredIds.push(capture.id);
    } else if (capture.contextKey === contextKey) {
      visible.push(capture);
    }
  }

  visible.sort((a, b) => a.createdAt - b.createdAt);
  return { expiredIds, visible };
}

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("offline_storage_unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("context_created", ["contextKey", "createdAt"]);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("offline_storage_unavailable"));
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let result!: T;
    let hasResult = false;
    let runError: unknown;
    let settled = false;
    const rejectOnce = (reason: unknown) => {
      if (settled) return;
      settled = true;
      db.close();
      reject(reason);
    };
    tx.oncomplete = () => {
      if (settled) return;
      if (runError !== undefined) {
        rejectOnce(runError);
        return;
      }
      if (!hasResult) {
        rejectOnce(new Error("offline_storage_failed"));
        return;
      }
      settled = true;
      db.close();
      resolve(result);
    };
    tx.onerror = () => rejectOnce(runError ?? tx.error ?? new Error("offline_storage_failed"));
    tx.onabort = () => rejectOnce(runError ?? tx.error ?? new Error("offline_storage_failed"));
    const resolveOnCommit = (value: T) => {
      result = value;
      hasResult = true;
    };
    const abortWith = (reason?: unknown) => {
      runError = reason ?? new Error("offline_storage_failed");
      try {
        tx.abort();
      } catch {
        rejectOnce(runError);
      }
    };
    try {
      run(tx.objectStore(STORE), resolveOnCommit, abortWith);
    } catch (error) {
      abortWith(error);
    }
  });
}

export async function saveOfflineCapture(capture: OfflineVoiceCapture): Promise<void> {
  if (deviceWritesBlocked()) throw new Error("offline_storage_locked");
  const write = transaction<void>("readwrite", (store, resolve, reject) => {
    // Re-check after opening IndexedDB. This closes the cross-tab race where sign-out
    // starts while this tab is waiting for its database connection.
    if (deviceWritesBlocked()) {
      reject(new Error("offline_storage_locked"));
      return;
    }
    const request = store.add(capture);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
  pendingWrites.add(write);
  try {
    await write;
  } finally {
    pendingWrites.delete(write);
  }
}

/** Re-enable storage for a newly mounted, signed-in assistant session. */
export function enableOfflineVoiceStorage(): void {
  writesBlockedForSignOut = false;
  try {
    localStorage.removeItem(SIGN_OUT_LOCK);
  } catch {
    // The in-memory lock still protects this tab when storage access is restricted.
  }
}

export async function deleteOfflineCapture(id: string, contextKey: string): Promise<void> {
  await transaction<void>("readwrite", (store, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => {
      const capture = request.result as Partial<OfflineVoiceCapture> | undefined;
      if (!capture) {
        resolve();
        return;
      }
      if (capture.contextKey !== contextKey) {
        reject(new Error("offline_context_mismatch"));
        return;
      }
      const deletion = store.delete(id);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Delete only recordings belonging to one signed-in user + farm context. */
export async function clearOfflineCaptures(contextKey: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("offline_storage_failed"));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("offline_storage_failed"));
    };
    const store = tx.objectStore(STORE);
    const request = store.openCursor();
    request.onerror = () => reject(request.error ?? new Error("offline_storage_failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const capture = cursor.value as Partial<OfflineVoiceCapture>;
      if (capture.contextKey === contextKey) cursor.delete();
      cursor.continue();
    };
  });
}

/** Clear every locally queued voice recording. Call immediately before sign-out. */
export async function clearAllOfflineVoiceData(): Promise<void> {
  writesBlockedForSignOut = true;
  try {
    localStorage.setItem(SIGN_OUT_LOCK, "1");
  } catch {
    // Continue with IndexedDB deletion; the local in-memory lock still prevents writes.
  }
  await Promise.allSettled([...pendingWrites]);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("offline_storage_failed"));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("offline_storage_failed"));
    };
    tx.objectStore(STORE).clear();
  });
}

export async function listOfflineCaptures(contextKey: string): Promise<OfflineVoiceCapture[]> {
  return transaction<OfflineVoiceCapture[]>("readwrite", (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const { expiredIds, visible } = partitionOfflineCaptures(
        (request.result as OfflineVoiceCapture[]) ?? [],
        contextKey,
      );
      for (const id of expiredIds) {
        const deletion = store.delete(id);
        deletion.onerror = () => reject(deletion.error);
      }
      resolve(visible);
    };
    request.onerror = () => reject(request.error);
  });
}

function preferredMimeType(): string {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? "";
}

/** Short offline recorder. The returned Blob stays only in IndexedDB until transcribed. */
export class OfflineVoiceRecorder {
  private readonly chunks: Blob[] = [];
  private readonly startedAt = Date.now();
  private stopped = false;
  private limitNotified = false;

  private constructor(
    private readonly stream: MediaStream,
    private readonly recorder: MediaRecorder,
    private readonly onLimit?: () => void,
  ) {
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
      if (!this.stopped && !this.limitNotified && Date.now() - this.startedAt >= MAX_OFFLINE_RECORDING_MS) {
        this.limitNotified = true;
        queueMicrotask(() => this.onLimit?.());
      }
    };
  }

  static async start(onLimit?: () => void): Promise<OfflineVoiceRecorder> {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw new Error("offline_recording_unavailable");
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const mimeType = preferredMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const instance = new OfflineVoiceRecorder(stream, recorder, onLimit);
      recorder.start(1000);
      return instance;
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  stop(input: { id: string; contextKey: string; locale: AssistantLocale }): Promise<OfflineVoiceCapture> {
    if (this.stopped) return Promise.reject(new Error("recorder_already_stopped"));
    this.stopped = true;
    return new Promise((resolve, reject) => {
      const finish = () => this.stream.getTracks().forEach((track) => track.stop());
      this.recorder.onerror = () => {
        finish();
        reject(new Error("offline_recording_failed"));
      };
      this.recorder.onstop = () => {
        finish();
        const mimeType = this.recorder.mimeType || this.chunks[0]?.type || "audio/webm";
        const audio = new Blob(this.chunks, { type: mimeType });
        if (audio.size === 0) {
          reject(new Error("offline_recording_empty"));
          return;
        }
        resolve({
          id: input.id,
          contextKey: input.contextKey,
          locale: input.locale,
          audio,
          mimeType,
          durationMs: Math.max(0, Date.now() - this.startedAt),
          createdAt: this.startedAt,
        });
      };
      try {
        this.recorder.stop();
      } catch (error) {
        finish();
        reject(error);
      }
    });
  }

  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.recorder.state !== "inactive") this.recorder.stop();
    } finally {
      this.stream.getTracks().forEach((track) => track.stop());
    }
  }
}

function encodePcmWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const writeText = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return bytes;
}

/** Decode the local MediaRecorder format and resample it to Azure-friendly 16 kHz WAV. */
export async function offlineCaptureToWav(capture: OfflineVoiceCapture): Promise<File> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await capture.audio.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * 16_000));
    const offline = new OfflineAudioContext(1, frames, 16_000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const wav = encodePcmWav(rendered.getChannelData(0), rendered.sampleRate);
    return new File([wav], `${capture.id}.wav`, { type: "audio/wav" });
  } finally {
    await context.close().catch(() => undefined);
  }
}
