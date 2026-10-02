"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n";
import { canQueueOffline, isOnline, prepareMutation } from "@/lib/offline/capture";
import { enqueue } from "@/lib/offline/queue";
import { buildFormData } from "@/lib/offline/sync";
import type { QueuedMutation } from "@/lib/offline/types";
import { CameraIcon, MicIcon, StopIcon, PinIcon, CheckIcon } from "@/components/ui/icons";
import { Button, buttonVariants } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Fact, FactList } from "@/components/ui/facts";
import { Photo } from "@/components/ui/photo";
import { cn } from "@/components/ui/cn";

const COMMON = ["wont_start", "leak", "noise", "tyre", "hydraulic", "electrical", "other"] as const;
const URGENCIES = ["can_work", "limping", "stopped"] as const;
type Urgency = (typeof URGENCIES)[number];

/**
 * The urgency choice uses the same shape + colour as `UrgencyStatus` (badge.tsx
 * URGENCY_LOOK: dot / triangle / square), so what the driver taps here is what the
 * workshop reads on the list.
 */
const URGENCY_UI: Record<Urgency, { on: string; ink: string }> = {
  can_work: { on: "border-status-ok bg-callout-ok-bg text-callout-ok-ink", ink: "text-status-ok" },
  limping: { on: "border-status-due bg-callout-warn-bg text-callout-warn-ink", ink: "text-status-due" },
  stopped: { on: "border-status-overdue bg-callout-danger-bg text-callout-danger-ink", ink: "text-status-overdue" },
};

function UrgencyGlyph({ value, className }: { value: Urgency; className?: string }) {
  const common = { className: cn("h-4 w-4 shrink-0", className), "aria-hidden": true, viewBox: "0 0 10 10", fill: "currentColor" };
  if (value === "limping") return <svg {...common}><path d="M5 1 9.3 8.6H0.7z" /></svg>;
  if (value === "stopped") return <svg {...common}><rect x="1.2" y="1.2" width="7.6" height="7.6" rx="1.2" /></svg>;
  return <svg {...common}><circle cx="5" cy="5" r="3.4" /></svg>;
}

/** Downscale + JPEG re-encode a photo to keep uploads small on rural signal (§7). */
async function compressImage(file: File, maxDim = 1600, quality = 0.7): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) { bitmap.close(); return file; }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return await new Promise<Blob>((res) => canvas.toBlob((b) => res(b ?? file), "image/jpeg", quality));
  } catch {
    return file;
  }
}

/** One object URL per blob, revoked when the blob changes or the form unmounts. */
function useObjectUrl(blob: Blob | null): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) { setUrl(undefined); return; }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/**
 * Shared fault-report form with common-fault buttons, photo and voice-note capture.
 * Posts multipart through the idempotent sync API; used by the public QR page and the
 * in-app faults page. The public path never touches the DB directly, the endpoint is
 * a service-role route that validates the token server-side. Captures work offline
 * (queued via IndexedDB) and record an optional geolocation when the browser grants it.
 *
 * The machine is never chosen silently: with one machine it is stated as a fact, with
 * several the person picks one (preselected only when the page knows it, from
 * `defaultMachineId`). Send stays disabled until there is a machine and a description.
 *
 * `onDone` (passed by `ReportFaultDialog`) switches the online success from a page
 * navigation to an in-dialog confirmation naming the machine, with the list refreshed
 * underneath. A report queued offline always ends on a confirmation panel instead of
 * an emptied form, which read as "my report vanished".
 */
export function FaultCapture({
  token,
  machines,
  defaultMachineId,
  redirectTo,
  locale,
  variant = "app",
  defaultName,
  onDone,
}: {
  endpoint: string;
  token?: string;
  machines?: { id: string; name: string }[];
  /** Preselect this machine (a machine page, a driver's card, a `?machine=` link). */
  defaultMachineId?: string;
  redirectTo: string;
  locale: Lang;
  variant?: "app" | "public";
  /**
   * The public kiosk's remembered worker name (a cookie on this phone), prefilled into
   * the name field the way the kiosk's reading and fuel forms already are.
   */
  defaultName?: string;
  /** Closes the surrounding dialog. When given, an online report confirms in place. */
  onDone?: () => void;
}) {
  const router = useRouter();
  const initialMachine =
    machines?.length === 1
      ? machines[0].id
      : defaultMachineId && machines?.some((m) => m.id === defaultMachineId)
        ? defaultMachineId
        : "";
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [urgency, setUrgency] = useState<Urgency>("can_work");
  const [machineId, setMachineId] = useState(initialMachine);
  const [photo, setPhoto] = useState<File | null>(null);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);
  const [done, setDone] = useState<null | { kind: "sent" | "queued"; machine: string }>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const pendingRef = useRef<QueuedMutation | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef<HTMLHeadingElement | null>(null);
  // The text a chip last wrote, so a second chip can replace it without ever
  // overwriting something the person typed themselves.
  const autoTextRef = useRef<string | null>(null);
  const voiceUrl = useObjectUrl(voice);
  const photoUrl = useObjectUrl(photo);

  useEffect(() => () => {
    const rec = recorderRef.current;
    if (rec) {
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      rec.stream.getTracks().forEach(track => track.stop());
    }
  }, []);
  useEffect(() => { if (done) doneRef.current?.focus(); }, [done]);

  const isApp = variant === "app";
  const pickMachine = isApp && machines ? machines.length > 1 : false;
  const machineName = (id: string) => machines?.find((m) => m.id === id)?.name ?? "";

  // Permission-gated geolocation (FR-7.2). Silent fallback: if unsupported or denied
  // we simply don't attach a location, the fault still submits normally.
  const captureLocation = () => {
    setGeoDenied(false);
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoDenied(true);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setGeoDenied(true),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  const startRec = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        setVoice(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
        stream.getTracks().forEach((tr) => tr.stop());
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      setError(t("faults.micDenied", locale));
    }
  };
  const stopRec = () => {
    if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
    setRecording(false);
  };

  const removePhoto = () => {
    setPhoto(null);
    // Without this, picking the same photo again fires no change event.
    if (photoInputRef.current) photoInputRef.current.value = "";
  };

  const pickChip = (c: (typeof COMMON)[number]) => {
    setCategory(c);
    const text = t(`faults.common.${c}`, locale);
    const current = description.trim();
    if (!current || current === autoTextRef.current) {
      setDescription(text);
      autoTextRef.current = text;
    }
  };

  const clearForm = () => {
    setDescription("");
    setCategory(null);
    setUrgency("can_work");
    removePhoto();
    setVoice(null);
    setCoords(null);
    setGeoDenied(false);
    autoTextRef.current = null;
    pendingRef.current = null;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!description.trim()) return;
    if (isApp && machines && !machineId) return;
    if (busy || recording) return;
    setBusy(true);

    // Compress up-front so the same bytes are used online or queued offline.
    const compressedPhoto = photo ? await compressImage(photo) : undefined;
    if ((compressedPhoto && (compressedPhoto.size > 6 * 1024 * 1024 ||
      !["image/jpeg", "image/png", "image/webp"].includes(compressedPhoto.type))) ||
      (voice && voice.size > 8 * 1024 * 1024)) {
      setError(t("offline.mediaTooLarge", locale)); setBusy(false); return;
    }
    const name =
      variant === "public"
        ? (document.getElementById("fault-name") as HTMLInputElement | null)?.value ?? ""
        : "";

    // Build the field map once (mirrors the /api/sync + endpoint field names).
    const fields: Record<string, string> = { description: description.trim(), urgency };
    if (category) fields.category = category;
    if (token) fields.token = token;
    if (isApp) fields.machine_id = machineId;
    if (name) fields.name = name;
    if (coords) {
      fields.lat = String(coords.lat);
      fields.lng = String(coords.lng);
    }
    const reportedMachine = isApp ? machineName(machineId) : "";

    let mutation: QueuedMutation;
    try {
      mutation = pendingRef.current && JSON.stringify(pendingRef.current.fields) === JSON.stringify(fields)
        ? { ...pendingRef.current, photo: compressedPhoto, voice: voice ?? undefined }
        : await prepareMutation({
        type: "report_fault",
        scope: variant === "public" ? "public" : "app",
        fields,
        photo: compressedPhoto,
        voice: voice ?? undefined,
      });
      pendingRef.current = mutation;
    } catch {
      setError(t("offline.storageFailed", locale)); setBusy(false); return;
    }
    const queueOffline = async () => {
      try { await enqueue(mutation); }
      catch { setError(t("offline.storageFailed", locale)); setBusy(false); return; }
      clearForm();
      setDone({ kind: "queued", machine: reportedMachine });
      setBusy(false);
    };

    // Offline up-front → queue without hitting the network.
    if (!isOnline() && canQueueOffline()) {
      await queueOffline();
      return;
    }

    let res: Response;
    try {
      res = await fetch("/api/sync", { method: "POST", body: buildFormData(mutation) });
    } catch {
      // Network dropped mid-send → queue for later if we can.
      if (canQueueOffline()) {
        await queueOffline();
        return;
      }
      setError(t("faults.error", locale));
      setBusy(false);
      return;
    }
    const body = await res.json().catch(() => null) as { status?: string } | null;
    if (res.ok && body?.status === "applied") {
      pendingRef.current = null;
      if (onDone) {
        clearForm();
        setDone({ kind: "sent", machine: reportedMachine });
        setBusy(false);
        // The list behind the dialog picks up the new report; the dialog keeps its state.
        router.refresh();
        return;
      }
      window.location.href = redirectTo;
      return;
    }
    if ((res.status >= 500 || res.status === 429) && canQueueOffline()) {
      await queueOffline(); return;
    }
    // Server rejected the report (bad input / permission), surface it, don't queue.
    setError(t("faults.error", locale));
    setBusy(false);
  };

  if (done) {
    const sent = done.kind === "sent";
    return (
      <div role="status" className="flex flex-col items-center gap-3 py-4 text-center">
        <span
          className={cn(
            "flex h-16 w-16 items-center justify-center rounded-full text-3xl",
            sent ? "bg-callout-ok-bg text-status-ok" : "bg-callout-warn-bg text-status-due",
          )}
          aria-hidden
        >
          <CheckIcon />
        </span>
        <h3 ref={doneRef} tabIndex={-1} className="text-lg font-semibold text-sand-900 focus:outline-none">
          {sent ? t("faults.sentTitle", locale) : t("offline.savedOnPhone", locale)}
        </h3>
        <p className="max-w-sm text-sm text-sand-600">
          {sent
            ? t("faults.sentBody", locale).replace("{machine}", done.machine || "-")
            : t("faults.queuedBody", locale)}
        </p>
        {!sent ? (
          <Link className="focus-ring inline-flex min-h-[48px] items-center rounded px-2 text-sm font-medium text-brand-ink underline" href="/queue">
            {t("offline.review", locale)}
          </Link>
        ) : null}
        <div className="mt-2 flex w-full flex-col gap-2">
          {onDone ? (
            <Button type="button" variant="primary" size="lg" fullWidth onClick={onDone}>
              {t("onboarding.done", locale)}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="lg" fullWidth onClick={() => setDone(null)}>
            {t("faults.reportAnother", locale)}
          </Button>
        </div>
      </div>
    );
  }

  const extraButton = "focus-ring flex min-h-[64px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border px-1.5 py-2 text-center text-sm font-medium leading-tight";
  const idle = "border-sand-300 text-sand-700 hover:bg-sand-50";
  const added = "border-brand-600 bg-brand-tint text-brand-ink";
  const canSend = !busy && !!description.trim() && (!isApp || !machines || !!machineId);

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {isApp && machines ? (
        pickMachine ? (
          <Field label={t("faults.machine", locale)} htmlFor="fault-machine" required>
            <Select id="fault-machine" value={machineId} onChange={(e) => setMachineId(e.target.value)} required>
              <option value="" disabled>{t("driver.whichMachine", locale)}</option>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </Select>
          </Field>
        ) : machines.length === 1 ? (
          <FactList className="-my-2">
            <Fact label={t("faults.machine", locale)} value={machines[0].name} />
          </FactList>
        ) : null
      ) : null}

      {/* How bad: the field the workshop triages on, so it is three big visible
          choices rather than an unlabelled dropdown nobody opened. */}
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-sand-800">{t("faults.howBad", locale)}</legend>
        <div className="grid grid-cols-3 gap-2">
          {URGENCIES.map((u) => {
            const on = urgency === u;
            return (
              <label key={u} className="relative min-w-0 cursor-pointer">
                <input
                  type="radio"
                  name="urgency"
                  value={u}
                  checked={on}
                  onChange={() => setUrgency(u)}
                  className="peer sr-only"
                />
                <span
                  className={cn(
                    "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-lg border-2 px-1 py-2 text-center text-sm font-medium leading-tight",
                    "peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600 peer-focus-visible:ring-offset-2",
                    on ? URGENCY_UI[u].on : "border-sand-200 text-sand-700",
                  )}
                >
                  <UrgencyGlyph value={u} className={URGENCY_UI[u].ink} />
                  <span className="min-w-0 break-words">{t(`urgency.${u}`, locale)}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div>
        <p className="mb-1.5 text-sm font-medium text-sand-800">{t("faults.quickTags", locale)}</p>
        <div className="flex flex-wrap gap-2">
          {COMMON.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => pickChip(c)}
              className={`focus-ring min-h-[48px] rounded-full border px-3 text-sm ${category === c ? "border-brand-600 bg-brand-tint text-brand-ink" : "border-sand-300 text-sand-700"}`}
            >
              {t(`faults.common.${c}`, locale)}
            </button>
          ))}
        </div>
      </div>

      <Field label={t("faults.whatWrong", locale)} htmlFor="fault-description" required>
        <Textarea
          id="fault-description"
          name="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          maxLength={2000}
          rows={2}
        />
      </Field>

      {variant === "public" ? (
        <Field
          label={`${t("faults.yourName", locale)} (${t("faults.optional", locale)})`}
          htmlFor="fault-name"
          // Says where a prefilled name came from, so a borrowed phone is corrected
          // rather than credited to the wrong person.
          hint={defaultName ? t("qr.yourNameRemembered", locale) : undefined}
        >
          <Input id="fault-name" name="name" autoComplete="name" maxLength={200} defaultValue={defaultName} />
        </Field>
      ) : null}

      {/* Photo, voice note and location share one row: three optional extras used
          to take three full-width rows and pushed Send off the screen. */}
      <div>
        <p className="mb-1.5 text-sm font-medium text-sand-800">{t("faults.extras", locale)}</p>
        <div className="grid grid-cols-3 gap-2">
          <label className={cn(extraButton, "focus-within:ring-2 focus-within:ring-brand-600", photo ? added : idle)}>
            <span className="text-xl" aria-hidden>{photo ? <CheckIcon /> : <CameraIcon />}</span>
            <span className="min-w-0 break-words">{photo ? t("faults.photoAdded", locale) : t("faults.addPhoto", locale)}</span>
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            />
          </label>
          {!recording ? (
            <button type="button" onClick={startRec} className={cn(extraButton, voice ? added : idle)}>
              <span className="text-xl" aria-hidden><MicIcon /></span>
              <span className="min-w-0 break-words">{voice ? t("faults.reRecord", locale) : t("faults.record", locale)}</span>
            </button>
          ) : (
            <button type="button" onClick={stopRec} className={cn(extraButton, "border-status-overdue bg-callout-danger-bg text-status-overdue")}>
              <span className="text-xl" aria-hidden><StopIcon /></span>
              <span className="min-w-0 break-words">{t("faults.recording", locale)}</span>
            </button>
          )}
          <button
            type="button"
            onClick={captureLocation}
            className={cn(
              extraButton,
              coords ? added : idle,
              // A stopped machine is the one the mechanic has to drive out to.
              !coords && urgency === "stopped" && "border-2 border-status-overdue",
            )}
          >
            <span className="text-xl" aria-hidden>{coords ? <CheckIcon /> : <PinIcon />}</span>
            <span className="min-w-0 break-words">{coords ? t("faults.locationAdded", locale) : t("faults.addLocation", locale)}</span>
          </button>
        </div>

        {photoUrl || (voice && !recording) || geoDenied ? (
          <div className="mt-3 flex flex-col gap-2">
            {photoUrl ? (
              <div className="flex items-center gap-3">
                <Photo
                  src={photoUrl}
                  alt={t("faults.photoAdded", locale)}
                  size="thumb"
                  priority
                  className="h-16 w-16 shrink-0 rounded-lg ring-1 ring-sand-200"
                />
                <button type="button" onClick={removePhoto} className="focus-ring min-h-[48px] rounded-lg px-3 text-sm font-medium text-status-overdue hover:bg-sand-50">
                  {t("faults.remove", locale)}
                </button>
              </div>
            ) : null}
            {voice && !recording ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <audio controls src={voiceUrl} className="h-10 min-w-0 max-w-[220px]" aria-label={t("faults.playVoiceNote", locale)} />
                <button type="button" onClick={() => setVoice(null)} className="focus-ring min-h-[48px] rounded-lg px-3 text-sm font-medium text-status-overdue hover:bg-sand-50">
                  {t("faults.remove", locale)}
                </button>
              </div>
            ) : null}
            {geoDenied && !coords ? <p className="text-sm text-sand-500">{t("faults.locationDenied", locale)}</p> : null}
          </div>
        ) : null}
      </div>

      {/* In a dialog Send is pinned to the bottom edge, like `DialogActions`, so it is
          on screen on a short phone without scrolling past the extras first. */}
      <div
        className={cn(
          "flex flex-col gap-2",
          isApp && "sticky bottom-0 z-10 -mx-5 -mb-4 border-t border-sand-100 bg-surface px-5 py-3",
        )}
      >
        {error ? <p className="text-sm text-status-overdue" role="alert">{error}</p> : null}
        <button
          type="submit"
          disabled={!canSend}
          className={buttonVariants({ variant: "primary", size: "lg", fullWidth: true })}
        >
          {busy ? t("faults.sending", locale) : t("faults.send", locale)}
        </button>
      </div>
    </form>
  );
}
