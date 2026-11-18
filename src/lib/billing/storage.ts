import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { captureError } from "@/lib/observability";
import { STORAGE_AUTO_TERMS_VERSION, type StorageLevel } from "@/lib/storage-allowance";
import { BILLING_RPC, type ChangeState } from "./service";

/**
 * Pooled storage on the billing screen (20261118120000, 20261118120100): how full the pool is,
 * buying or giving back 10 GB blocks through A2's quotes, and the owner's automatic setting.
 */

/** public.storage_pool_status, as the person's own session reads it. Money for the payer only. */
export type StorageStatus = {
  used_bytes: number;
  total_bytes: number;
  included_bytes: number;
  blocks: number;
  block_bytes: number;
  full_spaces: number;
  equipment_spaces: number;
  level: StorageLevel;
  measured_on: string | null;
  next: {
    full_spaces: number;
    equipment_spaces: number;
    included_bytes: number;
    blocks: number;
    blocks_on: string | null;
    total_bytes: number;
  };
  payer: boolean;
  money: null | {
    block_monthly_cents: number;
    monthly_cents: number;
    next_monthly_cents: number;
    billing_period: "monthly" | "annual" | null;
    auto_blocks: boolean;
    auto_ceiling_cents: number | null;
    auto_accepted_at: string | null;
  };
};

/** Null when it cannot be read: the screen then says so rather than showing an empty pool. */
export async function storageStatus(supabase: SupabaseClient, farmId: string): Promise<StorageStatus | null> {
  const { data, error } = await supabase.rpc("storage_pool_status", { p_farm: farmId });
  if (error) {
    captureError(error, { where: "billing:storage-status", farmId });
    return null;
  }
  return (data as StorageStatus | null) ?? null;
}

/** Price holding `blocks` blocks from today and keep the price for the owner to accept. */
export async function quoteStorage(
  supabase: SupabaseClient,
  input: { subscriptionId: string; blocks: number; by: string },
): Promise<{ state: ChangeState | null; error: { message: string; code?: string } | null }> {
  const { data, error } = await supabase.rpc(BILLING_RPC.quoteStorage, {
    p_sub: input.subscriptionId,
    p_blocks: input.blocks,
    p_by: input.by,
  });
  if (error) return { state: null, error: { message: error.message, code: error.code } };
  return { state: (data as ChangeState | null) ?? null, error: null };
}

/**
 * The owner's automatic blocks (decision 34), through the owner's own session: on with a
 * monthly ceiling that counts the blocks held (and the terms version accepted), or off.
 * Returns the refusal slug, or null when it was saved.
 */
export async function setStorageAuto(
  supabase: SupabaseClient,
  input: { farmId: string; enabled: boolean; ceilingCents: number | null },
): Promise<string | null> {
  const { error } = await supabase.rpc("storage_set_auto", {
    p_farm: input.farmId,
    p_enabled: input.enabled,
    p_ceiling_cents: input.enabled ? input.ceilingCents : null,
    p_terms_version: input.enabled ? STORAGE_AUTO_TERMS_VERSION : null,
  });
  if (!error) return null;
  if (/^storage-[a-z-]+$/.test(error.message)) return error.message;
  if (error.code === "42501") return error.message === "farm-not-active" ? "farm-not-active" : "forbidden";
  captureError(error, { where: "billing:storage-auto", farmId: input.farmId });
  return "storage-auto-failed";
}
