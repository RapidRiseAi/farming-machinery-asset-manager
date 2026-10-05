import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { gateway } from "ai";
import { configuredLlmFallbackModel } from "@/lib/assistant/llm";
import { configuredTranscribeModels } from "@/lib/assistant/transcription";
import { openHealthEvent, resolveHealthEvents } from "./health";

/**
 * The AI and voice ledger's nightly upkeep (docs/AI_USAGE.md), run by /api/cron/nightly.
 *
 * Prices and the exchange rate decide every farm's bill, so nothing is taken from a feed
 * blindly: a new value within BAND of the last is taken; one outside it (a parse error, a
 * unit change, a bad rate) is held as a health event for a platform admin to confirm on
 * /admin/ai, and the old value stays in force. A price of 0 is never taken.
 */
const BAND = 0.25;
const FX_URL = "https://api.frankfurter.app/latest?from=USD&to=ZAR";
const MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const FETCH_TIMEOUT_MS = 10_000;

const withinBand = (proposed: number, current: number) => current > 0 && Math.abs(proposed / current - 1) <= BAND;

/** The day's ECB USD to ZAR rate (frankfurter, no key). */
export async function refreshFxRate(supabase: SupabaseClient): Promise<string> {
  const response = await fetch(FX_URL, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`fx feed answered ${response.status}`);
  const body = (await response.json()) as { date?: unknown; rates?: { ZAR?: unknown } };
  const rate = Number(body.rates?.ZAR);
  const day = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  if (!(rate > 0) || !day) throw new Error("fx feed returned no usable rate");

  const { data: last } = await supabase.from("fx_rates").select("day, usd_zar").order("day", { ascending: false }).limit(1).maybeSingle();
  if (last && !withinBand(rate, Number(last.usd_zar))) {
    await openHealthEvent(supabase, "fx_stale", "usd_zar", { proposed: rate, current: Number(last.usd_zar), day });
    return `ok (held: ${rate} is outside the band of ${last.usd_zar})`;
  }
  await supabase.from("fx_rates").upsert({ day, usd_zar: rate.toFixed(4), source: "ecb" }, { onConflict: "day", ignoreDuplicates: true });
  await resolveHealthEvents(supabase, "fx_stale");
  return `ok (${day} ${rate})`;
}

/** The Gateway's public price for each pricing field, mapped to the ledger's units. */
const UNIT_FIELDS: Record<string, string> = {
  transcription_duration_cost_per_second: "audio_second",
  input: "input_token",
  output: "output_token",
  audio_input_token_cost: "audio_input_token",
};

/** Prices for the models this deployment actually uses, from the Gateway's public list. */
export async function refreshPrices(supabase: SupabaseClient): Promise<string> {
  const models = new Set(
    [
      ...configuredTranscribeModels(),
      process.env.LLM_MODEL?.trim(),
      process.env.ASSISTANT_BYOK_LLM_MODEL?.trim() || "openai/gpt-5-mini",
      configuredLlmFallbackModel(process.env.LLM_MODEL?.trim() ?? ""),
    ].filter((model): model is string => Boolean(model)),
  );
  const response = await fetch(MODELS_URL, { cache: "no-store", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`model list answered ${response.status}`);
  const list = ((await response.json()) as { data?: { id?: string; pricing?: Record<string, unknown> }[] }).data ?? [];

  let taken = 0;
  let held = 0;
  for (const model of models) {
    const pricing = list.find((entry) => entry.id === model)?.pricing;
    // Priced means a price on file for this model, whatever the feed says: an unpriced
    // model is billed at ai_price_units' deliberately high default and must be flagged.
    const onFile = async () =>
      ((await supabase.from("ai_prices").select("model", { count: "exact", head: true }).eq("model", model)).count ?? 0) > 0;
    if (!pricing) {
      if (!(await onFile())) await openHealthEvent(supabase, "model_unpriced", model, { reason: "not in the Gateway list and no price on file" });
      continue;
    }
    for (const [field, unit] of Object.entries(UNIT_FIELDS)) {
      const proposed = Number(pricing[field]);
      if (!(proposed > 0)) continue;
      const { data: current } = await supabase
        .from("ai_prices")
        .select("usd_per_unit")
        .eq("model", model)
        .eq("unit", unit)
        .order("effective_from", { ascending: false })
        .limit(1)
        .maybeSingle();
      const now = current ? Number(current.usd_per_unit) : null;
      if (now !== null && Math.abs(proposed / now - 1) < 1e-6) continue;
      if (now !== null && !withinBand(proposed, now)) {
        await openHealthEvent(supabase, "price_pending", `${model} ${unit}`, { proposed, current: now });
        held += 1;
        continue;
      }
      await supabase.from("ai_prices").insert({ model, unit, usd_per_unit: proposed, source: "gateway" });
      taken += 1;
    }
    if (await onFile()) await resolveHealthEvents(supabase, "model_unpriced", model);
    else await openHealthEvent(supabase, "model_unpriced", model, { reason: "listed by the Gateway with no price field this job reads" });
  }
  return `ok (${taken} new, ${held} held)`;
}

/** The Gateway credit balance; low credit means AI will soon stop for every farm. */
export async function checkGatewayCredits(supabase: SupabaseClient): Promise<string> {
  let balance: number;
  try {
    balance = Number((await gateway.getCredits()).balance);
  } catch {
    return "skipped (credit balance unavailable here)";
  }
  if (!Number.isFinite(balance)) return "skipped (credit balance unreadable)";
  const threshold = Number(process.env.AI_GATEWAY_LOW_CREDIT_USD ?? 5);
  if (balance < threshold) await openHealthEvent(supabase, "low_credit", "gateway", { balance_usd: balance, threshold_usd: threshold });
  else await resolveHealthEvents(supabase, "low_credit");
  return `ok (balance $${balance.toFixed(2)})`;
}

type ModelWindow = { model: string; ai_calls: number; ai_failed: number; no_credit: number; rows: number; clamped: number };

/**
 * The last 24 hours per model, counted in the database (ai_ops_window), so a busy day is
 * counted whole rather than cut off at the API's row cap:
 *
 * - failure rates on the PLATFORM credential only (one farm's broken key is that farm's
 *   problem, and its owner is told, not a provider outage);
 * - rows clamped to their hold: now and then is rounding, often means the hold for that
 *   model is not an upper bound and farms are billed below what the calls cost.
 */
export async function detectModelFailures(supabase: SupabaseClient): Promise<string> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data, error } = await supabase.rpc("ai_ops_window", { p_since: since });
  if (error) throw new Error(error.message);
  const models = ((data ?? []) as ModelWindow[]).map((row) => ({
    model: String(row.model),
    aiCalls: Number(row.ai_calls) || 0,
    aiFailed: Number(row.ai_failed) || 0,
    noCredit: Number(row.no_credit) || 0,
    rows: Number(row.rows) || 0,
    clamped: Number(row.clamped) || 0,
  }));
  let flagged = 0;
  let clampedModels = 0;
  let noCredit = 0;
  for (const m of models) {
    noCredit += m.noCredit;
    if (m.aiCalls >= 8 && m.aiFailed / m.aiCalls > 0.25) {
      await openHealthEvent(supabase, "model_failures", m.model, { total: m.aiCalls, failed: m.aiFailed });
      flagged += 1;
    } else {
      await resolveHealthEvents(supabase, "model_failures", m.model);
    }
    if (m.rows >= 8 && m.clamped / m.rows > 0.05) {
      await openHealthEvent(supabase, "holds_clamped", m.model, { rows: m.rows, clamped: m.clamped });
      clampedModels += 1;
    } else if (m.rows >= 8) {
      await resolveHealthEvents(supabase, "holds_clamped", m.model);
    }
  }
  if (noCredit) await openHealthEvent(supabase, "no_credit", "gateway", { calls_refused: noCredit });
  return `ok (${models.length} model(s), ${flagged} failing, ${clampedModels} clamped)`;
}

type TokenWindow = { farm_id: string; user_id: string; tokens: number; reported_ms: number; reported_characters: number };

/**
 * Voice the server cannot see. An Azure token works on the whole Speech resource for about
 * ten minutes whatever its session reports, so the ledger is only as honest as the app
 * that reports to it. Someone who took ten or more tokens in a day and reported under five
 * seconds of speech and fifty characters per token is flagged for a person to look at:
 * that is the pattern of a client that takes tokens and does not meter. The monthly
 * reconciliation against the Azure bill (release B) is the backstop.
 */
export async function detectVoiceUnderReporting(supabase: SupabaseClient): Promise<string> {
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { data, error } = await supabase.rpc("ai_voice_token_window", { p_since: since });
  if (error) throw new Error(error.message);
  let flagged = 0;
  for (const row of (data ?? []) as TokenWindow[]) {
    const tokens = Number(row.tokens) || 0;
    const reportedSeconds = (Number(row.reported_ms) || 0) / 1000;
    const characters = Number(row.reported_characters) || 0;
    if (tokens >= 10 && reportedSeconds < tokens * 5 && characters < tokens * 50) {
      await openHealthEvent(supabase, "voice_underreported", `user:${row.user_id}`, {
        farm_id: row.farm_id,
        tokens,
        reported_seconds: Math.round(reportedSeconds),
        characters,
      });
      flagged += 1;
    }
  }
  return `ok (${flagged} flagged)`;
}
