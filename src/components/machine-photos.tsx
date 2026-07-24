"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { compressImage } from "@/lib/image-compress";
import { t, type Locale } from "@/lib/i18n";
import { setPrimaryPhoto, clearPrimaryPhoto } from "@/app/(app)/machines/actions";

type Photo = { id: string; url: string | null };

/**
 * Machine photo gallery + uploader. Photos live in `attachments` (kind=photo) and the
 * private `machine-photos` bucket; one can be marked the machine's PRIMARY image
 * (machines.primary_attachment_id, 0280) which then shows on list cards + the detail
 * header. Uploads are compressed client-side (~200–400 KB) to suit low bandwidth.
 */
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
  locale?: Locale;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("attachments")
      .select("id, storage_path")
      .eq("parent_type", "machine")
      .eq("parent_id", machineId)
      .eq("kind", "photo")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    const rows = (data ?? []) as { id: string; storage_path: string | null }[];
    const withUrls = await Promise.all(
      rows.map(async (r) => {
        let url: string | null = null;
        if (r.storage_path) {
          const { data: s } = await supabase.storage
            .from("machine-photos")
            .createSignedUrl(r.storage_path, 3600);
          url = s?.signedUrl ?? null;
        }
        return { id: r.id, url };
      })
    );
    setPhotos(withUrls);
  }, [machineId]);

  useEffect(() => {
    load();
  }, [load]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const supabase = createClient();
      const blob = await compressImage(file);
      const path = `${farmId}/${machineId}/${crypto.randomUUID()}.jpg`;
      const up = await supabase.storage
        .from("machine-photos")
        .upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw up.error;
      const ins = await supabase.from("attachments").insert({
        farm_id: farmId,
        parent_type: "machine",
        parent_id: machineId,
        kind: "photo",
        storage_path: path,
      });
      if (ins.error) throw ins.error;
      await load();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : t("machine.uploadFailed", locale));
    } finally {
      setBusy(false);
    }
  }

  // Primary first, so the gallery leads with the image shown elsewhere.
  const ordered = photos
    .slice()
    .sort((a, b) => Number(b.id === primaryAttachmentId) - Number(a.id === primaryAttachmentId));

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-sand-900">{t("machine.photos", locale)}</h2>
        {canEdit ? (
          <label className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sand-300 px-3 py-1.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
            {busy ? t("machine.uploading", locale) : t("machine.addPhoto", locale)}
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="sr-only"
              onChange={onFile}
              disabled={busy}
            />
          </label>
        ) : null}
      </div>
      {err ? <p className="mb-2 text-sm text-status-overdue">{err}</p> : null}
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
                <span className="absolute left-1 top-1 rounded bg-brand-600 px-1.5 py-0.5 text-[0.65rem] font-semibold text-white">
                  {t("machine.primaryBadge", locale)}
                </span>
              ) : null}
              {canEdit ? (
                <div className="absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                  {isPrimary ? (
                    <form action={clearPrimaryPhoto}>
                      <input type="hidden" name="machine_id" value={machineId} />
                      <button type="submit" className="focus-ring rounded bg-white/90 px-2 py-0.5 text-[0.7rem] font-medium text-sand-800 hover:bg-white">
                        {t("machine.unsetPrimary", locale)}
                      </button>
                    </form>
                  ) : (
                    <form action={setPrimaryPhoto}>
                      <input type="hidden" name="machine_id" value={machineId} />
                      <input type="hidden" name="attachment_id" value={p.id} />
                      <button type="submit" className="focus-ring rounded bg-white/90 px-2 py-0.5 text-[0.7rem] font-medium text-sand-800 hover:bg-white">
                        {t("machine.setPrimary", locale)}
                      </button>
                    </form>
                  )}
                </div>
              ) : null}
            </figure>
          ) : null;
        })}
        {photos.length === 0 ? (
          <p className="col-span-3 text-sm text-sand-400">{t("machine.noPhotos", locale)}</p>
        ) : null}
      </div>
    </section>
  );
}
