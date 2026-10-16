import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export function phoneNumber(value: string): string | null {
  const number = value.trim().replace(/^\+/, "").replace(/[ ()-]/g, "");
  return /^[1-9][0-9]{7,14}$/.test(number) ? number : null;
}

export function hashLinkToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validSignature(raw: string, header: string | null, secret: string): boolean {
  if (!secret || !header || !/^sha256=[a-f0-9]{64}$/.test(header)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(header.slice(7), "hex"));
}

export function equalSecret(left: string, right: string): boolean {
  return Boolean(left && right) && timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

export function validWorkerAuthorization(header: string | null, secrets: readonly (string | undefined)[]): boolean {
  return secrets.some(secret => Boolean(secret) && equalSecret(header ?? "", `Bearer ${secret}`));
}

const messageSchema = z.object({
  id: z.string().min(1).max(300),
  from: z.string().regex(/^[1-9][0-9]{7,14}$/).optional(),
  timestamp: z.string().regex(/^\d{1,12}$/),
  type: z.string(),
  text: z.object({ body: z.string().max(10000) }).optional(),
  interactive: z.object({ button_reply: z.object({ id: z.string().max(100) }).optional() }).optional(),
});
const envelopeSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({ field: z.string(), value: z.object({
      metadata: z.object({ phone_number_id: z.string() }).optional(),
      messages: z.array(messageSchema).max(100).optional(),
      statuses: z.array(z.object({ id: z.string().max(300), status: z.enum(["sent", "delivered", "read", "failed"]) })).max(100).optional(),
    }) })).max(100),
  })).max(100),
});

export function parseWebhook(body: unknown, waba: string, phoneId: string) {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) return null;
  return parsed.data.entry.filter(e => e.id === waba).flatMap(e => e.changes)
    .filter(c => c.field === "messages" && c.value.metadata?.phone_number_id === phoneId)
    .map(c => c.value);
}

/** Meta's free-form reply window is measured from the user's message, not receipt. */
export function replyWindowOpen(messageAt: string, now = Date.now()): boolean {
  const at = Date.parse(messageAt);
  return Number.isFinite(at) && at <= now + 300_000 && now - at < 24 * 60 * 60 * 1000;
}
