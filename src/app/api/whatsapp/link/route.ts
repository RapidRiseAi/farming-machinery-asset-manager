import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentFarmId, getProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { sameOrigin } from "@/lib/security/same-origin";
import { whatsappConfig, whatsappEnabled } from "@/lib/whatsapp/config";
import { hashLinkToken, phoneNumber } from "@/lib/whatsapp/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("begin"), phone: z.string().max(30), notifications: z.boolean(), assistant: z.boolean() }),
  z.object({ action: z.literal("finish"), challengeId: z.uuid() }),
  z.object({ action: z.enum(["disconnect", "authorize"]) }),
]);
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "blocked" }, 403);
  const profile = await getProfile();
  if (!profile?.active) return json({ error: "sign_in" }, 401);
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  const body = parsed.data;
  const db = await createClient();
  // Disconnect stays available when the channel or a customer's plan is disabled.
  if (body.action === "disconnect") {
    const result = await db.rpc("whatsapp_manage_link", { p_action: "disconnect" });
    return result.error ? json({ error: "unavailable" }, 503) : json({ ok: true });
  }
  if (!whatsappEnabled()) return json({ error: "not_configured" }, 503);
  try {
    if (body.action === "begin") {
      const phone = phoneNumber(body.phone);
      const farmId = await currentFarmId(profile);
      if (!phone) return json({ error: "invalid_phone" }, 400);
      if (!farmId || !(body.notifications || body.assistant)) return json({ error: "invalid_request" }, 400);
      const config = whatsappConfig();
      const token = randomBytes(32).toString("hex");
      const { data, error } = await db.rpc("whatsapp_begin_link", { p_farm: farmId, p_phone: phone,
        p_hash: hashLinkToken(token), p_notifications: body.notifications, p_assistant: body.assistant });
      if (error) return json({ error: error.code === "42501" ? "not_allowed" : error.code === "P0001" ? "rate_limited" : "try_later" }, 400);
      return json({ challengeId: data, phone: `+${phone}`, url: `https://wa.me/${config.businessPhone}?text=${encodeURIComponent(`LINK ${token}`)}` });
    }
    if (body.action === "finish") {
      // Read only this signed-in person's challenge; the transactional RPC still enforces every condition.
      const { data: challenge, error } = await createServiceClient().from("whatsapp_link_challenges")
        .select("expires_at,consumed_at,verified_at").eq("id", body.challengeId).eq("user_id", profile.id).maybeSingle();
      if (error) return json({ error: "unavailable" }, 503);
      if (!challenge || challenge.consumed_at) return json({ error: "link_replaced" }, 409);
      if (Date.parse(challenge.expires_at) <= Date.now()) return json({ error: "link_expired" }, 409);
      if (!challenge.verified_at) return json({ error: "message_not_verified" }, 409);
      const result = await db.rpc("whatsapp_finish_link", { p_challenge: body.challengeId });
      return result.error ? json({ error: result.error.code === "23505" ? "number_unavailable" : "not_verified" }, 409) : json({ ok: true });
    }
    const result = await db.rpc("whatsapp_manage_link", { p_action: "authorize" });
    return result.error ? json({ error: "not_allowed" }, 403) : json({ ok: true });
  } catch { return json({ error: "unavailable" }, 503); }
}
