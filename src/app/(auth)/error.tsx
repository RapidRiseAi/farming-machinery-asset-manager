"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/** What a sign-in, two-step or account-gate page shows when it throws. See ErrorScreen. */
export default function AuthError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} area="auth" homeHref="/login" />;
}
