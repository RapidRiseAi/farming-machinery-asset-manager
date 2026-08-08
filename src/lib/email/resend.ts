import "server-only";

/**
 * Email, through Resend.
 *
 * Until now "send" meant "set a status and write an in-app alert" — the customer had to
 * log into FleetWise to discover they had been invoiced. Every tool a partner might use
 * instead emails the document with a link the customer can open without an account.
 *
 * Deliberately a thin fetch against Resend's REST API rather than the SDK: one dependency
 * fewer, no bundler surprises in a server route, and the whole surface we use is one POST.
 *
 * ENV-GATED, like Web Push (F6): with `RESEND_API_KEY` unset this is a no-op that reports
 * why, so a fresh clone and the whole test suite run without an outbound mail account and
 * the caller still gets a truthful result to log. There is no silent success.
 */

const ENDPOINT = "https://api.resend.com/emails";

export type EmailAttachment = {
  filename: string;
  /** Raw bytes; base64-encoded on the way out. */
  content: Uint8Array;
};

export type SendEmailInput = {
  to: string;
  from: string;
  /** Where a reply should land — the partner's own address, not ours. */
  replyTo?: string | null;
  cc?: string | null;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
};

export type SendEmailResult =
  | { ok: true; id: string | null; provider: "resend" }
  | { ok: false; error: string; provider: "resend" | "none" };

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * The address we send FROM. Resend will only accept a domain you have verified, so this
 * is ours, not the partner's — but `replyTo` is the partner's, so a customer pressing
 * reply reaches the person who invoiced them rather than us. The display name is the
 * partner's business, which is what the customer recognises in their inbox.
 */
export function fromAddress(partnerName: string): string {
  const base = process.env.EMAIL_FROM || "documents@fleetwise.app";
  const safe = partnerName.replace(/["\\<>]/g, "").trim().slice(0, 60);
  return safe ? `${safe} via FleetWise <${base}>` : base;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "email-not-configured", provider: "none" };

  const body: Record<string, unknown> = {
    from: input.from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
    text: input.text,
  };
  if (input.replyTo) body.reply_to = [input.replyTo];
  if (input.cc) body.cc = [input.cc];
  if (input.attachments?.length) {
    body.attachments = input.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content).toString("base64"),
    }));
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      // A send that hangs must not hang the request that asked for it.
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      // Resend returns a JSON error body; fall back to the status if it does not.
      const detail = await res.text().catch(() => "");
      let message = `${res.status}`;
      try {
        const parsed = JSON.parse(detail) as { message?: string; name?: string };
        message = parsed.message || parsed.name || message;
      } catch {
        if (detail) message = detail.slice(0, 300);
      }
      return { ok: false, error: message, provider: "resend" };
    }

    const data = (await res.json().catch(() => null)) as { id?: string } | null;
    return { ok: true, id: data?.id ?? null, provider: "resend" };
  } catch (err) {
    const message = err instanceof Error ? err.message : "send-failed";
    return { ok: false, error: message, provider: "resend" };
  }
}
