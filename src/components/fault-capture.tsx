"use client";

import { useRef, useState } from "react";
import { t, type Locale } from "@/lib/i18n";
import { canQueueOffline, isOnline, queueMutation } from "@/lib/offline/capture";

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
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((res) => canvas.toBlob((b) => res(b ?? file), "image/jpeg", quality));
  } catch {
    return file;
  }
}

/**
 * Shared fault-report form with common-fault buttons, photo and voice-note capture.
 * Posts multipart to `endpoint`; used by the public QR page (token, no login) and the
 * in-app faults page. The public path never touches the DB directly — the endpoint is
 * a service-role route that validates the token server-side.
 */
export function FaultCapture({
  endpoint,
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
  locale: Locale;
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
  const [queued, setQueued] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);

  const startRec = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        setVoice(new Blob(chunksRef.current, { type: "audio/webm" }));
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
    recorderRef.current?.stop();
    setRecording(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!description.trim()) return;
    setBusy(true);

    // Compress up-front so the same bytes are used online or queued offline.
    const compressedPhoto = photo ? await compressImage(photo) : undefined;
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

    const queueOffline = async () => {
      await queueMutation({
        type: "report_fault",
        scope: variant === "public" ? "public" : "app",
        fields,
        photo: compressedPhoto,
        voice: voice ?? undefined,
      });
      // Optimistic confirm: reset the form, show "saved offline".
      setDescription("");
      setCategory(null);
      setUrgency("can_work");
      setPhoto(null);
      setVoice(null);
      setQueued(true);
      setBusy(false);
    };

    // Offline up-front → queue without hitting the network.
    if (!isOnline() && canQueueOffline()) {
      await queueOffline();
      return;
    }

    const fd = new FormData();
    fd.set("description", fields.description);
    fd.set("urgency", urgency);
    if (fields.category) fd.set("category", fields.category);
    if (token) fd.set("token", token);
    if (variant === "app") fd.set("machine_id", machineId);
    if (name) fd.set("name", name);
    if (compressedPhoto) fd.set("photo", compressedPhoto, "photo.jpg");
    if (voice) fd.set("voice", voice, "voice.webm");

    let res: Response;
    try {
      res = await fetch(endpoint, { method: "POST", body: fd });
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
    if (res.ok) {
      window.location.href = redirectTo;
      return;
    }
    // Server rejected the report (bad input / permission) — surface it, don't queue.
    setError(t("faults.error", locale));
    setBusy(false);
  };

  const input = "w-full rounded-lg border border-sand-300 px-3 py-2.5 text-base";
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
              className={`focus-ring min-h-[44px] rounded-full border px-3 text-sm ${category === c ? "border-brand-600 bg-brand-50 text-brand-700" : "border-sand-300 text-sand-700"}`}
            >
              {t(`faults.common.${c}`, locale)}
            </button>
          ))}
        </div>
      </div>

      <textarea value={description} onChange={(e) => setDescription(e.target.value)} required rows={3} placeholder={t("faults.whatWrong", locale)} className={input} />

      <select value={urgency} onChange={(e) => setUrgency(e.target.value)} className={input} aria-label={t("faults.urgency", locale)}>
        {URGENCIES.map((u) => (
          <option key={u} value={u}>{t(`urgency.${u}`, locale)}</option>
        ))}
      </select>

      {variant === "public" ? (
        <input id="fault-name" placeholder={`${t("faults.yourName", locale)} (${t("faults.optional", locale)})`} className={input} />
      ) : null}

      {/* Photo */}
      <div className="flex items-center gap-3">
        <label className="focus-ring inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700">
          📷 {t("faults.addPhoto", locale)}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        {photo ? <span className="truncate text-sm text-sand-500">{photo.name}</span> : null}
      </div>

      {/* Voice note */}
      <div className="flex flex-wrap items-center gap-3">
        {!recording ? (
          <button type="button" onClick={startRec} className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700">
            🎤 {voice ? t("faults.reRecord", locale) : t("faults.record", locale)}
          </button>
        ) : (
          <button type="button" onClick={stopRec} className="focus-ring inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-status-overdue bg-red-50 px-4 text-sm font-medium text-status-overdue">
            ⏹ {t("faults.recording", locale)}
          </button>
        )}
        {voice && !recording ? (
          <span className="flex items-center gap-2">
            <audio controls src={URL.createObjectURL(voice)} className="h-9 max-w-[180px]" />
            <button type="button" onClick={() => setVoice(null)} className="text-sm text-status-overdue">{t("faults.remove", locale)}</button>
          </span>
        ) : null}
      </div>

      {queued ? <p className="text-sm font-medium text-status-due" role="status">✓ {t("offline.savedOffline", locale)}</p> : null}
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
