"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  homePathFor,
  requireProfile,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { mintApiToken } from "@/lib/api-tokens";
import { createClient } from "@/lib/supabase/server";

const HERE = "/settings/api";
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type CreateApiTokenState = {
  token: string | null;
  prefix: string | null;
  error: "name" | "scopes" | "expiry" | "create_failed" | null;
};

const EMPTY_API_TOKEN_STATE: CreateApiTokenState = {
  token: null,
  prefix: null,
  error: null,
};

/** Selected-farm authority + selected-farm entitlement. No farm comes from the form. */
async function gate() {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
  if (!farmId) redirect(`${HERE}?error=no-farm`);

  const role = await effectiveFarmRole(farmId, profile);
  if (!role || !["owner", "manager", "rr_admin"].includes(role)) {
    redirect(`${homePathFor(profile.role)}?denied=1`);
  }
  if (role !== "rr_admin" && !planAllows(await getFarmPlan(farmId), "api_access")) {
    redirect(`${HERE}?error=upgrade_required`);
  }
  return { profile, farmId, supabase: await createClient() };
}

function expiry(value: FormDataEntryValue | null): string | null | "invalid" {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "invalid";
  const end = new Date(`${raw}T23:59:59.999+02:00`);
  if (Number.isNaN(end.valueOf()) || end <= new Date()) return "invalid";
  return end.toISOString();
}

/** Mint once: the raw secret exists only in this action response and is never stored. */
export async function createApiToken(
  _previous: CreateApiTokenState,
  formData: FormData,
): Promise<CreateApiTokenState> {
  const { profile, farmId, supabase } = await gate();
  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 3 || name.length > 80) return { ...EMPTY_API_TOKEN_STATE, error: "name" };

  const scopes = [
    ...(formData.get("scope_read") === "on" ? ["read"] : []),
    ...(formData.get("scope_write_readings") === "on" ? ["write:readings"] : []),
  ];
  if (scopes.length === 0) return { ...EMPTY_API_TOKEN_STATE, error: "scopes" };
  const expiresAt = expiry(formData.get("expires_on"));
  if (expiresAt === "invalid") return { ...EMPTY_API_TOKEN_STATE, error: "expiry" };

  const minted = mintApiToken();
  const { error } = await supabase.from("api_tokens").insert({
    farm_id: farmId,
    name,
    token_hash: minted.tokenHash,
    prefix: minted.prefix,
    scopes,
    created_by: profile.id,
    expires_at: expiresAt,
  });
  if (error) {
    console.error("[api-tokens] token creation failed", { code: error.code, farmId });
    return { ...EMPTY_API_TOKEN_STATE, error: "create_failed" };
  }

  revalidatePath(HERE);
  return { token: minted.token, prefix: minted.prefix, error: null };
}

export async function revokeApiToken(formData: FormData): Promise<void> {
  const { profile, farmId, supabase } = await gate();
  const id = String(formData.get("id") ?? "");
  if (!UUID_PATTERN.test(id)) redirect(`${HERE}?error=revoke_failed`);

  const { data, error } = await supabase
    .from("api_tokens")
    .update({ revoked_at: new Date().toISOString(), revoked_by: profile.id })
    .eq("id", id)
    .eq("farm_id", farmId)
    .is("revoked_at", null)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();
  if (error || !data) redirect(`${HERE}?error=revoke_failed`);

  revalidatePath(HERE);
  redirect(`${HERE}?revoked=1`);
}
