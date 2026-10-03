"use client";

import { preferredMimeType, recordingToWav } from "./offline-voice";

/**
 * Records the very stream Azure is transcribing live, so the same words can be heard a
 * second time: by the other fixed-language recogniser, or by the AI transcribers. One
 * microphone, never two: a second getUserMedia call can mute the first on iOS.
 *
 * The clip lives only in memory and is dropped after the turn.
 */
export class ClipRecorder {
  private readonly chunks: Blob[] = [];
  private stopped: Promise<Blob | null> | null = null;

  private constructor(private readonly recorder: MediaRecorder) {}

  /** Null where recording is unavailable; the live transcript then stands alone, as before. */
  static start(stream: MediaStream): ClipRecorder | null {
    if (typeof MediaRecorder === "undefined") return null;
    try {
      const mimeType = preferredMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const clip = new ClipRecorder(recorder);
      recorder.ondataavailable = (event) => {
        if (event.data.size) clip.chunks.push(event.data);
      };
      recorder.start(250);
      return clip;
    } catch {
      return null;
    }
  }

  /** Stops recording now (the microphone is about to close); decoding waits for `wav()`. */
  finish(): void {
    void this.ended();
  }

  /** The clip as 16 kHz mono WAV, or null if nothing usable was captured. Decoded on demand. */
  async wav(): Promise<File | null> {
    const blob = await this.ended();
    if (!blob || blob.size < 1_000) return null;
    try {
      return await recordingToWav(blob, "clip.wav");
    } catch {
      return null;
    }
  }

  private ended(): Promise<Blob | null> {
    if (!this.stopped) {
      this.stopped = new Promise<Blob | null>((resolve) => {
        const finish = () => {
          const type = this.recorder.mimeType || this.chunks[0]?.type || "audio/webm";
          resolve(this.chunks.length ? new Blob(this.chunks, { type }) : null);
        };
        if (this.recorder.state === "inactive") return finish();
        this.recorder.onstop = finish;
        this.recorder.onerror = () => resolve(null);
        try {
          this.recorder.stop();
        } catch {
          resolve(null);
        }
      });
    }
    return this.stopped;
  }

  cancel(): void {
    this.chunks.length = 0;
    if (this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // Already stopped.
      }
    }
  }
}
