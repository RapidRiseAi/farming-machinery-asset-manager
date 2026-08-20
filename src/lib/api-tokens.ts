import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * The public API is the deliberate exception to FleetWise's usual RLS boundary.
 * API keys are not Supabase user sessions, so every service-role query MUST pass
 * through this module. The credential derives the farm; no public route accepts a
 * farm id. Keep this resource map closed and every projection intentionally small.
 */

export const API_RESOURCES = {
  machines: {
    table: "machines",
    columns:
      "id,name,type,make,model,year,serial_no,reg_no,meter_type,status,current_reading,current_reading_date,warranty_expiry_date,warranty_expiry_hours,location,cost_centre,department,created_at",
    machineFilter: null,
    statusFilter: "status",
    dateColumn: "created_at",
    dateOnly: false,
  },
  "meter-readings": {
    table: "meter_readings",
    columns: "id,machine_id,reading,reading_date,source,created_at",
    machineFilter: "machine_id",
    statusFilter: null,
    dateColumn: "reading_date",
    dateOnly: true,
  },
  "service-plan-lines": {
    table: "service_plan_lines",
    columns:
      "id,machine_id,task,interval_hours,interval_months,last_done_reading,last_done_date,next_due_reading,next_due_date,status,created_at",
    machineFilter: "machine_id",
    statusFilter: "status",
    dateColumn: "created_at",
    dateOnly: false,
  },
  faults: {
    table: "faults",
    columns:
      "id,machine_id,description,category,urgency,status,job_card_id,created_at,resolved_at",
    machineFilter: "machine_id",
    statusFilter: "status",
    dateColumn: "created_at",
    dateOnly: false,
  },
  "job-cards": {
    table: "job_cards",
    columns:
      "id,machine_id,created_from_fault_id,type,status,date_in,date_out,meter_reading,reported_problem,diagnosis,work_performed,recommendations,vat_rate_bps,parts_total_cents,labour_total_cents,other_total_cents,total_cents,approved_at,locked,created_at",
    machineFilter: "machine_id",
    statusFilter: "status",
    dateColumn: "created_at",
    dateOnly: false,
  },
  "cost-entries": {
    table: "cost_entries",
    columns:
      "id,machine_id,type,amount_cents,vat_rate_bps,source_type,source_id,occurred_on,note,created_at",
    machineFilter: "machine_id",
    statusFilter: null,
    dateColumn: "occurred_on",
    dateOnly: true,
  },
} as const;

export type ApiResource = keyof typeof API_RESOURCES;
export type ApiScope = "read" | "write:readings";

type ApiResourceConfig = {
  table: string;
  columns: string;
  machineFilter: string | null;
  statusFilter: string | null;
  dateColumn: string;
  dateOnly: boolean;
};

function resourceConfig(resource: ApiResource): ApiResourceConfig {
  return API_RESOURCES[resource];
}

declare const API_CONTEXT_BRAND: unique symbol;
export type ApiContext = {
  readonly tokenId: string;
  readonly farmId: string;
  readonly scopes: readonly ApiScope[];
  readonly farmPlan: string;
  readonly [API_CONTEXT_BRAND]: true;
};

type ServiceClient = ReturnType<typeof createServiceClient>;
type TestableServiceClient = Pick<SupabaseClient, "from" | "rpc">;

export class PublicApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly authenticate?: string,
  ) {
    super(message);
    this.name = "PublicApiError";
  }
}

type TokenResolution = {
  token_id: string;
  farm_id: string;
  scopes: string[];
  farm_plan: string;
  api_allowed: boolean;
};

export type ApiListParams = {
  limit: number;
  offset: number;
  machineId: string | null;
  status: string | null;
  from: string | null;
  to: string | null;
};

export type ApiReadingInput = {
  machineId: string;
  reading: number;
  readingDate: string;
};

const TOKEN_PATTERN = /^fwk_[A-Za-z0-9_-]{20,128}$/;
// PostgreSQL's uuid type accepts the canonical 8-4-4-4-12 hexadecimal shape
// without requiring an RFC version/variant nibble. Several legacy FleetWise rows
// intentionally use zero-filled UUIDs, so validate the database shape exactly.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const STATUS_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MAX_BODY_BYTES = 16 * 1024;
const DB_TIMEOUT_MS = 10_000;

function apiSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(DB_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function unauthorized(): PublicApiError {
  return new PublicApiError(
    401,
    "invalid_token",
    "Supply a live FleetWise API token in the Authorization bearer header.",
    'Bearer realm="FleetWise API", error="invalid_token"',
  );
}

function validUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isApiResource(value: string): value is ApiResource {
  return Object.prototype.hasOwnProperty.call(API_RESOURCES, value);
}

export function parseBearerToken(header: string | null): string {
  if (!header) throw unauthorized();
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  if (!match || !TOKEN_PATTERN.test(match[1])) throw unauthorized();
  return match[1];
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Generate a 256-bit token. Persist only hash and prefix; show token once. */
export function mintApiToken(entropy: Buffer = randomBytes(32)) {
  if (entropy.length !== 32) throw new Error("API token entropy must be exactly 32 bytes.");
  const secret = entropy.toString("base64url");
  const token = `fwk_${secret}`;
  return {
    token,
    tokenHash: hashApiToken(token),
    prefix: `fwk_${secret.slice(0, 8)}`,
  };
}

function asTokenResolution(value: unknown): TokenResolution | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<TokenResolution>;
  if (
    typeof row.token_id !== "string" ||
    !validUuid(row.token_id) ||
    typeof row.farm_id !== "string" ||
    !validUuid(row.farm_id) ||
    !Array.isArray(row.scopes) ||
    !row.scopes.every((scope) => scope === "read" || scope === "write:readings") ||
    typeof row.farm_plan !== "string" ||
    typeof row.api_allowed !== "boolean"
  ) {
    return null;
  }
  return row as TokenResolution;
}

/** Resolve token -> farm. There is intentionally no farm argument. */
export async function authenticateApiRequest(
  request: Request,
  client: TestableServiceClient = createServiceClient(),
): Promise<ApiContext> {
  const token = parseBearerToken(request.headers.get("authorization"));
  const { data, error } = await client
    .rpc("api_token_resolve", { p_token_hash: hashApiToken(token) })
    .abortSignal(apiSignal(request.signal));

  if (error) {
    throw new PublicApiError(503, "service_unavailable", "The API is temporarily unavailable.");
  }

  const raw = Array.isArray(data) ? data[0] : data;
  if (raw == null) throw unauthorized();
  const row = asTokenResolution(raw);
  if (!row) {
    throw new PublicApiError(503, "service_unavailable", "The API is temporarily unavailable.");
  }
  if (!row.api_allowed) {
    throw new PublicApiError(
      403,
      "api_plan_required",
      "This farm's current plan does not include public API access.",
    );
  }

  return {
    tokenId: row.token_id,
    farmId: row.farm_id,
    scopes: row.scopes as ApiScope[],
    farmPlan: row.farm_plan,
  } as unknown as ApiContext;
}

export function requireApiScope(context: ApiContext, scope: ApiScope): void {
  if (context.scopes.includes(scope)) return;
  throw new PublicApiError(
    403,
    "insufficient_scope",
    `This token requires the ${scope} scope for that operation.`,
    `Bearer realm="FleetWise API", error="insufficient_scope", scope="${scope}"`,
  );
}

function parseInteger(value: string | null, fallback: number, min: number, max: number, name: string): number {
  if (value == null) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new PublicApiError(400, "invalid_query", `${name} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new PublicApiError(400, "invalid_query", `${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1900 || year > 2100) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function parseApiListParams(url: URL, resource: ApiResource): ApiListParams {
  const config = resourceConfig(resource);
  const allowed = new Set(["limit", "offset", "machine_id", "status", "from", "to"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new PublicApiError(400, "invalid_query", `Unsupported or repeated query parameter: ${key}.`);
    }
  }

  const machineId = url.searchParams.get("machine_id");
  if (
    url.searchParams.has("machine_id") &&
    (!machineId || !config.machineFilter || !validUuid(machineId))
  ) {
    throw new PublicApiError(400, "invalid_query", "machine_id is not valid for this resource.");
  }
  const status = url.searchParams.get("status");
  if (
    url.searchParams.has("status") &&
    (!status || !config.statusFilter || !STATUS_PATTERN.test(status))
  ) {
    throw new PublicApiError(400, "invalid_query", "status is not valid for this resource.");
  }
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (
    (url.searchParams.has("from") && (!from || !validDate(from))) ||
    (url.searchParams.has("to") && (!to || !validDate(to))) ||
    (from && to && from > to)
  ) {
    throw new PublicApiError(400, "invalid_query", "from/to must be valid YYYY-MM-DD dates in order.");
  }

  return {
    limit: parseInteger(url.searchParams.get("limit"), 100, 1, 200, "limit"),
    offset: parseInteger(url.searchParams.get("offset"), 0, 0, 100_000, "offset"),
    machineId,
    status,
    from,
    to,
  };
}

/**
 * The read chokepoint. The farm and soft-delete predicates are applied before a
 * route can add narrower filters. The caller cannot remove PostgREST filters.
 */
export function apiSelect(
  context: ApiContext,
  resource: ApiResource,
  client: ServiceClient = createServiceClient(),
) {
  const config = resourceConfig(resource);
  return client
    .from(config.table)
    .select(config.columns, { count: "exact" })
    .eq("farm_id", context.farmId)
    .is("deleted_at", null);
}

export async function listApiRows(
  context: ApiContext,
  resource: ApiResource,
  url: URL,
  signal?: AbortSignal,
) {
  const config = resourceConfig(resource);
  const params = parseApiListParams(url, resource);
  let query = apiSelect(context, resource)
    .order(config.dateColumn, { ascending: false })
    .order("id", { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  if (params.machineId && config.machineFilter) query = query.eq(config.machineFilter, params.machineId);
  if (params.status && config.statusFilter) query = query.eq(config.statusFilter, params.status);
  if (params.from) query = query.gte(config.dateColumn, params.from);
  if (params.to) {
    query = config.dateOnly
      ? query.lte(config.dateColumn, params.to)
      : query.lt(config.dateColumn, `${nextDate(params.to)}T00:00:00.000Z`);
  }

  const { data, error, count } = await query.abortSignal(apiSignal(signal));
  if (error) {
    throw new PublicApiError(503, "service_unavailable", "The API is temporarily unavailable.");
  }
  return {
    data: data ?? [],
    pagination: {
      limit: params.limit,
      offset: params.offset,
      count: data?.length ?? 0,
      total: count ?? null,
    },
  };
}

export async function getApiRow(
  context: ApiContext,
  resource: ApiResource,
  id: string,
  signal?: AbortSignal,
) {
  if (!validUuid(id)) throw new PublicApiError(400, "invalid_id", "The resource id must be a UUID.");
  const { data, error } = await apiSelect(context, resource)
    .eq("id", id)
    .abortSignal(apiSignal(signal))
    .maybeSingle();
  if (error) {
    throw new PublicApiError(503, "service_unavailable", "The API is temporarily unavailable.");
  }
  if (!data) throw new PublicApiError(404, "not_found", "The requested resource was not found.");
  return data;
}

function southAfricaToday(): string {
  const parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function parseApiReadingInput(value: unknown): ApiReadingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicApiError(400, "invalid_body", "The JSON body must be an object.");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(["machine_id", "reading", "reading_date"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new PublicApiError(400, "invalid_body", `Unsupported field: ${key}.`);
    }
  }
  if (typeof body.machine_id !== "string" || !validUuid(body.machine_id)) {
    throw new PublicApiError(400, "invalid_body", "machine_id must be a UUID.");
  }
  if (
    typeof body.reading !== "number" ||
    !Number.isFinite(body.reading) ||
    body.reading < 0 ||
    body.reading > 99_999_999_999.9 ||
    Math.abs(Math.round(body.reading * 10) - body.reading * 10) > 1e-7
  ) {
    throw new PublicApiError(400, "invalid_body", "reading must be a non-negative number with at most one decimal place.");
  }
  const readingDate = body.reading_date == null ? southAfricaToday() : body.reading_date;
  if (typeof readingDate !== "string" || !validDate(readingDate)) {
    throw new PublicApiError(400, "invalid_body", "reading_date must be a valid YYYY-MM-DD date.");
  }
  return { machineId: body.machine_id, reading: body.reading, readingDate };
}

export async function readApiReadingRequest(request: Request): Promise<ApiReadingInput> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new PublicApiError(415, "unsupported_media_type", "Use application/json.");
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new PublicApiError(413, "body_too_large", "The request body is too large.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new PublicApiError(413, "body_too_large", "The request body is too large.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PublicApiError(400, "invalid_json", "The request body is not valid JSON.");
  }
  return parseApiReadingInput(parsed);
}

export function parseIdempotencyKey(request: Request): string {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!IDEMPOTENCY_PATTERN.test(key)) {
    throw new PublicApiError(
      400,
      "invalid_idempotency_key",
      "Idempotency-Key must be 8-128 letters, numbers, dots, underscores, colons, or hyphens.",
    );
  }
  return key;
}

/** Stable, token-namespaced UUID used as meter_readings.id for retry safety. */
export function apiReadingId(tokenId: string, idempotencyKey: string): string {
  const bytes = createHash("sha256")
    .update("fleetwise-api-reading\0", "utf8")
    .update(tokenId, "utf8")
    .update("\0", "utf8")
    .update(idempotencyKey, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type ReadingRow = {
  id: string;
  machine_id: string;
  reading: number | string;
  reading_date: string;
  source: string;
  created_at: string;
};

function sameReading(row: ReadingRow, input: ApiReadingInput): boolean {
  return (
    row.machine_id === input.machineId &&
    Number(row.reading) === input.reading &&
    row.reading_date === input.readingDate &&
    row.source === "api"
  );
}

export async function insertApiReading(
  context: ApiContext,
  input: ApiReadingInput,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  const client = createServiceClient();
  const id = apiReadingId(context.tokenId, idempotencyKey);
  const { data, error } = await client
    .from("meter_readings")
    .insert({
      id,
      farm_id: context.farmId,
      machine_id: input.machineId,
      reading: input.reading,
      reading_date: input.readingDate,
      source: "api",
      by_user: null,
    })
    .select(API_RESOURCES["meter-readings"].columns)
    .abortSignal(apiSignal(signal))
    .single();

  if (!error && data) return { data: data as ReadingRow, replayed: false };
  const code = (error as { code?: string } | null)?.code;
  if (code === "23503") {
    throw new PublicApiError(404, "machine_not_found", "The machine was not found for this token's farm.");
  }
  if (code !== "23505") {
    throw new PublicApiError(503, "service_unavailable", "The API is temporarily unavailable.");
  }

  // A retry maps to the same primary key. Return the original only when its body is
  // identical; reusing a key for a different reading is an explicit conflict.
  const { data: existing, error: existingError } = await apiSelect(context, "meter-readings", client)
    .eq("id", id)
    .abortSignal(apiSignal(signal))
    .maybeSingle();
  if (existingError) {
    throw new PublicApiError(503, "service_unavailable", "The API is temporarily unavailable.");
  }
  if (!existing || !sameReading(existing as unknown as ReadingRow, input)) {
    throw new PublicApiError(
      409,
      "idempotency_conflict",
      "That Idempotency-Key was already used for a different request.",
    );
  }
  return { data: existing as unknown as ReadingRow, replayed: true };
}

export function publicApiResponse(body: unknown, requestId: string, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

export function publicApiErrorResponse(error: unknown, requestId: string): Response {
  const known = error instanceof PublicApiError;
  const apiError = known
    ? error
    : new PublicApiError(500, "internal_error", "The API could not complete the request.");
  if (!known) console.error(`[api/v1] request ${requestId} failed`, error);
  const response = publicApiResponse(
    { error: { code: apiError.code, message: apiError.message }, request_id: requestId },
    requestId,
    apiError.status,
  );
  if (apiError.authenticate) response.headers.set("WWW-Authenticate", apiError.authenticate);
  return response;
}
