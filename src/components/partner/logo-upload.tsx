"use client";

import { useRef, useState, type ReactNode } from "react";
import { t, type Lang } from "@/lib/i18n";
import { compressImage, blobToDataUrl } from "@/lib/image-compress";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { CameraIcon } from "@/components/ui/icons";
import { uploadPartnerLogo } from "@/app/(app)/contractor/settings/actions";

/**
 * The partner's logo, picked and previewed before it is sent.
 *
 * Raster images are compressed in the browser first (the shared machine-photo path), so
 * a 6 MB phone photo of a signboard becomes a few hundred KB. An SVG is passed straight
 * through — re-encoding a vector logo as JPEG is exactly the wrong thing to do to it.
 * Either way the result is ferried as a base64 data URL through a form field, the same
 * way the add-vehicle photo travels, so there is one upload story in this codebase.
 */
export function LogoUpload({
  locale,
  currentUrl,
  removeAction,
}: {
  locale: Lang;
  currentUrl: string | null;
  removeAction: ReactNode;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File | null) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const dataUrl =
        file.type === "image/svg+xml"
          ? await blobToDataUrl(file)
          : await blobToDataUrl(await compressImage(file, 512, 0.85));
      setPreview(dataUrl);
    } catch {
      setError(t("partnerSettings.logoError", locale));
    } finally {
      setBusy(false);
    }
  }

  const shown = preview ?? currentUrl;

  return (
    <Card>
      <CardHeader><CardTitle>{t("partnerSettings.logo", locale)}</CardTitle></CardHeader>
      <p className="mb-3 text-sm text-sand-500">{t("partnerSettings.logoHint", locale)}</p>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-sand-200 bg-sand-50">
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element -- a signed Storage URL or a local data URL
            <img src={shown} alt={t("partnerSettings.logoAlt", locale)} className="h-full w-full object-contain p-1" />
          ) : (
            <span className="text-sm text-sand-400">{t("partnerSettings.noLogo", locale)}</span>
          )}
        </div>

        <div className="flex flex-1 flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/svg+xml"
            className="sr-only"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
          <Button type="button" variant="secondary" size="sm" leftIcon={<CameraIcon />} onClick={() => fileRef.current?.click()}>
            {t("partnerSettings.chooseLogo", locale)}
          </Button>

          {preview ? (
            <form action={uploadPartnerLogo} className="flex items-center gap-2">
              <input type="hidden" name="logo" value={preview} />
              <SubmitButton size="sm">{t("partnerSettings.saveLogo", locale)}</SubmitButton>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPreview(null)}>
                {t("common.cancel", locale)}
              </Button>
            </form>
          ) : (
            removeAction
          )}
        </div>
      </div>

      {busy ? <p className="mt-2 text-sm text-sand-500">{t("partnerSettings.logoWorking", locale)}</p> : null}
      {error ? <p className="mt-2 text-sm text-status-overdue" role="alert">{error}</p> : null}
    </Card>
  );
}
