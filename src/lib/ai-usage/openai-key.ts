import "server-only";

/**
 * Checks a farm's own OpenAI key with the smallest real request there is: one token from
 * the cheapest model, a fraction of a cent on the farm's own account. Listing models is
 * free but answers 200 for an account with no credit, which is exactly the key that would
 * then fail on every call. Nothing about the key or the response is logged or returned.
 */
export type KeyCheck = "active" | "invalid" | "no_quota" | "unavailable";

const CHECK_TIMEOUT_MS = 10_000;

export async function checkOpenAiKey(key: string): Promise<KeyCheck> {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (response.ok) return "active";
    if (response.status === 401 || response.status === 403) return "invalid";
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; type?: unknown } } | null;
      const code = `${String(body?.error?.code ?? "")} ${String(body?.error?.type ?? "")}`;
      // A rate limit is a working key on a busy account; no quota is a key that cannot work.
      return /insufficient_quota|billing/i.test(code) ? "no_quota" : "active";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
