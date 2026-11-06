"use client";

import { useEffect, useRef, useState } from "react";

import { buttonVariants } from "@/components/ui/button";

/**
 * Records a route from the phone while this screen stays open. A web page cannot follow a
 * phone once the screen locks, so it says so plainly, and asks the phone to stay awake.
 * Points are held and sent every half minute, and a batch that fails is sent with the next.
 */
const SEND_EVERY_MS = 30_000;

type Labels = { start: string; stop: string; recording: string; keepOpen: string; denied: string };
type Held = { lat: number; lng: number; at: string; speed: number | null; accuracy: number | null };

export function RouteRecorder({ sessionId, labels }: { sessionId: string; labels: Labels }) {
  const [on, setOn] = useState(false);
  const [denied, setDenied] = useState(false);
  const held = useRef<Held[]>([]);

  useEffect(() => {
    if (!on) return;
    let wake: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> } };
    void nav.wakeLock?.request("screen").then((lock) => { wake = lock; }).catch(() => undefined);

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
