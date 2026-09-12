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

/**
 * Why email is not configured, or null when it is.
 *
 * Exported so a caller can LOG the reason. "email-not-configured" on its own has cost this
 * project weeks: the nightly pass reported exactly that, nobody could tell whether the key
 * was missing, wrong, or a placeholder, and the six receipts it had already stamped as sent
 * looked perfectly healthy.
 */
export function emailConfigProblem(): string | null {
  const key = (process.env.RESEND_API_KEY ?? "").trim();
  const from = (process.env.EMAIL_FROM ?? "").trim();

  if (!key) return "RESEND_API_KEY is not set";
  // `vercel pull` CANNOT decrypt secrets — it writes the literal string `[SENSITIVE]`, which
  // is perfectly truthy. That one fact is why every send failed at the provider for weeks
  // while this function reported everything was fine.
  if (/^\[.*\]$/.test(key)) return "RESEND_API_KEY is a placeholder, not a key";
  if (/\s/.test(key)) return "RESEND_API_KEY contains whitespace";
  // Resend's documented key prefix. This module talks to exactly one provider — its
  // endpoint and its error shape are both Resend's — so recognising Resend's own format is
  // not over-fitting, and refusing loudly beats being rejected silently once per message.
  if (!key.startsWith("re_")) return "RESEND_API_KEY does not look like a Resend key";
  if (key.length < 20) return "RESEND_API_KEY is too short to be real";

  if (!from) return "EMAIL_FROM is not set";
  if (/^\[.*\]$/.test(from)) return "EMAIL_FROM is a placeholder, not an address";
  // Resend only accepts a domain you have verified, so a malformed or invented FROM is a
  // rejection at the provider — one per message, rather than once at startup.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from)) return "EMAIL_FROM is not an email address";

  return null;
}

export function emailConfigured(): boolean {
  return emailConfigProblem() === null;
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
  // Checked here as well as at the call sites: `sendEmail` is reachable on its own, and a
  // guard that lives only in the callers is a guard somebody will forget.
  const problem = emailConfigProblem();
  if (problem) return { ok: false, error: `email-not-configured: ${problem}`, provider: "none" };
  const key = process.env.RESEND_API_KEY as string;

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
