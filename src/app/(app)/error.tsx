"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * What a signed-in page shows when it throws. There was no error boundary anywhere in the
 * app once, so a failed query rendered Next's default, a blank screen with a technical
 * string on it, indistinguishable on a farm from "the app is broken". See ErrorScreen.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} area="app" homeHref="/home" />;
}
