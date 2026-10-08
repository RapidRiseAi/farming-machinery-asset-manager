/**
 * What an action on the owner's AI and voice page (/settings/ai) or Rapid Rise's AI page
 * (/admin/ai) came to, carried back as `?ai=<code>` and shown in words from
 * `aiUsage.result.<code>`.
 *
 * The page translates its own codes rather than adding them to src/lib/errors.ts, and a
 * unit test keeps every code here present in both dictionaries, which is the guarantee the
 * errors gate gives the rest of the product: nobody is shown a raw code.
 */
export const AI_RESULTS = {
  "limit-saved": "success",
  "limit-out-of-range": "error",
  "limit-trial": "warning",
  "limit-invalid": "error",
  "member-limit-saved": "success",
  "member-limit-removed": "success",
  "switches-saved": "success",
  "key-linked": "success",
  "key-linked-no-quota": "warning",
  "key-invalid": "error",
  "key-format": "error",
  "key-storage-unavailable": "error",
  "key-check-unavailable": "error",
  "key-checked": "success",
  "key-removed": "success",
  "key-rate-limited": "error",
  "margin-saved": "success",
  "fx-saved": "success",
  "invoicing-saved": "success",
  "invoicing-past": "error",
  "event-resolved": "success",
  "price-accepted": "success",
  "admin-invalid": "error",
  "forbidden": "error",
  "farm-changed": "warning",
  "failed": "error",
} as const;

export type AiResult = keyof typeof AI_RESULTS;

export function aiResult(raw: string | undefined): { code: AiResult; tone: (typeof AI_RESULTS)[AiResult] } | null {
  return raw && raw in AI_RESULTS ? { code: raw as AiResult, tone: AI_RESULTS[raw as AiResult] } : null;
}
