import "server-only";
import { whatsappConfig } from "./config";

/** Do not log Meta's error object: it can echo message data and recipient identifiers. */
export async function sendWhatsApp(to: string, content: Record<string, unknown>): Promise<string> {
  const config = whatsappConfig();
  const response = await fetch(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...content }),
  });
  if (!response.ok) throw new Error(`whatsapp_http_${response.status}`);
  const body = await response.json();
  const id = body?.messages?.[0]?.id;
  if (typeof id !== "string") throw new Error("whatsapp_response_unknown");
  return id;
}
