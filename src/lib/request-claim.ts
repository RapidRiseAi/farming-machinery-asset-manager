import "server-only";

import { createHash } from "node:crypto";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { captureError } from "@/lib/observability";
import { readRequestId, REQUEST_FIELD } from "@/lib/request-id";

/**
 * One request, one effect, on the server (20261018090000).
 *
 * The screen side stops repeated taps, but a request can still arrive twice: a save whose
 * answer was lost on farm signal and is tried again, a dialog closed mid-save and saved
 * again, two tabs. Each repeatable action claims the request id its form carries
 * (RequestIdInput) before doing anything; a replay gets the first attempt's outcome.
 *
 * Fails open: with no id (a form not yet updated, a page loaded before a deploy) or when
 * the claim itself errors, the action runs as it always did, and an error is reported.
 * Never a reason to refuse a farmer's save.
 */
export type Claim =
  | { state: "new"; finish: (outcome: string) => Promise<void>; release: () => Promise<void> }
  | { state: "done"; outcome: string }
  | { state: "running" };

const UNCLAIMED: Claim = { state: "new", finish: async () => {}, release: async () => {} };

export async function claimRequest(
  supabase: SupabaseClient,
  requestId: string | null,
  action: string,
): Promise<Claim> {
  if (!requestId) return UNCLAIMED;
  const { data, error } = await supabase.rpc("claim_request", { p_request: requestId, p_action: action });
  if (error) {
    captureError(error, { where: `claim:${action}`, extra: { code: error.code ?? null } });
    return UNCLAIMED;
  }
  const answer = (data ?? {}) as { state?: string; outcome?: string | null };
  if (answer.state === "done") return { state: "done", outcome: answer.outcome ?? "" };
  if (answer.state === "running") return { state: "running" };
  return {
    state: "new",
    finish: async (outcome) => {
      const { error: finishError } = await supabase.rpc("finish_request", { p_request: requestId, p_outcome: outcome });
      if (finishError) captureError(finishError, { where: `claim:${action}:finish` });
    },
    release: async () => {
      const { error: releaseError } = await supabase.rpc("release_request", { p_request: requestId });
      if (releaseError) captureError(releaseError, { where: `claim:${action}:release` });
    },
  };
}

/**
 * A server action that must run once per request: `work` does it and returns where to
 * send the person; anything it throws (its own error redirects included) releases the
 * claim so the retry runs.
 *
 * So once the effect has landed, `work` must RETURN, even a destination that carries a
 * warning ("saved, but the receipt did not stick", "the lines did not copy"). A redirect
 * there would release the claim, and the retry would create the record a second time. A replay of a finished request goes where the first went; one
 * that arrives while the first is still running goes to `whileRunning`.
 *
 *   export async function recordPayment(formData: FormData) {
 *     return runOnce(formData, "documents:record-payment", async () => {
 *       ...validate (redirecting on errors), insert...
 *       return `/documents/${id}?paid=1`;
 *     }, { whileRunning: `/documents/${id}?error=still-saving` });
 *   }
 */
export async function runOnce(
  formData: FormData,
  action: string,
  work: () => Promise<string>,
  { whileRunning }: { whileRunning: string },
): Promise<never> {
  const supabase = await createClient();
  const claim = await claimRequest(supabase, readRequestId(formData.get(REQUEST_FIELD)), action);
  if (claim.state === "done") redirect(claim.outcome || whileRunning);
  if (claim.state === "running") redirect(whileRunning);
  let target: string;
  try {
    target = await work();
  } catch (error) {
    await claim.release();
    throw error;
  }
  await claim.finish(target);
  redirect(target);
}

/**
 * Resend's idempotency key for one send: the screen's request id plus what is being sent.
 * Resend refuses a reused key with a DIFFERENT message for 24 hours, so an edited retry
 * after a genuine failure must carry a new key, while an identical retry carries the same.
 */
export function emailKey(requestId: string | null, parts: Array<string | null | undefined>): string | null {
  if (!requestId) return null;
  const digest = createHash("sha256").update(parts.map((part) => part ?? "").join("\u0000")).digest("hex");
  return `${requestId}:${digest.slice(0, 16)}`;
}
