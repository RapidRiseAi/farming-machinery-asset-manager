import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { KeySecretMismatch, keySecretConfigured, openFarmKey } from "./key-crypto";
import { notifyFarmOwners } from "./ledger";

/**
 * A farm's own OpenAI key, read for one call and never kept beyond it.
 *
 * Only the service role can read farm_ai_keys; signed-in users have no grant on the table
 * at all. The plaintext exists only in this request's memory: it is never logged, never
 * returned to the browser, and errors that might carry it are reduced to a code first.
 */
export type OwnKeyFallback = "pause" | "platform";

/**
 * - `none`: no key linked; the platform's credential, billed.
 * - `active`: the key, for OpenAI models.
 * - `broken`: linked but refused, out of quota or unreadable; the owner's `fallback` says
 *   whether AI pauses or carries on billed on ours.
 * - `unavailable`: the key could not be read. Fails closed: AI is skipped for this
 *   request, never quietly billed on ours against a farm that linked its own key.
 */
export type FarmKey =
  | { state: "none" }
  | { state: "active"; key: string; fallback: OwnKeyFallback }
  | { state: "broken"; fallback: OwnKeyFallback }
  | { state: "unavailable" };

export async function loadFarmOpenAiKey(farmId: string): Promise<FarmKey> {
  try {
    const service = createServiceClient();
    const [keyRes, settingsRes] = await Promise.all([
      service.from("farm_ai_keys").select("ciphertext, status").eq("farm_id", farmId).maybeSingle(),
      service.from("farm_ai_settings").select("own_key_fallback").eq("farm_id", farmId).maybeSingle(),
    ]);
    if (keyRes.error || settingsRes.error) return { state: "unavailable" };
    const row = keyRes.data;
    if (!row) return { state: "none" };
    const fallback: OwnKeyFallback = settingsRes.data?.own_key_fallback === "platform" ? "platform" : "pause";
    if (row.status !== "active") return { state: "broken", fallback };
    if (!keySecretConfigured()) return { state: "unavailable" };
    try {
      return { state: "active", key: openFarmKey(String(row.ciphertext), farmId), fallback };
    } catch (error) {
      // Sealed under another deployment's secret (a Preview, a local copy, a rotation not
      // re-sealed, all on one database): this deployment's problem, not the farm's. Fail
      // closed and change nothing, or one misconfigured copy would break every farm's key.
      if (error instanceof KeySecretMismatch) return { state: "unavailable" };
      // Sealed under this very secret and still will not open: the value is damaged and
      // the owner must link it again. Mark it, so their page says so, and tell them once.
      await markFarmKeyFailed(farmId, "farm_key_unreadable");
      return { state: "broken", fallback };
    }
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * Marks a farm's key broken after the provider refused it, and tells the owners once: the
 * update only changes an ACTIVE key, so a burst of failed calls sends one notice.
 */
export async function markFarmKeyFailed(
  farmId: string,
  code: "farm_key_refused" | "farm_key_quota" | "farm_key_unreadable",
): Promise<void> {
  try {
    const service = createServiceClient();
    const status = code === "farm_key_quota" ? "no_quota" : "invalid";
    const { data } = await service
      .from("farm_ai_keys")
      .update({ status, last_error_code: code, checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("farm_id", farmId)
      .eq("status", "active")
      .select("farm_id");
    if (data?.length) {
      const { data: settings } = await service.from("farm_ai_settings").select("own_key_fallback").eq("farm_id", farmId).maybeSingle();
      await notifyFarmOwners(farmId, "ai_key_failed", {
        reason: code === "farm_key_quota" ? "quota" : code === "farm_key_unreadable" ? "unreadable" : "refused",
        fallback: settings?.own_key_fallback === "platform" ? "platform" : "pause",
      });
    }
    // The update changed nothing when the key was already marked: one notice per failure.
  } catch {
    // Best effort: the next call will try the key again and land here again.
  }
}
