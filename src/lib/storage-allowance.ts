import {
  MB,
  STORAGE_BLOCK_BYTES, STORAGE_MIN_BYTES, STORAGE_PER_EQUIPMENT_SPACE_BYTES, STORAGE_PER_FULL_SPACE_BYTES,
  STORAGE_URGENT_PERCENT, STORAGE_WARN_PERCENT,
} from "@/lib/limits";

/**
 * The pooled attachment allowance (decision 14), mirrored from app.storage_included_bytes and
 * app.storage_allowance (20261118120000) so a screen and the database cannot disagree:
 *
 *   included = max(2 GB, full spaces x 100 MB + equipment spaces x 25 MB)   (decimal bytes)
 *   total    = included + paid blocks x 10 GB
 *
 * storage-allowance.test.ts pins these numbers to the migration's text.
 */
export function includedBytes(fullSpaces: number, equipmentSpaces: number): number {
  const full = Math.max(0, Math.floor(fullSpaces || 0));
  const equipment = Math.max(0, Math.floor(equipmentSpaces || 0));
  return Math.max(STORAGE_MIN_BYTES, full * STORAGE_PER_FULL_SPACE_BYTES + equipment * STORAGE_PER_EQUIPMENT_SPACE_BYTES);
}

export function totalBytes(fullSpaces: number, equipmentSpaces: number, blocks: number): number {
  return includedBytes(fullSpaces, equipmentSpaces) + Math.max(0, Math.floor(blocks || 0)) * STORAGE_BLOCK_BYTES;
}

export type StorageLevel = "ok" | "80" | "95" | "full";

/** The same thresholds public.storage_pool_status answers with. */
export function storageLevel(usedBytes: number, totalBytesAllowed: number): StorageLevel {
  if (totalBytesAllowed <= 0 || usedBytes >= totalBytesAllowed) return "full";
  if (usedBytes * 100 >= totalBytesAllowed * STORAGE_URGENT_PERCENT) return "95";
  if (usedBytes * 100 >= totalBytesAllowed * STORAGE_WARN_PERCENT) return "80";
  return "ok";
}

/** Whole percent used, for a progress bar (never above 100). */
export function percentUsed(usedBytes: number, totalBytesAllowed: number): number {
  if (totalBytesAllowed <= 0) return 100;
  return Math.min(100, Math.floor((usedBytes * 100) / totalBytesAllowed));
}

/**
 * Decision 34: the owner's monthly ceiling counts the blocks already held. A ceiling of R98
 * with R49 blocks allows two blocks in total, not two more each month. Mirrors the check in
 * app.storage_auto_block and the minimum public.storage_set_auto accepts.
 */
export function ceilingAllows(blocksHeld: number, adding: number, blockMonthlyCents: number, ceilingCents: number): boolean {
  return (blocksHeld + adding) * blockMonthlyCents <= ceilingCents;
}

/** The lowest ceiling worth setting: the blocks held plus room for one more. */
export function minimumCeilingCents(blocksHeld: number, blockMonthlyCents: number): number {
  return (blocksHeld + 1) * blockMonthlyCents;
}

/** Decimal gigabytes for display, two decimals at most (2.375 GB shows as 2.38). */
export function gigabytes(bytes: number): number {
  return Math.round((bytes / (1000 * MB)) * 100) / 100;
}

/** The terms version an owner accepts when switching automatic blocks on. */
export const STORAGE_AUTO_TERMS_VERSION = "storage-auto-2026-11";
