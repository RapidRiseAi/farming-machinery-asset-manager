"use server";

import { memberQr } from "@/lib/member-qr";

import { redirect } from "next/navigation";
import { FUEL_ACTIVITIES } from "@/lib/fuel";
import { parseRandsToCents } from "@/lib/money";
import { createClient } from "@/lib/supabase/server";
import { rememberName, sentHref } from "./remembered-name";

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

function qrHref(token: string, key: "error", value: string): string {
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
    if (!await memberQr(String(args.p_token ?? ""))) return "not_found";
    const svc = await createClient();
    const { data, error } = await svc.rpc("record_member_qr", {p_token:args.p_token,p_kind:rpc==="record_public_qr_reading"?"reading":"fuel",p_fields:args});
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

/** Member QR reading, resolved and committed atomically in Postgres. */
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

  // Only after the capture succeeded: a failed one should not change what the phone
  // remembers. The confirmation link carries its own time, so it cannot thank anybody
  // again tomorrow.
  await rememberName(reporter);
  redirect(sentHref(token, "reading"));
}

/** Member QR fuel draw, including tank resolution and usage attribution. */
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

  await rememberName(driver);
  redirect(sentHref(token, "fuel"));
}
