import "server-only";
import { createPrivateKey, sign, type JsonWebKey } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { AssistantContext } from "@/lib/assistant/context";
import type { Profile, Role } from "@/lib/auth";
import { getSupabaseEnv } from "@/lib/env";
import { langOf } from "@/lib/i18n";

export type WhatsAppLink = {
  id: string; user_id: string; farm_id: string; phone: string;
  revoked_at: string | null; expires_at: string; assistant_until: string;
  assistant_enabled: boolean; notifications_enabled: boolean;
  conversation: unknown; conversation_at: string | null;
  authority_tag: string;
  conversation_authority_tag: string | null;
};

// Import this dedicated ES256 key into Supabase Auth before enabling the bridge.
// Never use the service-role key as the agent's database credential.
export function delegatedToken(link: Pick<WhatsAppLink, "id" | "user_id" | "farm_id">, now = Date.now()) {
  const jwk = JSON.parse(process.env.WHATSAPP_AUTH_PRIVATE_JWK ?? "null") as (JsonWebKey & { kid: string }) | null;
  if (!jwk || jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.kid) throw new Error("WhatsApp signing key unavailable");
  const { url } = getSupabaseEnv();
  const issued = Math.floor(now / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "ES256", typ: "JWT", kid: jwk.kid })}.${encode({
    iss: `${url}/auth/v1`, aud: "authenticated", role: "authenticated", sub: link.user_id,
    iat: issued, exp: issued + 60, fw_channel: "whatsapp", fw_link_id: link.id, fw_farm_id: link.farm_id,
  })}`;
  const signature = sign("sha256", Buffer.from(payload), {
    key: createPrivateKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${payload}.${signature}`;
}

export async function whatsappAssistantContext(link: WhatsAppLink): Promise<AssistantContext | null> {
  if (link.revoked_at || !link.assistant_enabled || Date.parse(link.expires_at) <= Date.now()
    || Date.parse(link.assistant_until) <= Date.now()) return null;
  const { url, anonKey } = getSupabaseEnv();
  const supabase = createClient(url, anonKey, {
    accessToken: async () => delegatedToken(link),
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: role, error } = await supabase.rpc("whatsapp_assistant_role", { p_farm: link.farm_id });
  if (error || !role || !["owner", "manager", "mechanic", "operator"].includes(role)) return null;
  const { data, error: profileError } = await supabase.from("users").select(
    "id,farm_id,workshop_id,role,name,email,language,tone,language_set_at,ai_processing_opt_in,ai_processing_opted_in_at,ai_processing_consent_version,ai_processing_withdrawn_at,ai_notice_seen_at,active,is_test",
  ).eq("id", link.user_id).is("deleted_at", null).maybeSingle();
  if (profileError || !data?.active) return null;
  const profile = { ...data, lang: langOf(data.language, data.tone) } as Profile;
  return { profile, farmId: link.farm_id, role: role as Role, supabase, sourceChannel: "whatsapp" };
}
