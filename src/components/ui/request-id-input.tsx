"use client";

import { useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import { formFingerprint, newRequestId, REQUEST_FIELD } from "@/lib/request-id";

/** Long enough to cover a reload and a retry; short enough that an old entry is not matched. */
const REMEMBER_MS = 30 * 60 * 1000;
const PREFIX = "fw:request:";
const memory = new Map<string, { id: string; at: number }>();

/**
 * The request id a repeatable server action claims (runOnce, request_claims). Place it
 * inside the form; `action` names the action, the same string the server claims under.
 *
 * The id is chosen as the form submits, from what the form is sending. The case it exists
 * for is a save whose answer was lost: the person sees the connection-dropped screen,
 * reloads, and sends the same entry again. The id is remembered for this tab against a
 * fingerprint of the fields, so that retry carries the SAME id and the server answers with
 * the first attempt instead of saving it twice. Once a save has visibly completed, the id
 * is forgotten, so the next entry, even an identical one made on purpose, is a new request.
 */
export function RequestIdInput({ action }: { action: string }) {
  const input = useRef<HTMLInputElement>(null);
  const { pending } = useFormStatus();
  const sentKey = useRef<string | null>(null);
  const wasPending = useRef(false);

  useEffect(() => {
    const field = input.current;
    const form = field?.form;
    if (!field || !form) return;
    // Capture on the form runs before React reads the form for its action (at the root).
    const onSubmit = () => {
      const entries: Array<[string, string]> = [];
      for (const [name, value] of new FormData(form)) {
        entries.push([name, typeof value === "string" ? value : `${value.name}:${value.size}:${value.lastModified}`]);
      }
      const key = `${PREFIX}${action}:${formFingerprint(entries)}`;
      const id = recall(key) ?? newRequestId();
      remember(key, id);
      field.value = id;
      sentKey.current = key;
    };
    form.addEventListener("submit", onSubmit, { capture: true });
    return () => form.removeEventListener("submit", onSubmit, { capture: true });
  }, [action]);

  // Settled on this page (saved, or answered with an error and released on the server):
  // the next submit is a new request. A save whose answer never came unmounts this form
  // into the error screen instead, and keeps the id for the retry.
  useEffect(() => {
    if (pending) {
      wasPending.current = true;
      return;
    }
    if (!wasPending.current) return;
    wasPending.current = false;
    if (sentKey.current) forget(sentKey.current);
    sentKey.current = null;
  }, [pending]);

  return <input ref={input} type="hidden" name={REQUEST_FIELD} defaultValue="" />;
}

function recall(key: string): string | null {
  const now = Date.now();
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as { id: string; at: number } | null;
    if (stored && now - stored.at < REMEMBER_MS) return stored.id;
  } catch {
    /* storage unavailable: the in-memory copy below still covers this page */
  }
  const held = memory.get(key);
  return held && now - held.at < REMEMBER_MS ? held.id : null;
}

function remember(key: string, id: string) {
  const entry = { id, at: Date.now() };
  memory.set(key, entry);
  try {
    window.sessionStorage.setItem(key, JSON.stringify(entry));
  } catch {
    /* storage unavailable or full */
  }
}

function forget(key: string) {
  memory.delete(key);
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}
