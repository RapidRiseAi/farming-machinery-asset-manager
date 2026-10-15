import "server-only";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value || value === "[SENSITIVE]") throw new Error(`Missing ${name}`);
  return value;
}

export function whatsappEnabled() { return process.env.WHATSAPP_ENABLED === "1"; }

export function whatsappConfig() {
  const version = required("WHATSAPP_GRAPH_VERSION");
  const phoneId = required("WHATSAPP_PHONE_NUMBER_ID");
  const waba = required("WHATSAPP_BUSINESS_ACCOUNT_ID");
  const businessPhone = required("WHATSAPP_BUSINESS_PHONE");
  if (!/^v\d+\.0$/.test(version) || !/^\d+$/.test(phoneId) || !/^\d+$/.test(waba)
      || !/^[1-9][0-9]{7,14}$/.test(businessPhone)) throw new Error("Invalid WhatsApp configuration");
  return { version, phoneId, waba, businessPhone,
    accessToken: required("WHATSAPP_ACCESS_TOKEN"), appSecret: required("WHATSAPP_APP_SECRET"),
    verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
  };
}
