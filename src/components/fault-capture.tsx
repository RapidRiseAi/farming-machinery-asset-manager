"use client";

import { useEffect, useRef, useState } from "react";
import { t, type Locale, type Lang } from "@/lib/i18n";
import { canQueueOffline, isOnline, prepareMutation } from "@/lib/offline/capture";
import { enqueue } from "@/lib/offline/queue";
import { buildFormData } from "@/lib/offline/sync";
import type { QueuedMutation } from "@/lib/offline/types";
import Link from "next/link";
import { CameraIcon, MicIcon, StopIcon, PinIcon, CheckIcon } from "@/components/ui/icons";

const COMMON = ["wont_start", "leak", "noise", "tyre", "hydraulic", "electrical", "other"] as const;
const URGENCIES = ["can_work", "limping", "stopped"] as const;

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

/**
 * Shared fault-report form with common-fault buttons, photo and voice-note capture.
 * Posts multipart through the idempotent sync API; used by the public QR page and the
 * in-app faults page. The public path never touches the DB directly — the endpoint is
 * a service-role route that validates the token server-side. Captures work offline
 * (queued via IndexedDB) and record an optional geolocation when the browser grants it.
 */
export function FaultCapture({
  token,
  machines,
  redirectTo,
  locale,
  variant = "app",
}: {
  endpoint: string;
  token?: string;
  machines?: { id: string; name: string }[];
  redirectTo: string;
  locale: Lang;
  variant?: "app" | "public";
}) {
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [urgency, setUrgency] = useState<string>("can_work");
  const [machineId, setMachineId] = useState(machines?.[0]?.id ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [voice, setVoice] = useState<Blob | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoDenied, setGeoDenied] = useState(false);
  const [queued, setQueued] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const pendingRef = useRef<QueuedMutation | null>(null);
  const [voiceUrl, setVoiceUrl] = useState<string>();
  useEffect(() => {
    if (!voice) { setVoiceUrl(undefined); return; }
    const url = URL.createObjectURL(voice); setVoiceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [voice]);
  useEffect(() => () => {
    const rec = recorderRef.current;
    if (rec) {
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      rec.stream.getTracks().forEach(track => track.stop());
    }
  }, []);

  // Permission-gated geolocation (FR-7.2). Silent fallback: if unsupported or denied
  // we simply don't attach a location — the fault still submits normally.
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!description.trim()) return;
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
    if (variant === "app") fields.machine_id = machineId;
    if (name) fields.name = name;
    if (coords) {
      fields.lat = String(coords.lat);
      fields.lng = String(coords.lng);
    }

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
      // Optimistic confirm: reset the form, show "saved offline".
      setDescription("");
      setCategory(null);
      setUrgency("can_work");
      setPhoto(null);
      setVoice(null);
      setCoords(null);
      setQueued(true);
      setBusy(false);
      pendingRef.current = null;
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
      window.location.href = redirectTo;
      return;
    }
    if ((res.status >= 500 || res.status === 429) && canQueueOffline()) {
      await queueOffline(); return;
    }
    // Server rejected the report (bad input / permission) — surface it, don't queue.
    setError(t("faults.error", locale));
    setBusy(false);
  };

  const input = "w-full min-h-[48px] rounded-lg border border-sand-300 px-3 py-2.5 text-base";
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {variant === "app" && machines ? (
        <select value={machineId} onChange={(e) => setMachineId(e.target.value)} required className={input} aria-label={t("faults.machine", locale)}>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </select>
      ) : null}

      <div>
        <p className="mb-1.5 text-sm font-medium text-sand-700">{t("faults.quickTags", locale)}</p>
        <div className="flex flex-wrap gap-2">
          {COMMON.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setCategory(c); if (!description.trim()) setDescription(t(`faults.common.${c}`, locale)); }}
              className={`focus-ring min-h-[48px] rounded-full border px-3 text-sm ${category === c ? "border-brand-600 bg-brand-tint text-brand-ink" : "border-sand-300 text-sand-700"}`}
            >
              {t(`faults.common.${c}`, locale)}
            </button>
          ))}
        </div>
      </div>

      <label className="text-sm font-medium" htmlFor="fault-description">{t("faults.whatWrong", locale)}</label>
      <textarea id="fault-description" name="description" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={2000} rows={3} className={input} />

      <select value={urgency} onChange={(e) => setUrgency(e.target.value)} className={input} aria-label={t("faults.urgency", locale)}>
        {URGENCIES.map((u) => (
          <option key={u} value={u}>{t(`urgency.${u}`, locale)}</option>
        ))}
      </select>

      {variant === "public" ? (
        <label className="text-sm">{t("faults.yourName", locale)} ({t("faults.optional", locale)})
          <input id="fault-name" name="name" autoComplete="name" maxLength={200} className={input} />
        </label>
      ) : null}

      {/* Photo */}
      <div className="flex items-center gap-3">
        <label className="focus-ring inline-flex min-h-[48px] cursor-pointer items-center gap-2 rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700">
          <CameraIcon />
          {t("faults.addPhoto", locale)}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        {photo ? <span className="truncate text-sm text-sand-500">{photo.name}</span> : null}
      </div>

      {/* Voice note */}
      <div className="flex flex-wrap items-center gap-3">
        {!recording ? (
          <button type="button" onClick={startRec} className="focus-ring inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700">
            <MicIcon />{" "}
            {voice ? t("faults.reRecord", locale) : t("faults.record", locale)}
          </button>
        ) : (
          <button type="button" onClick={stopRec} className="focus-ring inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-status-overdue bg-callout-danger-bg px-4 text-sm font-medium text-status-overdue">
            <StopIcon />{" "}
            {t("faults.recording", locale)}
          </button>
        )}
        {voice && !recording ? (
          <span className="flex items-center gap-2">
            <audio controls src={voiceUrl} className="h-9 max-w-[180px]" aria-label={t("faults.playVoiceNote", locale)} />
            <button type="button" onClick={() => setVoice(null)} className="text-sm text-status-overdue">{t("faults.remove", locale)}</button>
          </span>
        ) : null}
      </div>

      {/* Location (permission-gated, silent fallback) */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={captureLocation} className="focus-ring inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700">
          <PinIcon />{" "}
          {coords ? t("faults.locationAdded", locale) : t("faults.addLocation", locale)}
        </button>
        {coords ? (
          <span className="text-sm tabular-nums text-sand-500">{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</span>
        ) : geoDenied ? (
          <span className="text-sm text-sand-400">{t("faults.locationDenied", locale)}</span>
        ) : null}
      </div>

      {queued ? <p className="text-sm font-medium text-status-due" role="status"><CheckIcon /> {t("offline.savedOffline", locale)} <Link className="focus-ring underline" href="/queue">{t("offline.review", locale)}</Link></p> : null}
      {error ? <p className="text-sm text-status-overdue" role="alert">{error}</p> : null}

      <button
        type="submit"
        disabled={busy || !description.trim()}
        className="focus-ring min-h-[48px] rounded-lg bg-brand-600 px-4 text-base font-semibold text-white disabled:opacity-60"
      >
        {busy ? t("faults.sending", locale) : t("faults.send", locale)}
      </button>
    </form>
  );
}
