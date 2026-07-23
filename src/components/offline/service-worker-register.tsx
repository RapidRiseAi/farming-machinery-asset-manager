"use client";

import { useEffect } from "react";
import { registerAutoFlush } from "@/lib/offline/sync";

/**
 * Registers the service worker and arms auto-flush of the offline queue. Mounted once in
 * the root layout so it covers both the app shell and the public QR page. Registration is
 * production-only (dev + a SW fight over chunk caching); auto-flush runs everywhere.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    registerAutoFlush();
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* graceful no-SW fallback: the app keeps working online */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
