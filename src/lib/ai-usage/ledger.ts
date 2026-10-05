import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import type { AiOutcome } from "./outcome";

/**
 * The server's side of the AI and voice ledger (supabase/migrations/20261004100000).
 *
 * Every paid call takes a hold BEFORE the provider is called and settles it after, with
 * the service role, passing the farm and the person from the signed-in session. If a hold
 * cannot be taken (the database refuses or cannot be reached), the call is not made: the
 * limit fails closed. A settlement that cannot be written is left to the nightly sweep,
 * which closes the hold as "unknown" and bills nothing.
 *
 * The owners' 80% and limit notices are queued by the database in the same transaction
 * that decides them (app.ai_notify_owners), so nothing here delivers them.
 */

export type AiFeature = "voice" | "ai_hearing" | "ai_answer";
export type Credential = "platform" | "farm_openai" | "internal";

export type HoldRefusal =
  | "not_member"
  | "voice_off"
  | "ai_off"
  | "notice_required"
  | "ai_off_for_you"
  | "farm_limit"
  | "member_limit"
  /** The farm's own OpenAI key is broken and its owner chose to pause AI (decided by the server, not the database). */
  | "own_key_broken"
  /** Too many Azure tokens for this person this hour or day (each works for about ten minutes, whatever is reported). */
  | "token_rate"
  | "unavailable";

export type Hold =
  | { ok: true; id: string; credential: Credential; estimateCents: number }
  | { ok: false; reason: HoldRefusal; notifyOwner: boolean; limitCents: number | null; spentCents: number | null };

/** Units of use, named as the ledger's price units expect them. */
export type Units = Partial<
  Record<"audio_ms" | "audio_fixed_ms" | "characters" | "input_tokens" | "output_tokens" | "audio_input_tokens", number>
>;

export type Attempt = {
  model: string;
  outcome: AiOutcome;
  units?: Units;
  /** The Gateway's reported cost in USD, when it gave one; it wins over priced units. */
  costUsd?: number | null;
  measured?: "server" | "gateway" | "client_bounded" | "estimated";
  /** The provider did the work although the call failed (an answer that could not be used): price its units as cost, bill nothing. */
  charged?: boolean;
  errorCode?: string;
  latencyMs?: number;
  generationId?: string | null;
};

const REFUSALS = new Set<HoldRefusal>([
  "not_member", "voice_off", "ai_off", "notice_required", "ai_off_for_you", "farm_limit", "member_limit", "token_rate",
]);

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Whole units only, never negative: the ledger's integer columns. */
function cleanUnits(units: Units | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(units ?? {})) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = Math.round(value);
  }
  return out;
}

/**
 * A cost as a plain decimal string. JSON would write a tiny number in exponent form
 * (1.2e-7), which the ledger also accepts, but a fixed string cannot be misread anywhere.
 */
function costString(cost: number | null | undefined): string | undefined {
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost.toFixed(12) : undefined;
}

function parseHold(data: unknown): Hold {
  const value = (data ?? {}) as Record<string, unknown>;
  if (value.ok === true && typeof value.id === "string") {
    return {
      ok: true,
      id: value.id,
      credential: (value.credential as Credential) ?? "platform",
      estimateCents: num(value.estimate_cents) ?? 0,
    };
  }
  const reason = REFUSALS.has(value.reason as HoldRefusal) ? (value.reason as HoldRefusal) : "unavailable";
  return {
    ok: false,
    reason,
    notifyOwner: value.notify_owner === true,
    limitCents: num(value.limit_cents),
    spentCents: num(value.spent_cents),
  };
}

export async function holdBudget(input: {
  farmId: string;
  userId: string;
  feature: AiFeature;
  model: string;
  units: Units;
  credential?: "platform" | "farm_openai";
}): Promise<Hold> {
  try {
    const { data, error } = await createServiceClient().rpc("ai_reserve", {
      p_farm: input.farmId,
      p_user: input.userId,
      p_feature: input.feature,
      p_model: input.model,
      p_units: cleanUnits(input.units),
      p_credential: input.credential ?? "platform",
    });
    if (error) return { ok: false, reason: "unavailable", notifyOwner: false, limitCents: null, spentCents: null };
    return parseHold(data);
  } catch {
    return { ok: false, reason: "unavailable", notifyOwner: false, limitCents: null, spentCents: null };
  }
}

export type Settlement = { billedCents: number; warn: "80" | null; spentCents: number | null; limitCents: number | null };

/** Settles one hold; tries twice, then leaves it to the nightly sweep. Never throws. */
export async function settleHold(reservationId: string, attempts: Attempt[]): Promise<Settlement | null> {
  const payload = attempts.slice(0, 5).map((attempt) => ({
    model: attempt.model,
    outcome: attempt.outcome,
    units: cleanUnits(attempt.units),
    cost_usd: costString(attempt.costUsd),
    measured: attempt.measured,
    charged: attempt.charged ? true : undefined,
    error_code: attempt.errorCode && /^[a-z0-9_]{1,40}$/.test(attempt.errorCode) ? attempt.errorCode : undefined,
    latency_ms: attempt.latencyMs !== undefined ? Math.max(0, Math.round(attempt.latencyMs)) : undefined,
    generation_id: attempt.generationId ? attempt.generationId.slice(0, 120) : undefined,
  }));
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const { data, error } = await createServiceClient().rpc("ai_settle", { p_reservation: reservationId, p_attempts: payload });
      if (error) continue;
      const value = (data ?? {}) as Record<string, unknown>;
      return {
        billedCents: num(value.billed_cents) ?? 0,
        warn: value.warn === "80" ? "80" : null,
        spentCents: num(value.spent_cents),
        limitCents: num(value.limit_cents),
      };
    } catch {
      // The second try, then the sweep.
    }
  }
  return null;
}

export type VoiceSession =
  | { ok: true; sessionId: string; maxAudioMs: number; maxCharacters: number }
  | { ok: false; reason: HoldRefusal };

/**
 * Opens a metered stretch of Azure voice: a hold sized to what the farm has left, up to the
 * asked-for maximum (supabase ai_open_voice_session). `source` is "token" when the server
 * opens it with an Azure token, "meter" when the browser asks for another.
 */
export async function openVoiceSession(input: {
  farmId: string;
  userId: string;
  maxAudioMs: number;
  maxCharacters: number;
  clientVersion: string | null;
  source: "meter" | "token";
}): Promise<VoiceSession> {
  try {
    const { data, error } = await createServiceClient().rpc("ai_open_voice_session", {
      p_farm: input.farmId,
      p_user: input.userId,
      p_max_audio_ms: Math.max(0, Math.round(input.maxAudioMs)),
      p_max_characters: Math.max(0, Math.round(input.maxCharacters)),
      p_client_version: input.clientVersion ? input.clientVersion.slice(0, 40) : null,
      p_source: input.source,
    });
    if (error) return { ok: false, reason: "unavailable" };
    const value = (data ?? {}) as Record<string, unknown>;
    if (value.ok === true && typeof value.session_id === "string") {
      return {
        ok: true,
        sessionId: value.session_id,
        maxAudioMs: num(value.max_audio_ms) ?? 0,
        maxCharacters: num(value.max_characters) ?? 0,
      };
    }
    const hold = parseHold(value);
    return { ok: false, reason: hold.ok ? "unavailable" : hold.reason };
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Cumulative use on a session. "closed" means the session was already settled (a final
 * report, or the nightly sweep under a tab left open): the browser must open another.
 */
export async function reportVoiceSession(input: {
  sessionId: string;
  userId: string;
  audioMs: number;
  audioFixedMs: number;
  characters: number;
  final: boolean;
}): Promise<"ok" | "closed" | "failed"> {
  try {
    const { data, error } = await createServiceClient().rpc("ai_report_voice_session", {
      p_session: input.sessionId,
      p_user: input.userId,
      p_audio_ms: Math.max(0, Math.round(input.audioMs)),
      p_audio_fixed_ms: Math.max(0, Math.round(input.audioFixedMs)),
      p_characters: Math.max(0, Math.round(input.characters)),
      p_final: input.final,
    });
    const value = (data ?? {}) as Record<string, unknown>;
    if (error || value.ok !== true) return "failed";
    return value.already === true ? "closed" : "ok";
  } catch {
    return "failed";
  }
}

/**
 * An in-app notification (which Web Push also delivers) to every owner of the farm, by
 * home farm or by membership (app.ai_notify_owners). For notices the server decides, such
 * as a farm's own key failing; the limit notices are queued by the database itself.
 */
export async function notifyFarmOwners(farmId: string, template: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await createServiceClient().rpc("ai_notify_owners", { p_farm: farmId, p_template: template, p_payload: payload });
  } catch {
    // A missed notice never blocks the call it is about.
  }
}
