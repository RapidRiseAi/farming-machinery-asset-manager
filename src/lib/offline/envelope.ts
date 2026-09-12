import { parseRandsToCents } from "@/lib/money";
import type { MutationScope, MutationType } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ["log_reading", "report_fault", "add_job_line", "complete_job"];

export function parseSyncEnvelope(form: FormData, now = Date.now()) {
  const clientId = String(form.get("client_id") ?? "");
  const clientTs = String(form.get("client_ts") ?? "");
  const scope = String(form.get("scope") ?? "");
  const type = String(form.get("type") ?? "");
  const actorId = String(form.get("actor_id") ?? "");
  const captureTime = Date.parse(clientTs);
  if (!UUID.test(clientId) || !Number.isFinite(captureTime) || captureTime > now + 300000
    || !["app", "public"].includes(scope) || !TYPES.includes(type)
    || (scope === "public" && !["log_reading", "report_fault"].includes(type))) return null;
  const payload = String(form.get("payload") ?? "");
  if (payload.length > 20000) return null;
  let fields: Record<string, string>;
  try {
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.values(value).some(v => typeof v !== "string" || v.length > 2000)
      || Object.keys(value).length > 40) return null;
    fields = value as Record<string, string>;
  } catch { return null; }
  if (type === "add_job_line") {
    const unit = parseRandsToCents(fields.unit_cost);
    const rate = parseRandsToCents(fields.rate);
    if ((fields.unit_cost?.trim() && unit == null) || (fields.rate?.trim() && rate == null)
      || (unit != null && (!Number.isSafeInteger(unit) || unit < 0))
      || (rate != null && (!Number.isSafeInteger(rate) || rate < 0))) return null;
    fields = { ...fields, unit_cost_cents: unit == null ? "" : String(unit), rate_cents: rate == null ? "" : String(rate) };
  }
  return { clientId, clientTs: new Date(captureTime).toISOString(), scope: scope as MutationScope,
    type: type as MutationType, fields, actorId };
}
