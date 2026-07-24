"use client";

import { useState } from "react";
import { compressImage, blobToDataUrl } from "@/lib/image-compress";
import { t, type Locale } from "@/lib/i18n";

/**
 * Add-vehicle primary-photo picker. The machine's storage path only exists after
 * insert, so we compress the chosen image client-side and ferry it to the
 * `createMachine` server action as a base64 `data:` URL in a hidden field; the action
 * uploads it and marks it primary. Keeps the add flow one submit.
 */
export function MachinePhotoNew({ locale = "en" }: { locale?: Locale }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const blob = await compressImage(file);
      const url = await blobToDataUrl(blob);
      setDataUrl(url);
      setPreview(url);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("machine.uploadFailed", locale));
      setDataUrl("");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setDataUrl("");
    setPreview(null);
    setErr(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name="primary_photo_data" value={dataUrl} />
      {preview ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt={t("machines.primaryPhoto", locale)} className="h-20 w-20 rounded-lg object-cover ring-1 ring-sand-200" />
          <button type="button" onClick={clear} className="focus-ring rounded-lg border border-sand-300 px-3 py-1.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
            {t("machines.removePhoto", locale)}
          </button>
        </div>
      ) : (
        <label className="focus-ring inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border border-sand-300 px-3 py-1.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
          {busy ? t("machine.uploading", locale) : t("machines.choosePhoto", locale)}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile} disabled={busy} />
        </label>
      )}
      {err ? <p className="text-sm text-status-overdue">{err}</p> : null}
    </div>
  );
}
