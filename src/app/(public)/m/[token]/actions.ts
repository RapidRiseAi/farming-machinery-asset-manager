"use server";

import { redirect } from "next/navigation";
import { FUEL_ACTIVITIES } from "@/lib/fuel";
import { parseRandsToCents } from "@/lib/money";
import { createServiceClient } from "@/lib/supabase/service";

type QrCaptureError =
  | "invalid_reading"
  | "reading_backwards"
  | "invalid_fuel"
  | "upgrade"
  | "rate_limited"
  | "not_found"
  | "unavailable";

type QrRpcResult = { ok?: boolean; error?: unknown };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_ERRORS = new Set<QrCaptureError>([
  "invalid_reading",
  "reading_backwards",
  "invalid_fuel",
  "upgrade",
  "rate_limited",
  "not_found",
]);

function qrHref(token: string, key: "error" | "sent", value: string): string {
  const routeToken = encodeURIComponent(token || "invalid");
  return `/m/${routeToken}?${key}=${encodeURIComponent(value)}`;
}

/**
 * Invoke one guarded database capture and turn every unexpected failure into a stable,
 * translated UI state. `redirect()` stays outside this helper because Next implements
 * it by throwing; catching that throw is an easy way to accidentally mask success.
 */
async function runCapture(
  rpc: "record_public_qr_reading" | "record_public_qr_fuel",
  args: Record<string, unknown>,
): Promise<QrCaptureError | null> {
  try {
    const svc = createServiceClient();
    const { data, error } = await svc.rpc(rpc, args);
    if (error) {
      // Keep database details in server logs; the public page receives no raw SQL text.
      console.error("[public-qr] capture RPC failed", { rpc, code: error.code });
      return "unavailable";
    }

    const result = data as QrRpcResult | null;
    if (result?.ok === true) return null;
    if (typeof result?.error === "string" && EXPECTED_ERRORS.has(result.error as QrCaptureError)) {
      return result.error as QrCaptureError;
    }

    console.error("[public-qr] capture RPC returned an unexpected result", { rpc });
    return "unavailable";
  } catch (error) {
    console.error("[public-qr] capture RPC was unavailable", {
      rpc,
      cause: error instanceof Error ? error.name : "unknown",
    });
    return "unavailable";
  }
}

/** Anonymous meter reading via QR, resolved and committed atomically in Postgres. */
export async function submitReading(formData: FormData) {
  const token = String(formData.get("token") ?? "").trim();
  const readingRaw = String(formData.get("reading") ?? "").trim();
  const reading = Number(readingRaw);
  const reporter = String(formData.get("name") ?? "").trim() || null;

  if (!UUID_PATTERN.test(token)) redirect(qrHref(token, "error", "not_found"));
  if (
    !readingRaw ||
    !Number.isFinite(reading) ||
    reading < 0 ||
    reading > 99_999_999_999.9 ||
    (reporter?.length ?? 0) > 200
  ) {
    redirect(qrHref(token, "error", "invalid_reading"));
  }

  const failure = await runCapture("record_public_qr_reading", {
    p_token: token,
    p_reading: reading,
    p_reporter: reporter,
  });
  if (failure) redirect(qrHref(token, "error", failure));

  redirect(qrHref(token, "sent", "reading"));
}

/** Anonymous fuel draw via QR, including tank resolution and usage attribution. */
export async function submitFuel(formData: FormData) {
  const token = String(formData.get("token") ?? "").trim();
  const litresRaw = String(formData.get("litres") ?? "").trim();
  const litres = Number(litresRaw);
  const meterRaw = String(formData.get("reading") ?? "").trim();
  const meter = meterRaw === "" ? null : Number(meterRaw);
  const driver = String(formData.get("name") ?? "").trim() || null;
  const activityRaw = String(formData.get("activity") ?? "").trim();
  const activity = activityRaw || null;
  const costRaw = String(formData.get("cost") ?? "").trim();
  const inclCents = parseRandsToCents(costRaw);

  if (!UUID_PATTERN.test(token)) redirect(qrHref(token, "error", "not_found"));
  if (
    !litresRaw ||
    !Number.isFinite(litres) ||
    litres <= 0 ||
    litres > 99_999_999_999.9 ||
    (meter != null && (!Number.isFinite(meter) || meter < 0 || meter > 99_999_999_999.9)) ||
    (driver?.length ?? 0) > 200 ||
    (activity != null && !(FUEL_ACTIVITIES as readonly string[]).includes(activity)) ||
    (costRaw !== "" && (inclCents == null || inclCents < 0 || !Number.isSafeInteger(inclCents)))
  ) {
    redirect(qrHref(token, "error", "invalid_fuel"));
  }

  const failure = await runCapture("record_public_qr_fuel", {
    p_token: token,
    p_litres: litres,
    p_meter_reading: meter,
    p_driver: driver,
    p_activity: activity,
    p_cost_incl_cents: inclCents,
  });
  if (failure) redirect(qrHref(token, "error", failure));

  redirect(qrHref(token, "sent", "fuel"));
}
