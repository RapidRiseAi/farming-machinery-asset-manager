import { NextResponse, after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { whatsappConfig, whatsappEnabled } from "@/lib/whatsapp/config";
import { equalSecret, hashLinkToken, parseWebhook, validSignature, linkMessageToken } from "@/lib/whatsapp/protocol";
import { processWhatsAppInbox } from "@/lib/whatsapp/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
  if (url.searchParams.get("hub.mode") !== "subscribe" || !equalSecret(token, url.searchParams.get("hub.verify_token") ?? "")) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(url.searchParams.get("hub.challenge") ?? "", { headers: { "Content-Type": "text/plain" } });
}

export async function POST(request: Request) {
  // Fixed event codes only: never record bodies, tokens, phone numbers or credentials.
  console.info("whatsapp_webhook_received");
  if (!whatsappEnabled()) return new Response("Unavailable", { status: 503 });
  try {
    const config = whatsappConfig();
    // Bound the stream itself; Content-Length is caller-controlled and may be absent.
    const reader = request.body?.getReader();
    if (!reader) return new Response("Bad request", { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) { await reader.cancel(); return new Response("Too large", { status: 413 }); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!validSignature(raw, request.headers.get("x-hub-signature-256"), config.appSecret)) {
      console.warn("whatsapp_webhook_signature_rejected");
      return new Response("Forbidden", { status: 403 });
    }
    const values = parseWebhook(JSON.parse(raw), config.waba, config.phoneId);
    if (!values) { console.warn("whatsapp_webhook_payload_rejected"); return new Response("Bad request", { status: 400 }); }
    if (!values.length) console.info("whatsapp_webhook_no_matching_account_or_phone");
    const service = createServiceClient();
    for (const value of values) {
      for (const status of value.statuses ?? []) {
        const results = await Promise.all([
          service.from("whatsapp_inbox").update({ delivery_status: status.status }).eq("provider_reply_id", status.id),
          service.from("whatsapp_notification_delivery").update({ delivery_status: status.status }).eq("provider_id", status.id),
        ]);
        if (results.some(r => r.error)) throw new Error("status_store_failed");
      }
      for (const message of value.messages ?? []) {
        // Username-only identities are not guessed or matched by display name.
        // This pilot requires the employee to share their verified phone number.
        if (!message.from) continue;
        const text = message.type === "text" ? message.text?.body
          : message.type === "interactive" ? message.interactive?.button_reply?.id : undefined;
        const link = linkMessageToken(text);
        if (link) {
          const { data, error } = await service.rpc("whatsapp_verify_link", { p_hash: hashLinkToken(link), p_phone: message.from });
          if (error) throw new Error("link_store_failed");
          console.info(data ? "whatsapp_link_message_verified" : "whatsapp_link_message_not_matched");
          continue;
        }
        const { error } = await service.rpc("whatsapp_receive", {
          p_provider_id: message.id, p_phone: message.from,
          p_text: text && text.length <= 2000 ? text : "[unsupported message]",
          p_at: new Date(Number(message.timestamp) * 1000).toISOString(),
        });
        if (error) throw new Error("inbox_store_failed");
      }
    }
    after(async () => { await processWhatsAppInbox(1); });
    return NextResponse.json({ received: true });
  } catch {
    console.error("whatsapp_webhook_processing_failed");
    // Returning 503 makes Meta retry; unique provider IDs make replay harmless.
    return new Response("Temporarily unavailable", { status: 503 });
  }
}
