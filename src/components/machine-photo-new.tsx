"use client";

import { useState } from "react";
import { Photo } from "@/components/ui/photo";
import { compressImage, blobToDataUrl } from "@/lib/image-compress";
import { t, type Locale, type Lang } from "@/lib/i18n";
import { looksLikeImage, photoUploadErrorKey } from "@/lib/machine-photo-upload-error";

/**
 * Add-vehicle primary-photo picker. The machine's storage path only exists after
 * insert, so we compress the chosen image client-side and ferry it to the
 * `createMachine` server action as a base64 `data:` URL in a hidden field; the action
 * uploads it and marks it primary. Keeps the add flow one submit.
 */
export function MachinePhotoNew({ locale = "en" }: { locale?: Lang }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!looksLikeImage(file)) {
      setErr(t("machine.uploadNotImage", locale));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const blob = await compressImage(file);
      const url = await blobToDataUrl(blob);
      setDataUrl(url);
      setPreview(url);
    } catch (e2) {
      // Compressing happens on the phone, so a failure here is a file it cannot read.
      setErr(t(photoUploadErrorKey(e2, true), locale));
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
          <Photo src={preview} alt={t("machines.primaryPhoto", locale)} size="thumb" priority className="h-20 w-20 rounded-lg ring-1 ring-sand-200" />
          <button type="button" onClick={clear} className="focus-ring inline-flex min-h-[48px] items-center rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700 hover:bg-sand-50 sm:min-h-[40px]">
            {t("machines.removePhoto", locale)}
          </button>
        </div>
      ) : (
        <label className="focus-ring inline-flex w-fit cursor-pointer items-center gap-1.5 min-h-[48px] rounded-lg border border-sand-300 px-4 text-sm font-medium text-sand-700 hover:bg-sand-50 sm:min-h-[40px]">
          {busy ? t("machine.uploading", locale) : t("machines.choosePhoto", locale)}
          <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={onFile} disabled={busy} />
        </label>
      )}
      {err ? <p role="alert" className="text-sm text-status-overdue">{err}</p> : null}
    </div>
  );
}
