import "server-only";
import { createHmac } from "node:crypto";
import { whatsappConfig } from "./config";
import { phoneNumber } from "./phone";

/** Operator-only read checks. Never return provider messages, tokens, phone numbers or raw bodies. */
export async function checkWhatsAppConfiguration() {
  const config = whatsappConfig();
  const proof = createHmac("sha256", config.appSecret).update(config.accessToken).digest("hex");
  async function read(edge: "subscribed_apps" | "phone_numbers") {
    const url = new URL(`https://graph.facebook.com/${config.version}/${config.waba}/${edge}`);
    url.searchParams.set("appsecret_proof", proof);
    url.searchParams.set("limit", "100");
    if (edge === "phone_numbers") url.searchParams.set("fields", "id,display_phone_number");
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${config.accessToken}` } });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body.data)) {
        const message = typeof body?.error?.message === "string" ? body.error.message : "";
        const reason = /appsecret_proof|app.secret/i.test(message) ? "app_secret_mismatch"
          : body?.error?.code === 190 ? "invalid_access_token"
          : /permission|access|does not exist|unsupported get/i.test(message) ? "account_access_denied"
          : "provider_rejected";
        return { ok: false as const, status: response.status,
          code: typeof body?.error?.code === "number" ? body.error.code : null, reason };
      }
      return { ok: true as const, status: response.status, data: body.data as Record<string, unknown>[],
        morePages: Boolean(body.paging?.next) };
    } catch { return { ok: false as const, status: null, code: null }; }
  }
  const [subscriptions, phones] = await Promise.all([read("subscribed_apps"), read("phone_numbers")]);
  const phone = phones.ok ? phones.data.find(row => row.id === config.phoneId) : null;
  return {
    subscriptions: subscriptions.ok ? { ok: true, morePages: subscriptions.morePages,
      appIds: subscriptions.data.flatMap(row => {
        const app = row.whatsapp_business_api_data as { id?: unknown } | undefined;
        return typeof app?.id === "string" && /^\d+$/.test(app.id) ? [app.id] : [];
      }) } : subscriptions,
    phone: phones.ok ? { ok: true, morePages: phones.morePages, configuredIdFound: Boolean(phone),
      businessNumberMatches: typeof phone?.display_phone_number === "string"
        && phoneNumber(phone.display_phone_number) === config.businessPhone } : phones,
  };
}
