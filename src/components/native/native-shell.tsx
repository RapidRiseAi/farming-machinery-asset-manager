"use client";

import { useEffect } from "react";
import { isNativeApp } from "@/lib/native/platform";
import { inAppPath } from "@/lib/native/links";
import { resumeNativeRecording } from "@/lib/native/recorder";

/**
 * In the Android app (B6): an emailed link to the app's own address (sign-in, invite, password
 * reset) that Android hands to the app opens that page inside it. A full load, so the server sees
 * the link's sign-in code exactly as a browser would. Mounted once in the root layout; nothing in a
 * browser.
 */
export function NativeLinks() {
  useEffect(() => {
    if (!isNativeApp()) return;
    let remove: (() => void) | null = null;
    let cancelled = false;
    void import("@capacitor/app").then(({ App }) =>
      App.addListener("appUrlOpen", ({ url }) => {
        const path = inAppPath(url, window.location.origin);
        if (path) window.location.assign(path);
      }).then((handle) => {
        if (cancelled) void handle.remove();
        else remove = () => void handle.remove();
      }),
    ).catch(() => undefined);
    return () => {
      cancelled = true;
      remove?.();
    };
  }, []);
  return null;
}

/**
 * In the Android app: carries on a drive this person was recording when the app reopens, sends
 * positions still waiting, and clears what a different person left on the phone. Mounted in the
 * signed-in layout with the signed-in person's id.
 */
export function NativeSession({ ownerId }: { ownerId: string }) {
  useEffect(() => {
    if (!isNativeApp()) return;
    void resumeNativeRecording(ownerId).catch(() => undefined);
  }, [ownerId]);
  return null;
}
