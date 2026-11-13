/**
 * The caller's IP, as the anonymous forms already read it: the first entry of
 * `x-forwarded-for`, which Vercel sets for every request (signup/actions.ts has the longer
 * note). It is a header, so it is a cost multiplier for a limiter and a hint for the bot
 * check, never proof of anything.
 *
 * Null when there is no usable value, so a caller can decide what "unknown" means for it
 * rather than every unknown caller silently sharing one bucket.
 */
export function clientIp(headers: Pick<Headers, "get">): string | null {
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  // An address is digits, hex, dots and colons. Anything else is not one, and is not sent
  // on to Cloudflare or hashed into a key.
  return /^[0-9a-fA-F.:]{2,45}$/.test(first) ? first : null;
}
