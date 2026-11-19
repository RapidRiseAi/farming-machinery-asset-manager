"use client";

import { useEffect, useRef, useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { isNativeApp } from "@/lib/native/platform";
import {
  nativeRecordingState, openNativeSettings, startNativeRecording, stopNativeRecording, subscribeNativeRecording,
  type NativeRecordingState,
} from "@/lib/native/recorder";
import type { RecorderLabels } from "./recorder-labels";

/**
 * Records a route from the phone. In a browser it works only while this screen stays open (a web
 * page cannot follow a phone once the screen locks), so it says so plainly and asks the phone to
 * stay awake; points are held and sent every half minute, and a batch that fails is sent with the
 * next. In the Android app (B6) it starts the app's own recorder instead: a foreground service with
 * a notification that keeps going with the screen locked, until the person stops it or the drive
 * ends.
 */
const SEND_EVERY_MS = 30_000;

type Held = { lat: number; lng: number; at: string; speed: number | null; accuracy: number | null };

export function RouteRecorder({ sessionId, ownerId, labels }: { sessionId: string; ownerId: string; labels: RecorderLabels }) {
  const [native, setNative] = useState(false);
  useEffect(() => setNative(isNativeApp()), []);
  return native
    ? <NativeRouteRecorder sessionId={sessionId} ownerId={ownerId} labels={labels} />
    : <BrowserRouteRecorder sessionId={sessionId} labels={labels} />;
}

function NativeRouteRecorder({ sessionId, ownerId, labels }: { sessionId: string; ownerId: string; labels: RecorderLabels }) {
  const [recording, setRecording] = useState<NativeRecordingState>(nativeRecordingState());
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeNativeRecording(setRecording), []);
  const mine = recording.status === "recording" && recording.sessionId === sessionId;

  const toggle = async () => {
    setBusy(true);
    try {
      if (mine) await stopNativeRecording(null);
      else await startNativeRecording({ owner: ownerId, sessionId, labels: { title: labels.notificationTitle, message: labels.notificationMessage } });
    } finally {
      setBusy(false);
    }
  };

  const status =
    recording.status === "denied" ? labels.nativeDenied
    : recording.status === "stopped" && recording.reason === "ended" ? labels.nativeEnded
    : mine ? `${labels.nativeRecording}${recording.queued > 0 ? ` ${labels.nativeQueued.replace("{n}", String(recording.queued))}` : ""}`
    : labels.nativeDisclosure;

  return (
    <div className="flex flex-col gap-2">
      <button type="button" disabled={busy} className={buttonVariants({ variant: mine ? "secondary" : "primary" })} onClick={() => void toggle()}>
        {mine ? labels.stop : labels.start}
      </button>
      <p role="status" className="text-sm text-ink-muted">{status}</p>
      {recording.status === "denied" ? (
        <button type="button" className={buttonVariants({ variant: "ghost", size: "sm" })} onClick={() => void openNativeSettings()}>
          {labels.openSettings}
        </button>
      ) : null}
    </div>
  );
}

function BrowserRouteRecorder({ sessionId, labels }: { sessionId: string; labels: RecorderLabels }) {
  const [on, setOn] = useState(false);
  const [denied, setDenied] = useState(false);
  const held = useRef<Held[]>([]);

  useEffect(() => {
    if (!on) return;
    let wake: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    const stayAwake = () => void nav.wakeLock?.request("screen").then((lock) => { wake = lock; }).catch(() => undefined);
    stayAwake();
    // A phone drops the screen lock whenever this page is hidden (a call, another app), and
    // does not give it back: ask again when the page is in front once more.
    const onVisible = () => {
      if (document.visibilityState === "visible") stayAwake();
    };
    document.addEventListener("visibilitychange", onVisible);

    const watch = navigator.geolocation.watchPosition(
      (p) => {
        held.current.push({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          at: new Date(p.timestamp).toISOString(),
          speed: p.coords.speed == null ? null : p.coords.speed * 3.6,
          accuracy: p.coords.accuracy,
        });
      },
      () => {
        setDenied(true);
        setOn(false);
      },
      { enableHighAccuracy: true, maximumAge: 5000 },
    );

    const send = async () => {
      if (held.current.length === 0) return;
      const batch = held.current;
      held.current = [];
      const response = await fetch("/api/positions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, points: batch }),
      }).catch(() => null);
      // No signal: keep them for the next try.
      if (!response?.ok) held.current = [...batch, ...held.current].slice(-200);
    };
    const timer = setInterval(() => void send(), SEND_EVERY_MS);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      navigator.geolocation.clearWatch(watch);
      clearInterval(timer);
      void send();
      void wake?.release().catch(() => undefined);
    };
  }, [on, sessionId]);

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className={buttonVariants({ variant: "secondary" })}
        onClick={() => {
          setDenied(false);
          setOn(!on);
        }}
      >
        {on ? labels.stop : labels.start}
      </button>
      <p role="status" className="text-sm text-ink-muted">
        {denied ? labels.denied : on ? `${labels.recording} ${labels.keepOpen}` : labels.keepOpen}
      </p>
    </div>
  );
}
