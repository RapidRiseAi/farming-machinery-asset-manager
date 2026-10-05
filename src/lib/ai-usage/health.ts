import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emailConfigured, sendEmail } from "@/lib/email/resend";
import { captureError } from "@/lib/observability";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * AI health events (docs/AI_USAGE.md, "Failure detection"): one open row per kind and
 * subject, raised by the nightly job and, for a problem that must not wait for the night
 * (the Gateway refusing a configured model), by the request that met it.
 */
export type HealthKind =
  | "model_failures" | "no_credit" | "gateway_auth" | "low_credit" | "price_pending"
  | "fx_stale" | "model_unpriced" | "voice_token_failures" | "canary_failed" | "holds_clamped"
  | "voice_underreported";

/**
 * Opens a health event, once: an open event of the same kind and subject already exists,
 * so a repeat night adds nothing (a partial unique index enforces it). A NEW event alerts
 * the founder: the observability layer always, and email when AI_ALERT_EMAIL is set.
 */
export async function openHealthEvent(
  supabase: SupabaseClient,
  kind: HealthKind,
  subject: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabase
    .from("ai_health_events")
    .insert({ kind, subject, detail })
    .select("id")
    .maybeSingle();
  if (error || !data) return; // 23505: already open, already alerted.
  captureError(new Error(`AI health: ${kind}${subject ? ` (${subject})` : ""}`), {
    where: "ai_health",
    extra: { kind, subject, detail: JSON.stringify(detail).slice(0, 500) },
  });
  const to = process.env.AI_ALERT_EMAIL?.trim();
  if (to && emailConfigured()) {
    const lines = [`FleetWise AI health: ${kind}${subject ? ` for ${subject}` : ""}.`, "", JSON.stringify(detail, null, 2), "", "See /admin/ai."];
    const sent = await sendEmail({
      to,
      from: process.env.EMAIL_FROM || "documents@fleetwise.app",
      subject: `FleetWise AI: ${kind.replace(/_/g, " ")}`,
      text: lines.join("\n"),
      html: `<pre>${lines.join("\n").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c)}</pre>`,
    }).catch(() => null);
    if (sent) await supabase.from("ai_health_events").update({ alerted_at: new Date().toISOString() }).eq("id", data.id);
  }
}

export async function resolveHealthEvents(supabase: SupabaseClient, kind: HealthKind, subject?: string): Promise<void> {
  let query = supabase.from("ai_health_events").update({ resolved_at: new Date().toISOString() }).eq("kind", kind).is("resolved_at", null);
  if (subject !== undefined) query = query.eq("subject", subject);
  await query;
}

/**
 * The Gateway refused a configured model on the platform's account (no access on this
 * plan, an unknown model, the credential refused). Raised by the request that met it,
 * not the next night, because every call to that model fails until a person acts. Keeps
 * the Gateway's own message, which on the platform's account carries no farm key (key
 * shapes are scrubbed regardless). Never throws.
 */
export async function reportModelRefused(model: string, error: unknown): Promise<void> {
  try {
    const e = (error ?? {}) as { statusCode?: unknown; message?: unknown };
    const message = String(e.message ?? "").replace(/sk-[A-Za-z0-9_-]+/g, "[key]").slice(0, 300);
    await openHealthEvent(createServiceClient(), "gateway_auth", model, {
      status: typeof e.statusCode === "number" ? e.statusCode : null,
      message,
    });
  } catch {
    // A missed alert never blocks the request it is about.
  }
}
