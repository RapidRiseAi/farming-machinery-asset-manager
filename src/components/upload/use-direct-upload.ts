"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mediaClassOf, type MediaClass } from "@/lib/limits";
import { preparePhoto, type PreparedFile } from "@/lib/upload/compress";
import { stableRequestId, uploadFile, type UploadOutcome, type UploadTarget } from "@/lib/upload/client";
import type { UploadCode } from "@/lib/upload/protocol";

export type DirectUploadPhase = "idle" | "preparing" | "starting" | "sending" | "checking" | "done" | "paused" | "failed";

export type DirectUploadState = {
  phase: DirectUploadPhase;
  sent: number;
  total: number;
  code: UploadCode | null;
  intentId: string | null;
  recordId: string | null;
  prepared: PreparedFile | null;
  file: File | null;
};

const IDLE: DirectUploadState = { phase: "idle", sent: 0, total: 0, code: null, intentId: null, recordId: null, prepared: null, file: null };

export type DirectUploadOptions = {
  target: UploadTarget | null;
  label: string;
  finish: "generic" | "caller";
  attachmentKind?: "photo" | "voice" | "doc" | "invoice";
  /** Makes the request id: the same scope and file is the same upload (retries, reloads, offline replays). */
  scope: string;
  purpose?: "attachment" | "command_audio";
  onDone?: (outcome: Extract<UploadOutcome, { ok: true }>) => void;
};

/**
 * One file's way through the direct upload pipeline, for a form: reduce a photo (unless
 * the original is kept), begin, send with progress, pause and carry on, try again after a
 * failure with the same request id (so nothing is stored twice), and keep the chosen file
 * and the reason when it is refused, so the form never loses it.
 */
export function useDirectUpload(options: DirectUploadOptions) {
  const [state, setState] = useState<DirectUploadState>(IDLE);
  const controller = useRef<AbortController | null>(null);
  const current = useRef<{ file: File; prepared: PreparedFile; requestId: string; mediaClass: MediaClass } | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => () => controller.current?.abort(), []);

  const send = useCallback(async () => {
    const job = current.current;
    const target = optionsRef.current.target;
    if (!job || !target) return null;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const outcome = await uploadFile({
      file: job.prepared.file,
      mime: job.prepared.mime,
      mediaClass: job.mediaClass,
      target,
      label: optionsRef.current.label,
      requestId: job.requestId,
      finish: optionsRef.current.finish,
      attachmentKind: optionsRef.current.attachmentKind,
      signal: abort.signal,
      onProgress: (progress) => {
        if (abort.signal.aborted && progress.phase !== "paused") return;
        setState((s) => ({ ...s, phase: progress.phase === "failed" ? s.phase : progress.phase, sent: progress.sent, total: progress.total }));
      },
    });
    if (controller.current === abort) controller.current = null;
    if (outcome.ok) {
      setState((s) => ({ ...s, phase: "done", code: null, intentId: outcome.intentId, recordId: outcome.recordId, sent: s.total }));
      optionsRef.current.onDone?.(outcome);
    } else if (outcome.code === "paused") {
      setState((s) => ({ ...s, phase: "paused", intentId: outcome.intentId ?? s.intentId }));
    } else {
      setState((s) => ({ ...s, phase: "failed", code: outcome.code as UploadCode, intentId: outcome.intentId ?? s.intentId }));
    }
    return outcome;
  }, []);

  /** Starts with a chosen file. A photo is reduced first unless `keepOriginal`. */
  const start = useCallback(async (file: File, keepOriginal = false) => {
    controller.current?.abort();
    setState({ ...IDLE, phase: "preparing", file });
    const declared = mediaClassOf(file.type || "", optionsRef.current.purpose ?? "attachment");
    const prepared = declared === "photo" ? await preparePhoto(file, keepOriginal) : {
      file, mime: (file.type || "").toLowerCase(), reduced: false, kept: "not_a_photo" as const,
      original: { width: null, height: null, bytes: file.size }, stored: { width: null, height: null, bytes: file.size },
    };
    const mediaClass = mediaClassOf(prepared.mime, optionsRef.current.purpose ?? "attachment");
    if (!mediaClass) {
      setState((s) => ({ ...s, phase: "failed", code: "upload-wrong-type", prepared }));
      return null;
    }
    const requestId = await stableRequestId(`${optionsRef.current.scope}|${keepOriginal ? "original" : "reduced"}`, file);
    current.current = { file, prepared, requestId, mediaClass };
    setState((s) => ({ ...s, prepared, total: prepared.file.size }));
    return send();
  }, [send]);

  const pause = useCallback(() => controller.current?.abort(), []);
  const resume = useCallback(() => send(), [send]);
  const reset = useCallback(() => {
    controller.current?.abort();
    current.current = null;
    setState(IDLE);
  }, []);

  const busy = ["preparing", "starting", "sending", "checking"].includes(state.phase);
  return { state, start, pause, resume, retry: resume, reset, busy };
}
