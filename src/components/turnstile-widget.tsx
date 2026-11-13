"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

/**
 * Cloudflare Turnstile's box, for a form whose action calls `checkTurnstile`.
 *
 * Rendered only when the page got a site key from `turnstileWidget()` (both keys set), so
 * with the check off there is no script and nothing on screen. Must sit INSIDE the
 * `<form>`: Turnstile adds a hidden `cf-turnstile-response` field to the form around it,
 * which every submit button of that form then posts, `formAction` ones included. It adds no
 * button, so SubmitButton's locking and the login form's hidden default submit are as they
 * were.
 *
 * Without JavaScript nothing here runs, no token is posted, and the action refuses the
 * submit with "tick the check again", which says JavaScript is needed. That is deliberate:
 * a form that skips the check when scripts are off is a form a bot posts with scripts off.
 *
 * Explicit render, so the script loads only on a page that shows the box, and once per
 * visit. The widget's mode (managed) is set on the site key in Cloudflare's dashboard.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | null | undefined;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    // A failed load can be tried again on the next page that shows the box.
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("turnstile script failed to load"));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** The app's own theme: an explicit choice on <html>, otherwise the device's (`auto`). */
function appTheme(): "light" | "dark" | "auto" {
  const chosen = document.documentElement.getAttribute("data-theme");
  return chosen === "light" || chosen === "dark" ? chosen : "auto";
}

export function TurnstileWidget({ siteKey, language }: { siteKey: string; language: string }) {
  const box = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const { pending } = useFormStatus();
  const wasPending = useRef(false);

  useEffect(() => {
    let gone = false;
    loadTurnstile()
      .then((api) => {
        if (gone || !box.current) return;
        widgetId.current = api.render(box.current, { sitekey: siteKey, theme: appTheme(), language, size: "flexible" }) ?? null;
      })
      // No box (a blocker, no signal). The action refuses without a token and says why.
      .catch(() => undefined);
    return () => {
      gone = true;
      if (widgetId.current) window.turnstile?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, language]);

  // A token is good for one check. When a submission comes back to this same screen (a
  // wrong password, a field to fix), ask for a fresh one, or the next press would be
  // refused as a repeat.
  useEffect(() => {
    if (wasPending.current && !pending && widgetId.current) window.turnstile?.reset(widgetId.current);
    wasPending.current = pending;
  }, [pending]);

  // The box's height kept from the first paint, so the button under it does not jump.
  return <div ref={box} className="min-h-[65px]" />;
}
