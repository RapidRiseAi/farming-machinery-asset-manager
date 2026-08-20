"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button, buttonVariants } from "@/components/ui/button";
import { WarningIcon } from "@/components/ui/icons";
import { reportClientError } from "@/lib/client-report";

/**
 * What a signed-in page shows when it throws.
 *
 * There was no error boundary anywhere in the app, so a failed query rendered Next's
 * default — a blank screen with a technical string on it. On a farm that is
 * indistinguishable from "the app is broken", and the only recovery anyone would find
 * is closing the tab.
 *
 * Deliberately plain-language, and offers the two things that actually help: try again
 * (most failures here are a dropped connection mid-query) and a way back to somewhere
 * that works. `digest` is shown small because it is the only handle support has.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    // Until now this screen was the end of the road: the farmer saw it and we never did.
    reportClientError(error, "app");
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 py-6">
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 shrink-0 text-[1.5rem] text-status-overdue">
            <WarningIcon />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-sand-950">This screen did not load</h1>
            <p className="mt-1 text-sm text-sand-600">
              Something went wrong on our side, not yours. Nothing you entered has been lost.
              Try again — if it keeps happening, the farm office can send us the code below.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={() => reset()}>
            Try again
          </Button>
          <Link href="/home" className={buttonVariants({ variant: "secondary" })}>
            Go to my home screen
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-4 border-t border-sand-100 pt-3 text-xs text-sand-400">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
      </Card>
    </div>
  );
}
