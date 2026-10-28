import "server-only";

import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { must, ReadFailed } from "@/lib/supabase/must";
import { captureError } from "@/lib/observability";

/**
 * Posting a copy of a support case to an outside receiver, if one is ever configured.
 *
 * Founder default (2026-10-28): the Fleet Wise admin (/admin/support) is the system of
 * record and cases are worked there. SUPPORT_WEBHOOK_URL stays unset; this is kept only
 * as an optional mirror, and with it unset the billing cron reports the step as skipped.
 *
 * == The contract, so the other side is a small job ===========================
 * One POST per case, `content-type: application/json`, to `SUPPORT_WEBHOOK_URL`:
 *
 *   {
 *     "id":        "<uuid>",          // THE IDEMPOTENCY KEY, upsert on this
 *     "kind":      "dispute" | "refund_request" | "billing_anomaly" | "manual",
 *     "status":    "open" | "waiting" | "resolved" | "closed",
 *     "subject":   "Card dispute on FWB-…",
 *     "opened_at": "2026-09-12T…Z",
 *     "due_at":    "2026-09-14T…Z" | null,   // disputes only; a real deadline
 *     "external_ref": "<paystack dispute or refund id>" | null,
 *     "source":    "fleetwise",
 *     "evidence":  { farm, owner, subscription, invoice, payments, card, attempts, … }
 *   }
 *
 * **Upsert on `id`.** FleetWise may post the same case more than once, a webhook
 * redelivery, a retry after a failed post, and two posts of one case must be one case
 * there. That is also why this needs no claim/release pair on our side: the receiver makes
 * duplicates harmless, so defending against them here would be machinery for a
 * non-problem.
 *
 * **Signature.** When `SUPPORT_WEBHOOK_SECRET` is set, `x-fleetwise-signature` carries the
 * HMAC-SHA256 of the raw body, hex. Verify it against the RAW bytes before parsing, the
 * same rule the Paystack webhook follows in the other direction, and for the same reason:
 * a payload you have parsed is a payload you have already trusted.
 *
 * == Env-gated, and honest about it ===========================================
 * With `SUPPORT_WEBHOOK_URL` unset this reports `not-configured` and claims nothing, so a
 * fresh clone, the test suite and a preview deployment all behave. There is no silent
 * success, the lesson `emailConfigured()` taught the expensive way, where a truthy
 * placeholder meant the product reported "configured" while every call was refused.
 */

export type SupportTicketPayload = {
  id: string;
  kind: string;
  status: string;
  subject: string;
  opened_at: string;
  due_at: string | null;
  external_ref: string | null;
  source: "fleetwise";
  evidence: Record<string, unknown>;
};

export type PostResult =
  | { ok: true; id: string }
  | { ok: false; id: string; error: string };

export function supportWebhookProblem(): string | null {
  const url = (process.env.SUPPORT_WEBHOOK_URL ?? "").trim();
  if (!url) return "SUPPORT_WEBHOOK_URL is not set";
  if (/^\[.*\]$/.test(url)) return "SUPPORT_WEBHOOK_URL is a placeholder, not a URL";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "SUPPORT_WEBHOOK_URL is not a URL";
  }
  // A case carries another farm's billing detail and a bank's claim about a person. It does
  // not travel in clear text, and `localhost` is somebody's laptop rather than a dashboard.
  if (parsed.protocol !== "https:") return "SUPPORT_WEBHOOK_URL must be https";
  return null;
}

export function supportWebhookConfigured(): boolean {
  return supportWebhookProblem() === null;
}

/** The HMAC a receiver checks against the RAW body. */
export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Post one case. Never throws, the caller is usually a webhook that must still answer 200. */
export async function postSupportTicket(ticket: SupportTicketPayload): Promise<PostResult> {
  const problem = supportWebhookProblem();
  if (problem) return { ok: false, id: ticket.id, error: `not-configured: ${problem}` };

  const url = (process.env.SUPPORT_WEBHOOK_URL ?? "").trim();
  const secret = (process.env.SUPPORT_WEBHOOK_SECRET ?? "").trim();
  const body = JSON.stringify(ticket);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "x-fleetwise-signature": signPayload(body, secret) } : {}),
      },
      body,
      // A dashboard that hangs must not hang the Paystack webhook waiting on it, Paystack
      // retries a non-200 for 72 hours, and the ledger work has already happened by now.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, id: ticket.id, error: `${res.status}${detail ? `: ${detail}` : ""}` };
    }
    return { ok: true, id: ticket.id };
  } catch (err) {
    return {
      ok: false,
      id: ticket.id,
      error: err instanceof Error ? err.message.slice(0, 200) : "unknown",
    };
  }
}

export type PostSummary = { considered: number; posted: number; failed: number; skipped: string | null };

/**
 * Post everything still waiting. Runs on the nightly billing pass, so a case that could not
 * be delivered when it arrived is delivered as soon as the dashboard is reachable again.
 */
export async function postDueSupportTickets(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<PostSummary> {
  const problem = supportWebhookProblem();
  if (problem) return { considered: 0, posted: 0, failed: 0, skipped: problem };

  // Thrown, so the billing run reports the step as an error. It used to answer "skipped"
  // with the database's words, so a failed read looked like a pass with nothing to do, and
  // nobody heard of it.
  const data = must(
    await supabase.rpc("support_tickets_to_post", {
      p_limit: opts.limit ?? 50,
    }),
    "support:tickets-to-post",
  );

  const rows = (data ?? []) as { id: string }[];
  let posted = 0;
  let failed = 0;

  for (const row of rows) {
    // Read the case itself rather than trusting the shortlist to carry it: the evidence is
    // the payload, and the shortlist deliberately returns only ids.
    const { data: full, error: readError } = await supabase
      .from("support_tickets")
      .select("id, kind, status, subject, opened_at, due_at, external_ref, evidence")
      .eq("id", row.id)
      .maybeSingle();
    // Counted as failed either way (it is posted on the next run); a failed read is also
    // reported, so a case stuck on our side is heard of.
    if (readError) captureError(new ReadFailed("support:ticket", readError), { where: "support:ticket" });
    if (!full) {
      failed += 1;
      continue;
    }
    const t = full as Omit<SupportTicketPayload, "source">;
    const result = await postSupportTicket({ ...t, source: "fleetwise" });
    const { error: recordError } = await supabase.rpc("record_support_ticket_post", {
      p_ticket: row.id,
      p_error: result.ok ? null : result.error,
    });
    // The count still says what the post did; an unrecorded outcome means the case is
    // posted again next run (the receiver upserts on id), so it is reported, not fatal.
    if (recordError) {
      captureError(recordError, { where: "support:record-post", extra: { code: recordError.code ?? null } });
    }
    if (result.ok) posted += 1;
    else failed += 1;
  }

  return { considered: rows.length, posted, failed, skipped: null };
}
