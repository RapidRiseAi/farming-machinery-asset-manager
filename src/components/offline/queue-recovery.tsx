"use client";

import { useEffect, useState } from "react";
import { t, type Lang } from "@/lib/i18n";
import { dequeue, listMutations, subscribe } from "@/lib/offline/queue";
import { flush } from "@/lib/offline/sync";
import type { QueuedMutation } from "@/lib/offline/types";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

async function blobData(blob?: Blob): Promise<string | undefined> {
  if (!blob) return undefined;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export function QueueRecovery({ userId, locale }: { userId: string | null; locale: Lang }) {
  const [items, setItems] = useState<QueuedMutation[]>([]);
  const [other, setOther] = useState(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let visibleActor: string | null = null;
    const refresh = () => { void listMutations().then(all => {
      if (!active) return;
      const own = all.filter(m => m.scope === "public" || (visibleActor && m.actor_id === visibleActor));
      setItems(own); setOther(all.length - own.length); setReady(true);
    }).catch(() => { if (active) { setError(true); setReady(true); } }); };
    // Cached server props must not expose the previous account's drafts after a
    // sign-out or an account change in another tab. This only controls local display;
    // the API still validates the real authenticated session before every write.
    const { data: { subscription } } = createClient().auth.onAuthStateChange((_event, session) => {
      visibleActor = session?.user.id === userId ? userId : null;
      setItems(previous => previous.filter(m => m.scope === "public" || m.actor_id === visibleActor));
      refresh();
    });
    refresh(); const unsub = subscribe(refresh);
    return () => { active = false; unsub(); subscription.unsubscribe(); };
  }, [userId]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(false);
    try { await action(); } catch { setError(true); } finally { setBusy(false); }
  };
  const download = async (item: QueuedMutation) => {
    const file = { ...item, photo: await blobData(item.photo), voice: await blobData(item.voice) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `fleetwise-capture-${item.client_id}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <div className="flex flex-col gap-3" aria-busy={busy}>
    {error ? <p role="alert" className="text-status-overdue">{t("offline.storageFailed", locale)}</p> : null}
    {other > 0 ? <p role="status" className="text-sm text-sand-600">{t("offline.otherAccount", locale)}</p> : null}
    <Button type="button" disabled={busy || !items.length} onClick={() => void run(flush)}>{t("offline.retryAll", locale)}</Button>
    {ready && !items.length ? <p role="status">{t("offline.emptyQueue", locale)}</p> : null}
    {items.map(item => <article key={item.client_id} className="rounded-xl border border-sand-200 p-4">
      <h2 className="font-semibold">{t(`offline.types.${item.type}`, locale)}</h2>
      <p className="mt-1 text-sm text-sand-600">{new Date(item.queued_at).toLocaleString()}</p>
      {item.sync_error ? <p className="mt-2 text-sm text-status-due">{t("offline.needsReview", locale)}</p> : null}
      <dl className="my-3 grid gap-1 text-sm">
        {Object.entries(item.fields).filter(([key]) => key !== "token" && !key.startsWith("$")).map(([key, value]) =>
          <div key={key} className="break-words"><dt className="inline font-medium">{key}: </dt><dd className="inline">{value}</dd></div>)}
      </dl>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void run(() => download(item))}>{t("offline.exportCapture", locale)}</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => {
          if (window.confirm(t("offline.removeConfirm", locale))) void run(() => dequeue(item.client_id));
        }}>{t("offline.removeCopy", locale)}</Button>
      </div>
    </article>)}
  </div>;
}
