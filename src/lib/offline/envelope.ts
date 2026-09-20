import { parseRandsToCents } from "@/lib/money";
import type { MutationScope, MutationType } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = ["log_reading", "report_fault", "add_job_line", "complete_job", "log_fuel", "submit_checklist"];
/** A checklist carries every answer in one field, so it cannot live under the 2 000-character
 *  cap the other fields use. The whole payload is still capped, here and in the database. */
const LONG_FIELDS = new Set(["values"]);

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
      || Object.entries(value).some(([k, v]) =>
        typeof v !== "string" || v.length > (LONG_FIELDS.has(k) ? 15000 : 2000))
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
  if (type === "log_fuel") {
    // Same conversion the job-card line gets: the farmer types rands, the database stores
    // VAT-inclusive cents and works the ex-VAT figure out itself.
    const cost = parseRandsToCents(fields.cost);
    if ((fields.cost?.trim() && cost == null) || (cost != null && (!Number.isSafeInteger(cost) || cost < 0))) return null;
    fields = { ...fields, cost_incl_cents: cost == null ? "" : String(cost) };
  }
  return { clientId, clientTs: new Date(captureTime).toISOString(), scope: scope as MutationScope,
    type: type as MutationType, fields, actorId };
}
