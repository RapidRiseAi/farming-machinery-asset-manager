"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Photo = { id: string; url: string | null };

/** Client-side downscale + JPEG re-encode to keep uploads ~200–400 KB (Scope §7). */
async function compressImage(file: File, maxDim = 1600, quality = 0.7): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unsupported");
  ctx.drawImage(bitmap, 0, 0, w, h);
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Compression failed"))),
      "image/jpeg",
      quality
    )
  );
}

export function MachinePhotos({
  farmId,
  machineId,
  canEdit,
}: {
  farmId: string;
  machineId: string;
  canEdit: boolean;
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
      setErr(e2 instanceof Error ? e2.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-sand-900">Photos</h2>
        {canEdit ? (
          <label className="focus-ring inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-sand-300 px-3 py-1.5 text-sm font-medium text-sand-700 hover:bg-sand-50">
            {busy ? "Uploading…" : "Add photo"}
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
        {photos.map((p) =>
          p.url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={p.id} src={p.url} alt="Machine photo" className="aspect-square w-full rounded-lg object-cover" />
          ) : null
        )}
        {photos.length === 0 ? (
          <p className="col-span-3 text-sm text-sand-400">No photos yet.</p>
        ) : null}
      </div>
    </section>
  );
}
