"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  currentFarmId,
  effectiveFarmRole,
  getFarmPlan,
  homePathFor,
  requireProfile,
  requireUsableFarm,
} from "@/lib/auth";
import { planAllows } from "@/lib/entitlements";
import { mintApiToken } from "@/lib/api-tokens";
import { createClient } from "@/lib/supabase/server";
import { claimRequest } from "@/lib/request-claim";
import { readRequestId, REQUEST_FIELD } from "@/lib/request-id";
import { captureError } from "@/lib/observability";

const HERE = "/settings/api";
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export type CreateApiTokenState = {
  token: string | null;
  prefix: string | null;
  error: "name" | "scopes" | "expiry" | "create_failed" | "still_creating" | "replay_revoked" | null;
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
  await requireUsableFarm(farmId, profile);
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
  // One token per request (request_claims). A repeat of a request that already minted one
  // means its answer, and so its secret, never reached the screen: a live credential
  // nobody has seen. That token is revoked and the person is asked to create a new one.
  const claim = await claimRequest(supabase, readRequestId(formData.get(REQUEST_FIELD)), "api-tokens:create");
  if (claim.state === "running") return { ...EMPTY_API_TOKEN_STATE, error: "still_creating" };
  if (claim.state === "done") {
    if (UUID_PATTERN.test(claim.outcome)) {
      const { error: revokeError } = await supabase
        .from("api_tokens")
        .update({ revoked_at: new Date().toISOString(), revoked_by: profile.id })
        .eq("id", claim.outcome)
        .eq("farm_id", farmId)
        .is("revoked_at", null);
      if (revokeError) captureError(revokeError, { where: "api-tokens:revoke-unseen" });
    }
    revalidatePath(HERE);
    return { ...EMPTY_API_TOKEN_STATE, error: "replay_revoked" };
  }

  const name = String(formData.get("name") ?? "").trim();
  if (name.length < 3 || name.length > 80) {
    await claim.release();
    return { ...EMPTY_API_TOKEN_STATE, error: "name" };
  }

  const scopes = [
    ...(formData.get("scope_read") === "on" ? ["read"] : []),
    ...(formData.get("scope_write_readings") === "on" ? ["write:readings"] : []),
  ];
  if (scopes.length === 0) {
    await claim.release();
    return { ...EMPTY_API_TOKEN_STATE, error: "scopes" };
  }
  const expiresAt = expiry(formData.get("expires_on"));
  if (expiresAt === "invalid") {
    await claim.release();
    return { ...EMPTY_API_TOKEN_STATE, error: "expiry" };
  }

  const minted = mintApiToken();
  const { data: created, error } = await supabase.from("api_tokens").insert({
    farm_id: farmId,
    name,
    token_hash: minted.tokenHash,
    prefix: minted.prefix,
    scopes,
    created_by: profile.id,
    expires_at: expiresAt,
  }).select("id").single();
  if (error || !created) {
    await claim.release();
    captureError(error ?? new Error("no token row"), { where: "api-tokens:create", extra: { code: error?.code ?? null } });
    return { ...EMPTY_API_TOKEN_STATE, error: "create_failed" };
  }

  // The token's id, never its secret: a replay revokes this token (above).
  await claim.finish((created as { id: string }).id);
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
