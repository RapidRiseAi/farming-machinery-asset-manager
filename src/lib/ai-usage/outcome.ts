/**
 * What happened to one paid AI call, as recorded on its `ai_usage` row.
 *
 * Failures are rows too (at zero cost), so failure rates, the circuit breaker and the
 * founder's alerts all read the same ledger the bill is made from.
 */
export type AiOutcome =
  | "ok"
  | "fallback"
  | "failed"
  | "timeout"
  | "rate_limited"
  | "no_credit"
  | "key_invalid"
  | "cancelled"
  | "unknown";

/** Outcomes that mean the platform itself is misconfigured or out of money: alert at once. */
export const URGENT_OUTCOMES: readonly AiOutcome[] = ["no_credit"];

export type ClassifiedFailure = {
  outcome: Exclude<AiOutcome, "ok" | "fallback" | "unknown">;
  /** Short, redacted, safe to store and show to the founder. */
  code: string;
  /** The platform credential itself was refused (not a farm's own key): alert at once. */
  platformAuth: boolean;
};

type ErrorLike = {
  name?: unknown;
  type?: unknown;
  statusCode?: unknown;
  status?: unknown;
  code?: unknown;
  /** An API call error's parsed body: OpenAI's is `{error: {type, code, message}}`. */
  data?: unknown;
  cause?: unknown;
  lastError?: unknown;
  errors?: unknown;
};

/**
 * The AI SDK wraps provider errors (a retry error holds `lastError` and `errors`, others
 * carry `cause`), so look through the wrappers for the most specific error inside.
 */
function* chain(error: unknown, depth = 0): Generator<ErrorLike> {
  if (!error || typeof error !== "object" || depth > 6) return;
  const e = error as ErrorLike;
  yield e;
  if (e.lastError) yield* chain(e.lastError, depth + 1);
  if (Array.isArray(e.errors)) for (const inner of e.errors.slice(-1)) yield* chain(inner, depth + 1);
  if (e.cause) yield* chain(e.cause, depth + 1);
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const statusOf = (e: ErrorLike) =>
  typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;

/** OpenAI's own error type and code, from the parsed body an API call error carries. */
function bodyError(e: ErrorLike): { type: string; code: string } {
  const inner = (e.data as { error?: { type?: unknown; code?: unknown } } | null | undefined)?.error;
  return { type: text(inner?.type), code: typeof inner?.code === "number" ? String(inner.code) : text(inner?.code) };
}

/** An account that cannot pay for the call: out of credit, quota or billing. */
const OUT_OF_MONEY = /insufficient[_ ]?(funds|credit|balance|quota)|billing_hard_limit_reached|billing_not_active/i;

/**
 * Classifies a failed call. `usingFarmKey` says the call ran on a farm's own OpenAI key
 * (called at OpenAI directly, lib/ai-usage/openai-direct.ts), so an authentication or
 * quota failure is THEIR key's, not ours.
 *
 * Reads each error's `type`, `code`, `statusCode` and parsed body rather than importing
 * provider classes. The quota check comes before the rate-limit check because OpenAI
 * answers an exhausted account with 429 and `insufficient_quota`, which is not a burst
 * that waiting fixes.
 */
export function classifyAiFailure(error: unknown, usingFarmKey = false): ClassifiedFailure {
  for (const e of chain(error)) {
    const name = text(e.name);
    const type = text(e.type);
    const status = statusOf(e);
    const body = bodyError(e);
    if (name === "AbortError" || name === "TimeoutError" || type === "timeout") {
      return { outcome: "timeout", code: "timeout", platformAuth: false };
    }
    if (status === 402 || OUT_OF_MONEY.test(`${type} ${text(e.code)} ${body.type} ${body.code}`)) {
      // On a farm's key an exhausted quota is theirs to fix; on ours it is the founder's.
      return usingFarmKey
        ? { outcome: "key_invalid", code: "farm_key_quota", platformAuth: false }
        : { outcome: "no_credit", code: "gateway_no_credit", platformAuth: false };
    }
    if (type === "rate_limit_exceeded" || status === 429) {
      return { outcome: "rate_limited", code: "rate_limited", platformAuth: false };
    }
    if (type === "authentication_error" || status === 401 || type === "forbidden" || status === 403
        || body.code === "invalid_api_key") {
      return usingFarmKey
        ? { outcome: "key_invalid", code: "farm_key_refused", platformAuth: false }
        : { outcome: "failed", code: "gateway_auth", platformAuth: true };
    }
    if (type === "model_not_found") return { outcome: "failed", code: "model_not_found", platformAuth: false };
    if (type === "invalid_request_error" || status === 400) {
      return { outcome: "failed", code: "invalid_request", platformAuth: false };
    }
    if (type === "internal_server_error" || type === "failed_dependency" || (status !== null && status >= 500)) {
      return { outcome: "failed", code: `provider_${status ?? "error"}`, platformAuth: false };
    }
  }
  return { outcome: "failed", code: "unknown", platformAuth: false };
}
