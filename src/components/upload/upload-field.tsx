"use client";

import { useEffect, useId, useRef, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { UploadTarget, UploadOutcome } from "@/lib/upload/client";
import { useDirectUpload, type DirectUploadState } from "./use-direct-upload";

export type UploadAccept = "photo" | "document" | "voice";

const ACCEPT: Record<UploadAccept, string> = {
  photo: "image/*",
  document: "image/*,application/pdf",
  voice: "audio/*",
};

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;
}

/**
 * The reusable upload control (BRIEF section 10): choose a file, see it reduced (a photo,
 * unless "Keep the original" is ticked), watch it send with a percentage, pause and carry
 * on, try again after a dropped connection, and read a plain sentence when it is refused.
 * The chosen file and the rest of the form stay as they were on every failure.
 *
 * `finish="generic"` saves an ordinary attachment itself once the file is checked;
 * `finish="caller"` puts the upload's id in a hidden field named `name`, for the form's own
 * route to judge and save with its record (a job card's invoice, a supplier document).
 * While a file is still on its way the wrapper carries `data-upload-pending`, and
 * `onStateChange` tells the form, so it can hold its submit.
 */
export function UploadField({
  locale, label, accept, target, finish, scope, name = "upload_intent_id", attachmentKind, uploadLabel,
  capture, onDone, onStateChange, className, disabled, file,
}: {
  locale: Lang;
  label?: string;
  accept: UploadAccept;
  target: UploadTarget | null;
  finish: "generic" | "caller";
  scope: string;
  name?: string;
  attachmentKind?: "photo" | "voice" | "doc" | "invoice";
  /** The word in the stored name (photo, quote, invoice, document, receipt, proof, voice). */
  uploadLabel: string;
  capture?: boolean;
  onDone?: (outcome: Extract<UploadOutcome, { ok: true }>) => void;
  onStateChange?: (state: DirectUploadState) => void;
  className?: string;
  disabled?: boolean;
  /** A locally recorded file uses the identical upload, retry and validation path. */
  file?: File;
}) {
  const inputId = useId();
  const keepId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [keepOriginal, setKeepOriginal] = useState(false);
  const upload = useDirectUpload({ target, label: uploadLabel, finish, attachmentKind, scope, onDone });
  const { start } = upload;
  useEffect(() => { if (file) void start(file); }, [file, start]);
  const { state } = upload;
  const lastReported = useRef<DirectUploadState | null>(null);
  if (onStateChange && lastReported.current !== state) {
    lastReported.current = state;
    queueMicrotask(() => onStateChange(state));
  }

  const percent = state.total > 0 ? Math.min(100, Math.round((state.sent / state.total) * 100)) : 0;
  const status = (() => {
    switch (state.phase) {
      case "preparing": return t("upload.preparing", locale);
      case "starting": return t("upload.starting", locale);
      case "sending": return t("upload.sending", locale).replace("{percent}", String(percent));
      case "checking": return t("upload.checking", locale);
      case "paused": return t("upload.paused", locale).replace("{percent}", String(percent));
      case "done": return t("upload.done", locale);
      default: return null;
    }
  })();
  const prepared = state.prepared;
  const note = prepared?.reduced && prepared.original.width && prepared.stored.width
    ? t("upload.reducedNote", locale).replace("{from}", String(prepared.original.width)).replace("{to}", String(prepared.stored.width))
    : prepared && accept === "photo" && prepared.kept === "asked" ? t("upload.keptNote", locale) : null;

  const choose = (file: File | undefined) => {
    if (!file) return;
    void upload.start(file, keepOriginal);
  };

  return (
    <div className={cn("flex flex-col gap-2", className)} data-upload-pending={upload.busy || state.phase === "paused" ? "1" : undefined}>
      {finish === "caller" && state.phase === "done" && state.intentId ? (
        <input type="hidden" name={name} value={state.intentId} />
      ) : null}
      {label ? <label htmlFor={inputId} className="text-sm font-medium text-sand-800">{label}</label> : null}
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={ACCEPT[accept]}
        capture={capture ? "environment" : undefined}
        disabled={disabled || upload.busy || !target}
        onChange={(event) => {
          choose(event.target.files?.[0]);
          event.target.value = "";
        }}
        className="block w-full text-sm text-sand-600 file:mr-3 file:min-h-[44px] file:rounded-lg file:border-0 file:bg-sand-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-sand-700"
      />
      {accept !== "voice" ? (
        <div className="flex items-start gap-2">
          <input
            id={keepId}
            type="checkbox"
            checked={keepOriginal}
            disabled={upload.busy}
            onChange={(event) => setKeepOriginal(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-sand-300"
          />
          <label htmlFor={keepId} className="text-sm text-sand-700">
            {t("upload.keepOriginal", locale)}
            <span className="block text-xs text-sand-500">{t("upload.keepOriginalHint", locale)}</span>
          </label>
        </div>
      ) : null}
      {state.file ? (
        <p className="text-xs text-sand-600">
          {t("upload.selected", locale).replace("{name}", state.file.name).replace("{size}", size(state.prepared?.file.size ?? state.file.size))}
        </p>
      ) : null}
      {note ? <p className="text-xs text-sand-500">{note}</p> : null}
      {status ? (
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-sand-100"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={status}
          >
            <div className={cn("h-full rounded-full", state.phase === "done" ? "bg-status-ok" : "bg-brand-600")} style={{ width: `${state.phase === "done" ? 100 : percent}%` }} />
          </div>
          <p className="text-sm text-sand-700">{status}</p>
        </div>
      ) : null}
      {state.phase === "failed" && state.code ? (
        <p role="alert" className="text-sm text-status-overdue">{errorMessage(state.code, locale)}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {state.phase === "sending" ? (
          <Button type="button" variant="secondary" size="sm" onClick={upload.pause}>{t("upload.pause", locale)}</Button>
        ) : null}
        {state.phase === "paused" ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => void upload.resume()}>{t("upload.resume", locale)}</Button>
        ) : null}
        {state.phase === "failed" && state.code !== "upload-wrong-type" && state.code !== "upload-too-large" ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => void upload.retry()}>{t("upload.retry", locale)}</Button>
        ) : null}
        {state.phase !== "idle" && !upload.busy ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => { upload.reset(); if (inputRef.current) inputRef.current.value = ""; }}>
            {t("upload.remove", locale)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
