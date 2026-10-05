"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { accessibleFarms, currentFarmId, effectiveFarmRole, requireProfile, type Profile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { parseRandsToCents } from "@/lib/money";
import { keyHint, looksLikeOpenAiKey, openFarmKey, sealFarmKey } from "@/lib/ai-usage/key-crypto";
import { checkOpenAiKey } from "@/lib/ai-usage/openai-key";
import type { AiResult } from "@/lib/ai-usage/results";

/**
 * The owner's AI and voice actions (docs/AI_USAGE.md).
 *
 * The role is re-checked HERE on the farm being changed: owner or Rapid Rise, the same rule
 * as billing (docs/BILLING.md section 10), and the database functions check it again.
 * Limits and switches go through those functions as the signed-in owner. The OpenAI key
 * is the exception: signed-in users have no grant on farm_ai_keys at all, so the server
 * checks it with OpenAI, seals it and stores it with the service role, and the plaintext
 * never leaves this request. Results come back as `?ai=<code>` (lib/ai-usage/results.ts).
 */

function done(code: AiResult): never {
  revalidatePath("/settings/ai");
  redirect(`/settings/ai?ai=${code}`);
}

/**
 * The owner (or Rapid Rise) on the farm being changed. Every form on the page carries the
 * farm it was showing; when the selected farm has changed since (another tab switched
 * it), the change is refused rather than made to the other farm, and its key never sealed
 * to the wrong farm.
 */
async function requireAiAdmin(formData: FormData): Promise<{ profile: Profile; farmId: string }> {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) done("forbidden");
  if (String(formData.get("farm_id") ?? "") !== farmId) done("farm-changed");
  if (profile.role !== "rr_admin") {
    const farms = await accessibleFarms(profile);
    if (!farms.some((f) => f.id === farmId)) done("forbidden");
  }
  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "rr_admin") done("forbidden");
  return { profile, farmId };
}

/**
 * Rands as typed ("R250", "1 500", "250,00", "1 500,50"): whole cents, or null when it is
 * not a sum. The shared parser reads a decimal comma as a decimal (lib/money.ts).
 */
function randsToCents(raw: FormDataEntryValue | null): number | null {
  const cents = parseRandsToCents(String(raw ?? ""));
  return cents !== null && cents >= 0 ? cents : null;
}

type LimitReply = { ok?: boolean; reason?: string } | null;

export async function setFarmAiLimit(formData: FormData): Promise<void> {
  const { farmId } = await requireAiAdmin(formData);
  const cents = randsToCents(formData.get("limit"));
  if (cents === null) done("limit-invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ai_set_farm_limit", { p_farm: farmId, p_limit_cents: cents });
  if (error) done("failed");
  const reply = data as LimitReply;
  if (reply?.ok) done("limit-saved");
  done(reply?.reason === "trial_limit" ? "limit-trial" : "limit-out-of-range");
}

export async function setMemberAiLimit(formData: FormData): Promise<void> {
  const { farmId } = await requireAiAdmin(formData);
  const userId = String(formData.get("user_id") ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(userId)) done("failed");
  const raw = String(formData.get("limit") ?? "").trim();
  const cents = raw === "" ? null : randsToCents(raw);
  if (raw !== "" && cents === null) done("limit-invalid");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ai_set_member_limit", { p_farm: farmId, p_user: userId, p_limit_cents: cents });
  if (error) done("failed");
  const reply = data as LimitReply;
  if (!reply?.ok) done(reply?.reason === "limit_out_of_range" ? "limit-out-of-range" : "failed");
  done(cents === null ? "member-limit-removed" : "member-limit-saved");
}

export async function setFarmAiSwitches(formData: FormData): Promise<void> {
  const { farmId } = await requireAiAdmin(formData);
  const flag = (name: string) => {
    const value = formData.get(name);
    return value === null ? null : value === "on";
  };
  const fallback = formData.get("own_key_fallback");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("ai_set_farm_switches", {
    p_farm: farmId,
    p_ai_enabled: flag("ai_enabled"),
    p_voice_enabled: flag("voice_enabled"),
    p_own_key_fallback: fallback === "platform" || fallback === "pause" ? fallback : null,
  });
  if (error || !(data as { ok?: boolean } | null)?.ok) done("failed");
  done("switches-saved");
}

/** Per instance, like the speech-token limit: stops the page being an oracle for stolen keys. */
const keyChecks = new Map<string, number[]>();
function keyCheckAllowed(userId: string): boolean {
  const hourAgo = Date.now() - 3_600_000;
  const recent = (keyChecks.get(userId) ?? []).filter((at) => at > hourAgo);
  if (recent.length >= 5) return false;
  keyChecks.set(userId, [...recent, Date.now()]);
  return true;
}

export async function linkOpenAiKey(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireAiAdmin(formData);
  const key = String(formData.get("key") ?? "").trim();
  if (!looksLikeOpenAiKey(key)) done("key-format");
  if (!keyCheckAllowed(profile.id)) done("key-rate-limited");
  const status = await checkOpenAiKey(key);
  if (status === "invalid") done("key-invalid");
  if (status === "unavailable") done("key-check-unavailable");
  let ciphertext: string;
  try {
    ciphertext = sealFarmKey(key, farmId);
  } catch {
    done("key-storage-unavailable");
  }
  const now = new Date().toISOString();
  const { error } = await createServiceClient().from("farm_ai_keys").upsert({
    farm_id: farmId,
    provider: "openai",
    ciphertext,
    hint: keyHint(key),
    status,
    checked_at: now,
    last_error_code: status === "no_quota" ? "farm_key_quota" : null,
    created_by: profile.id,
    updated_at: now,
  }, { onConflict: "farm_id" });
  if (error) done("failed");
  done(status === "no_quota" ? "key-linked-no-quota" : "key-linked");
}

export async function recheckOpenAiKey(formData: FormData): Promise<void> {
  const { profile, farmId } = await requireAiAdmin(formData);
  if (!keyCheckAllowed(profile.id)) done("key-rate-limited");
  const service = createServiceClient();
  const { data: row } = await service.from("farm_ai_keys").select("ciphertext").eq("farm_id", farmId).maybeSingle();
  if (!row) done("failed");
  let key: string;
  try {
    key = openFarmKey(String(row.ciphertext), farmId);
  } catch {
    done("key-storage-unavailable");
  }
  const status = await checkOpenAiKey(key);
  if (status === "unavailable") done("key-check-unavailable");
  const { error } = await service.from("farm_ai_keys").update({
    status,
    checked_at: new Date().toISOString(),
    last_error_code: status === "active" ? null : status === "no_quota" ? "farm_key_quota" : "farm_key_refused",
    updated_at: new Date().toISOString(),
  }).eq("farm_id", farmId);
  if (error) done("failed");
  done(status === "active" ? "key-checked" : status === "no_quota" ? "key-linked-no-quota" : "key-invalid");
}

export async function removeOpenAiKey(formData: FormData): Promise<void> {
  const { farmId } = await requireAiAdmin(formData);
  const { error } = await createServiceClient().from("farm_ai_keys").delete().eq("farm_id", farmId);
  if (error) done("failed");
  done("key-removed");
}
