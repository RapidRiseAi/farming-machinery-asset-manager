/**
 * What may be logged about a failed AI call: its name, type and status, nothing else.
 *
 * An AI SDK error carries the request (`requestBodyValues`) and the provider's response
 * (`responseBody`) as own properties. A farm's own OpenAI key travels in the request body
 * (Gateway request-scoped BYOK), so `console.error(error)`, whose inspection prints every
 * own property, would put that key in the Vercel logs. Never log the error itself.
 */
export function aiErrorForLog(error: unknown): { name: string; type: string; status: number | null } {
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const name = typeof e.name === "string" ? e.name.slice(0, 60) : "Error";
  const type = typeof e.type === "string" ? e.type.slice(0, 60) : "";
  const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  return { name, type, status };
}
