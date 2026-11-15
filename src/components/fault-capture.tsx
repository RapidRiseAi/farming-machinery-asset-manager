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
import { fetchWithTimeout } from "@/lib/fetch-timeout";
import { PHOTO_MAX_BYTES, RECORDER_AUDIO_BPS, RECORDING_WARN_BEFORE_MS, VOICE_NOTE_MAX_BYTES, VOICE_NOTE_MAX_MS } from "@/lib/limits";
import { preparePhoto } from "@/lib/upload/compress";
import { sendCaptureMedia } from "@/lib/offline/media";
import { errorMessage } from "@/lib/errors";
import { preferredMimeType } from "@/components/assistant/offline-voice";

/**
 * Longest voice note (decisions 10 and 11): ten minutes, then the recorder stops itself and
 * keeps what it has; it warns shortly before. The bitrate is set, so ten minutes is about
 * 3.6 MB however the browser would have chosen (docs/LIMITS.md).
 */
const VOICE_MAX_MS = VOICE_NOTE_MAX_MS;
const VOICE_BITS_PER_SECOND = RECORDER_AUDIO_BPS;
/** m:ss for the recording timer. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

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
  // Photos are made smaller unless the person keeps the original (decision 13).
  const [keepOriginal, setKeepOriginal] = useState(false);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);
  const [done, setDone] = useState<null | { kind: "sent" | "queued"; machine: string }>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  // Seconds recorded so far, shown on the stop button; the cap stops the recorder by itself.
  const [elapsed, setElapsed] = useState(0);
  // Set when the recorder stopped itself at the limit: what was said is kept, and said so.
  const [stoppedAtLimit, setStoppedAtLimit] = useState(false);
  const recTimersRef = useRef<{ tick?: ReturnType<typeof setInterval>; cap?: ReturnType<typeof setTimeout> }>({});
  const chunksRef = useRef<BlobPart[]>([]);
  const pendingRef = useRef<QueuedMutation | null>(null);
  const qrAttempt = useRef<{key:string;id:string}|null>(null);
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
      // About 0.36 MB a minute: ten minutes is about 3.6 MB, far under the 20 MB a note may be,
      // and it goes straight to Storage, never through a server function. A browser that
      // ignores the hint is still well under (128 kbps is 9.6 MB), and still capped by time.
      let rec: MediaRecorder;
      const mimeType = preferredMimeType();
      try {
        rec = new MediaRecorder(stream, { audioBitsPerSecond: VOICE_BITS_PER_SECOND, ...(mimeType ? { mimeType } : {}) });
      } catch {
        rec = new MediaRecorder(stream);
      }
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        setVoice(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
        stream.getTracks().forEach((tr) => tr.stop());
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setElapsed(0);
      const started = Date.now();
      recTimersRef.current.tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250);
      setStoppedAtLimit(false);
      recTimersRef.current.cap = setTimeout(() => { setStoppedAtLimit(true); stopRec(); }, VOICE_MAX_MS);
    } catch {
      setError(t("faults.micDenied", locale));
    }
  };
  function stopRec() {
    clearInterval(recTimersRef.current.tick);
    clearTimeout(recTimersRef.current.cap);
    recTimersRef.current = {};
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
    setRecording(false);
  }

  // Leaving the screen mid-recording must not keep the microphone open.
  useEffect(() => () => {
    clearInterval(recTimersRef.current.tick);
    clearTimeout(recTimersRef.current.cap);
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      rec.stop();
      rec.stream.getTracks().forEach((tr) => tr.stop());
    }
  }, []);

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

    // Reduce up-front (unless the original is kept) so the same bytes are used online or
    // queued offline. The server judges the real bytes again when they arrive.
    const compressedPhoto = photo ? (await preparePhoto(photo, keepOriginal)).file : undefined;
    if ((compressedPhoto && compressedPhoto.size > PHOTO_MAX_BYTES) || (voice && voice.size > VOICE_NOTE_MAX_BYTES)) {
      setError(errorMessage("upload-too-large", locale) ?? t("offline.mediaTooLarge", locale)); setBusy(false); return;
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

    // QR capture now requires a live farm-member session. Do not queue anonymous drafts.
    if (variant === "public") {
      try {
        const form = new FormData();
        const key=JSON.stringify(fields);
        if(qrAttempt.current?.key!==key) qrAttempt.current={key,id:crypto.randomUUID()};
        form.set("client_id",qrAttempt.current.id);
        Object.entries(fields).forEach(([key,value])=>form.set(key,value));
        // The fault first (a small request), then its files straight to Storage.
        const response = await fetchWithTimeout("/api/public/fault",{method:"POST",body:form});
        const result=await response.json() as { fault_id?: string; farm_id?: string };
        if (!response.ok || !result.fault_id) throw new Error("capture_failed");
        if ((compressedPhoto || voice) && result.farm_id) {
          const media = await sendCaptureMedia({ client_id: qrAttempt.current.id, photo: compressedPhoto, voice: voice ?? undefined },
            { id: result.fault_id, farmId: result.farm_id });
          if (media.state !== "done") {
            // The fault is saved; the form keeps the photo and the note to send again.
            setError(errorMessage(media.state === "refused" ? media.code : "upload-interrupted", locale) ?? t("faults.error", locale));
            setBusy(false);
            return;
          }
        }
        window.location.href=redirectTo;
      } catch { setError(t("faults.error",locale)); setBusy(false); }
      return;
    }

    let mutation: QueuedMutation;
    try {
      mutation = pendingRef.current && JSON.stringify(pendingRef.current.fields) === JSON.stringify(fields)
        ? { ...pendingRef.current, photo: compressedPhoto, voice: voice ?? undefined }
        : await prepareMutation({
        type: "report_fault",
        scope: "app",
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
      res = await fetchWithTimeout("/api/sync", { method: "POST", body: buildFormData(mutation) });
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
    const body = await res.json().catch(() => null) as { status?: string; entity_id?: string; farm_id?: string } | null;
    if (res.ok && body?.status === "applied") {
      // The fault is saved; its photo and voice note follow straight to Storage. A dropped
      // connection leaves them queued on the phone with the saved fault's id; a refusal
      // keeps the form as it is, with the reason, to send again.
      if ((mutation.photo || mutation.voice) && body.entity_id && body.farm_id) {
        const media = await sendCaptureMedia(mutation, { id: body.entity_id, farmId: body.farm_id });
        if (media.state === "transient" && canQueueOffline()) {
          mutation = { ...mutation, entity_id: body.entity_id, farm_id: body.farm_id };
          await queueOffline();
          return;
        }
        if (media.state !== "done") {
          setError(errorMessage(media.state === "refused" ? media.code : "upload-interrupted", locale) ?? t("faults.error", locale));
          setBusy(false);
          return;
        }
      }
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
          label={t("driving.signedInAs", locale)}
          htmlFor="fault-name"
        >
          <Input id="fault-name" name="name" autoComplete="name" maxLength={200} defaultValue={defaultName} readOnly />
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
              <span className="min-w-0 break-words">
                {t("faults.recordingElapsed", locale)
                  .replace("{time}", clock(elapsed))
                  .replace("{max}", clock(VOICE_MAX_MS / 1000))}
              </span>
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

        {recording && elapsed * 1000 >= VOICE_MAX_MS - RECORDING_WARN_BEFORE_MS ? (
          <p role="status" className="mt-2 text-sm font-medium text-status-due">{t("faults.voiceNearLimit", locale)}</p>
        ) : null}
        {stoppedAtLimit && voice && !recording ? (
          <p role="status" className="mt-2 text-sm text-sand-600">{t("faults.voiceStoppedAtLimit", locale)}</p>
        ) : null}
        {photo ? (
          <label className="mt-2 flex items-start gap-2 text-sm text-sand-700">
            <input type="checkbox" checked={keepOriginal} onChange={(e) => setKeepOriginal(e.target.checked)} className="mt-1 h-4 w-4 rounded border-sand-300" />
            <span>{t("upload.keepOriginal", locale)}<span className="block text-xs text-sand-500">{t("upload.keepOriginalHint", locale)}</span></span>
          </label>
        ) : null}

        {/* Said before anyone records: the recording is kept, and the farm hears it. */}
        <p className="mt-2 text-xs text-sand-500">{t("faults.voiceNotice", locale).replace("{max}", clock(VOICE_MAX_MS / 1000))}</p>

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
