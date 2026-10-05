/** Every kind of paid use, as the `ai_usage.feature` column records it. */
export const AI_FEATURES = [
  "voice_live",
  "voice_second_pass",
  "voice_offline",
  "voice_reply",
  "ai_hearing",
  "ai_answer",
  "canary",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export type GatewayCallContext = {
  farmId: string;
  /** Null only for the platform's own canary. */
  userId: string | null;
  feature: AiFeature;
  zeroDataRetention?: boolean;
};

/**
 * The Vercel AI Gateway options every call on the PLATFORM's credential carries.
 *
 * `user` and `tags` make the Gateway's own spend report (getSpendReport, grouped by user
 * or tag) line up with the ledger, which is how the month is reconciled. A farm's own
 * OpenAI key never rides on a Gateway request (request-scoped BYOK falls back to the
 * platform's credentials when the key fails): own-key calls go to OpenAI directly
 * (openai-direct.ts).
 */
export function gatewayOptions(context: GatewayCallContext): Record<string, unknown> {
  const options: Record<string, unknown> = {
    user: context.userId ?? `platform:${context.feature}`,
    tags: [`farm:${context.farmId}`, `feature:${context.feature}`],
  };
  // Vercel routes zero-data-retention only on Pro and Enterprise; Hobby refuses it outright.
  if (context.zeroDataRetention) options.zeroDataRetention = true;
  return options;
}
