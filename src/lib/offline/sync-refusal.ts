/**
 * Why a queued capture was refused, as a code the phone keeps with the draft and explains
 * (offline.reason.*). A refusal is never "try again later": a plan, an equipment profile or a
 * lost membership will not change by retrying, and treating them as transient retried them on
 * every reconnect, for ever, with nothing said. Only our own failures are transient (503).
 */
export function syncRefusal(error: { code?: string; message?: string }): { status: number; code: string } {
  const message = error.message ?? "";
  if (error.code === "P0001" && /^(plan-feature-[a-z_]+|equipment-refused-[a-z_-]+)$/.test(message)) {
    return { status: 409, code: message };
  }
  if (error.code === "42501") return { status: 403, code: "capture_forbidden" };
  if (error.code === "P0002") return { status: 404, code: "capture_not_found" };
  if (error.code?.startsWith("22") || error.code === "P0001" || error.code === "23514") return { status: 400, code: "capture_rejected" };
  return { status: 503, code: "sync_unavailable" };
}

/** The sentence a kept draft shows for the reason the server gave (offline.reason.*). */
export function syncReasonKey(code: string | undefined): string {
  if (!code) return "offline.needsReview";
  if (code.startsWith("plan-feature-")) return "offline.reason.plan";
  if (code.startsWith("equipment-refused-")) return "offline.reason.equipment";
  const known: Record<string, string> = {
    capture_forbidden: "offline.reason.access",
    capture_not_found: "offline.reason.gone",
    capture_rejected: "offline.reason.invalid",
    capture_account_mismatch: "offline.reason.account",
    capture_needs_review: "offline.reason.review",
    conflict: "offline.reason.conflict",
  };
  return known[code] ?? "offline.needsReview";
}
