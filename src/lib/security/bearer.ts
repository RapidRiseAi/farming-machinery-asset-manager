import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Does this `Authorization` header carry exactly this bearer token?
 *
 * `authHeader !== \`Bearer ${secret}\`` — which is what both cron routes did — compares byte
 * by byte and stops at the first difference, so how long it takes to say no depends on how
 * much of the token was right. That is a timing oracle, and these routes are reachable from
 * the public internet and run the entire billing pass.
 *
 * The practical risk over HTTPS through Vercel's edge is small: network jitter swamps a few
 * hundred nanoseconds. But "probably too noisy to exploit" is a weaker thing to rely on
 * than a comparison that does not leak, and this costs nothing.
 *
 * Both sides are hashed first because `timingSafeEqual` throws when the buffers differ in
 * LENGTH — which is the same leak in miniature, answered instantly and telling the caller
 * how long the secret is. Comparing digests makes every comparison exactly 32 bytes
 * whatever was sent.
 */
export function bearerMatches(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret || !authHeader) return false;
  const sent = createHash("sha256").update(authHeader, "utf8").digest();
  const want = createHash("sha256").update(`Bearer ${secret}`, "utf8").digest();
  return timingSafeEqual(sent, want);
}
