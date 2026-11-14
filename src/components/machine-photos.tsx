"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { signedUrlsByPath } from "@/lib/signed-urls";
import { t, type Lang } from "@/lib/i18n";
import { setPrimaryPhoto, clearPrimaryPhoto } from "@/app/(app)/machines/actions";
import { UploadField } from "@/components/upload/upload-field";
import { SubmitButton } from "@/components/ui/submit-button";
import { reportClientError } from "@/lib/client-report";
import { asError } from "@/lib/single-flight";

type Photo = { id: string; url: string | null };

/**
 * Machine photo gallery + uploader. Photos live in `attachments` (kind=photo) and the
 * private `machine-photos` bucket; one can be marked the machine's PRIMARY image
 * (machines.primary_attachment_id, 0280) which then shows on list cards + the detail
 * header. Uploads go straight to Storage through the upload pipeline (UploadField):
 * reduced unless the original is kept, checked on the server, saved once.
 */
/** A stale row (its file deleted) fails to sign on every visit; one report per page session. */
let signReported = false;

export function MachinePhotos({
  farmId,
  machineId,
  canEdit,
  primaryAttachmentId = null,
  locale = "en",
}: {
  farmId: string;
  machineId: string;
  canEdit: boolean;
  primaryAttachmentId?: string | null;
  locale?: Lang;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Set when the list itself could not be read, so the gallery does not also say
  // "No photos yet" under the error: a failed read is not an empty gallery.
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("attachments")
      .select("id, storage_path")
      .eq("parent_type", "machine")
      .eq("parent_id", machineId)
      .eq("kind", "photo")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    // A failed read is not "no photos yet": say so instead of showing an empty gallery.
    // Reported unless the phone is simply offline, which is not ours to hear about.
    if (error) {
      if (navigator.onLine !== false) reportClientError(asError(error), "machine-photos:load");
      setErr(t("errors.generic", locale));
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    const rows = (data ?? []) as { id: string; storage_path: string | null }[];
    // One request for the whole gallery; a file that will not sign is left out of it.
    const { urls, error: signFailure } = await signedUrlsByPath(supabase, "machine-photos", rows.map((r) => r.storage_path), 3600);
    const withUrls = rows.map((r) => ({ id: r.id, url: (r.storage_path && urls.get(r.storage_path)) || null }));
    setPhotos(withUrls);
    // A photo without a link is hidden, so tell the person some did not load. One row whose
    // file is gone fails on every visit, so it is reported once per page session, not on
    // every load of every machine.
    if (signFailure) {
      if (navigator.onLine !== false && !signReported) {
        signReported = true;
        reportClientError(asError(signFailure), "machine-photos:sign");
      }
      setErr(t("machine.somePhotosMissing", locale));
    }
  }, [machineId, locale]);

  useEffect(() => {
    load();
  }, [load]);

  // Primary first, so the gallery leads with the image shown elsewhere.
  const ordered = photos
    .slice()
    .sort((a, b) => Number(b.id === primaryAttachmentId) - Number(a.id === primaryAttachmentId));

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-sand-900">{t("machine.photos", locale)}</h2>
      </div>
      {canEdit ? (
        <UploadField
          className="mb-3"
          locale={locale}
          label={t("machine.addPhoto", locale)}
          accept="photo"
          capture
          uploadLabel="photo"
          finish="generic"
          attachmentKind="photo"
          scope={`machine-photo:${machineId}`}
          target={{ kind: "machine", id: machineId, farmId }}
          onDone={() => { setErr(null); void load(); }}
        />
      ) : null}
      {err ? <p role="alert" className="mb-2 text-sm text-status-overdue">{err}</p> : null}
      <div className="grid grid-cols-3 gap-2">
        {ordered.map((p) => {
          const isPrimary = p.id === primaryAttachmentId;
          return p.url ? (
            <figure key={p.id} className="group relative overflow-hidden rounded-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.url}
                alt={t("machine.photos", locale)}
                className={`aspect-square w-full object-cover ${isPrimary ? "ring-2 ring-brand-500" : ""}`}
              />
              {isPrimary ? (
                <span className="absolute left-1 top-1 rounded bg-brand-600 px-1.5 py-0.5 text-2xs font-semibold text-white">
                  {t("machine.primaryBadge", locale)}
                </span>
              ) : null}
              {canEdit ? (
                <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  {isPrimary ? (
                    <form action={clearPrimaryPhoto}>
                      <input type="hidden" name="machine_id" value={machineId} />
                      <SubmitButton look="plain" className="focus-ring inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-white/90 px-3 text-xs font-medium text-sand-800 hover:bg-white sm:min-h-[32px]">
                        {t("machine.unsetPrimary", locale)}
                      </SubmitButton>
                    </form>
                  ) : (
                    <form action={setPrimaryPhoto}>
                      <input type="hidden" name="machine_id" value={machineId} />
                      <input type="hidden" name="attachment_id" value={p.id} />
                      <SubmitButton look="plain" className="focus-ring inline-flex min-h-[48px] items-center gap-1.5 rounded-lg bg-white/90 px-3 text-xs font-medium text-sand-800 hover:bg-white sm:min-h-[32px]">
                        {t("machine.setPrimary", locale)}
                      </SubmitButton>
                    </form>
                  )}
                </div>
              ) : null}
            </figure>
          ) : null;
        })}
        {photos.length === 0 && !loadFailed ? (
          <p className="col-span-3 text-sm text-sand-400">{t("machine.noPhotos", locale)}</p>
        ) : null}
      </div>
    </section>
  );
}
