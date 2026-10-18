"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./button";

/** If the next page has not taken over by then, the post did not get through: give the button back. */
const GIVE_BACK_MS = 15_000;

/**
 * A form that posts straight to another site and leaves this page: the customer's "Pay now"
 * to PayFast on a public invoice.
 *
 * Its action is a URL, not a server action, so React never reports it pending and a
 * `SubmitButton` inside it neither spun nor locked. A customer on slow data saw nothing
 * happen and tapped again; every tap posted to PayFast again and restarted the navigation.
 * This locks on the first submit and shows the spinner until the page goes. Coming back
 * with Back (the page restored from the browser's cache) unlocks it, and so does a post
 * that never left after GIVE_BACK_MS.
 */
export function LeavingForm({
  action,
  method = "post",
  className,
  submitLabel,
  children,
}: {
  action: string;
  method?: "post" | "get";
  className?: string;
  submitLabel: ReactNode;
  children?: ReactNode;
}) {
  const sent = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      sent.current = false;
      setBusy(false);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  return (
    <form
      action={action}
      method={method}
      className={className}
      onSubmit={(event) => {
        if (sent.current) {
          event.preventDefault();
          return;
        }
        sent.current = true;
        setBusy(true);
        window.setTimeout(() => {
          sent.current = false;
          setBusy(false);
        }, GIVE_BACK_MS);
      }}
    >
      {children}
      <Button type="submit" loading={busy}>
        {submitLabel}
      </Button>
    </form>
  );
}
