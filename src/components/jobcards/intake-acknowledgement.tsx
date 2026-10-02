"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

/** Only the acknowledged capture is cleared; another tab's newer draft survives. */
export function IntakeAcknowledgement({ actorId }: { actorId: string }) {
  const token = useSearchParams().get("intake_token");
  useEffect(() => {
    if (!token) return;
    try {
      const prefix = `fleetwise:job-intake-draft:${actorId}:`;
      const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
      for (const key of keys) {
        if (!key?.startsWith(prefix)) continue;
        try {
          const saved = JSON.parse(localStorage.getItem(key) ?? "null");
          if (saved?.capture === token) localStorage.removeItem(key);
        } catch { /* One invalid draft must not affect other drafts. */ }
      }
    } catch { /* Device storage is optional. */ }
  }, [actorId, token]);
  return null;
}
