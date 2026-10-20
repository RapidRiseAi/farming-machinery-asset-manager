"use client";

import { ErrorScreen } from "@/components/ui/error-screen";

/**
 * What a public page (the QR sticker, an emailed invoice, sign-up) shows when it throws.
 * These fell through to the root fallback: English only, and "the app did not start" on a
 * page that had. No "back home" link, a stranger holding a QR link has no home here.
 */
export default function PublicError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen error={error} reset={reset} area="public" homeHref={null} />;
}
