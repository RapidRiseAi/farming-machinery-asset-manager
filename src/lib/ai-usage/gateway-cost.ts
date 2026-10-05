/**
 * The cost and generation id the Vercel AI Gateway reports for one call.
 *
 * The SDK passes the Gateway's `providerMetadata` through untouched, so its exact fields
 * are the service's, not the SDK's: read defensively, and when there is no cost the ledger
 * prices the call's units from its own price table instead (and the monthly spend report
 * reconciles the two). Accepts a number or a numeric string.
 */
export function gatewayCallCost(providerMetadata: unknown): { costUsd: number | null; generationId: string | null } {
  const gateway = (providerMetadata as Record<string, unknown> | null | undefined)?.gateway as
    | Record<string, unknown>
    | undefined;
  const raw = gateway?.cost ?? gateway?.totalCost ?? gateway?.marketCost;
  const cost = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  const id = gateway?.generationId ?? gateway?.generation_id ?? gateway?.id;
  return {
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : null,
    generationId: typeof id === "string" && id.length <= 120 ? id : null,
  };
}
