import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * An app upload link for a file WhatsApp cannot carry here (20261121090000): a photo past
 * Meta's 5 MB, a document, or a path not released for the business yet. The link is not write
 * access: /whatsapp/upload/<token> works only for the same signed-in person, on the same
 * business, while they are still a member, for 30 minutes, and then opens the app's own upload
 * (B1's pipeline, the normal row security). Only the token's SHA-256 is stored.
 */

export type UploadPurpose = "fault_photo" | "document" | "voice";

/** The stored form of a token; the token itself only ever travels in the WhatsApp reply. */
export function uploadTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A token is 32 random bytes in base64url: 43 characters of [A-Za-z0-9_-]. */
export function looksLikeUploadToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function createUploadLink(input: {
  linkId: string; origin: string; purpose: UploadPurpose; faultId?: string | null;
}): Promise<string | null> {
  const token = randomBytes(32).toString("base64url");
  const { error } = await createServiceClient().rpc("whatsapp_upload_link_create", {
    p_token_hash: uploadTokenHash(token), p_link: input.linkId, p_purpose: input.purpose,
    p_target_kind: input.faultId ? "fault" : null, p_target: input.faultId ?? null,
  });
  // No link rather than a broken one: the caller falls back to the plain app address.
  if (error) return null;
  return `${input.origin}/whatsapp/upload/${token}`;
}
