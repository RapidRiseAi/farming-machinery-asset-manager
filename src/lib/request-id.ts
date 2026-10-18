/**
 * An id for one attempt at an action, so the server can tell a retry from a new request.
 *
 * On poor signal a request can reach the server while its answer never comes back; the
 * person sees a failure and tries again. With the same id on the retry, the server finds
 * the first attempt and answers with it instead of sending the email or creating the
 * record a second time. A screen keeps one id until an attempt succeeds, then takes a new
 * one for the next.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function newRequestId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Older browsers without randomUUID: the same v4 layout from getRandomValues.
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A request id from the client, or null when it is missing or not a UUID. */
export function readRequestId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}
