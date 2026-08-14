import { NextResponse } from "next/server";
import { currentFarmId, effectiveFarmRole, getFarmPlan, getProfile } from "@/lib/auth";
import { getAzureSpeechProviderEnv } from "@/lib/assistant/provider-env";
import { planAllows } from "@/lib/entitlements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  Vary: "Cookie, Origin",
} as const;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 6;
const RATE_LIMIT_MAX_BUCKETS = 2_000;
const PROVIDER_TIMEOUT_MS = 8_000;
const CLIENT_TOKEN_LIFETIME_MS = 9 * 60_000;

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

type GlobalWithSpeechRateLimit = typeof globalThis & {
  __fleetwiseSpeechTokenRateLimit?: Map<string, RateLimitBucket>;
};

const rateLimitGlobal = globalThis as GlobalWithSpeechRateLimit;

/**
 * Best-effort per-user guard for the token broker. It is intentionally conservative,
 * bounded in memory, and shared within one Node instance. Serverless instances do not
 * share memory, so this complements (rather than replaces) platform-level rate limits.
 */
const rateLimitBuckets =
  rateLimitGlobal.__fleetwiseSpeechTokenRateLimit ?? new Map<string, RateLimitBucket>();
rateLimitGlobal.__fleetwiseSpeechTokenRateLimit = rateLimitBuckets;

function jsonError(error: string, status: number, headers?: Record<string, string>) {
  return NextResponse.json(
    { error },
    { status, headers: { ...PRIVATE_NO_STORE_HEADERS, ...headers } }
  );
}

function configuredOrigins(request: Request): Set<string> {
  const origins = new Set<string>([new URL(request.url).origin]);
  const configuredUrls = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
    process.env.VERCEL_BRANCH_URL ? `https://${process.env.VERCEL_BRANCH_URL}` : undefined,
  ];

  for (const value of configuredUrls) {
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // A malformed public URL is not trusted as an origin.
    }
  }

  return origins;
}

function isSameOrigin(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader || originHeader === "null") return false;

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  try {
    const origin = new URL(originHeader);
    if (origin.origin !== originHeader || origin.username || origin.password) return false;
    return configuredOrigins(request).has(origin.origin);
  } catch {
    return false;
  }
}

function takeRateLimitSlot(key: string, now: number): { allowed: boolean; retryAfter: number } {
  const existing = rateLimitBuckets.get(key);
  if (existing && existing.resetAt > now) {
    if (existing.count >= RATE_LIMIT_MAX_REQUESTS) {
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
    }
    existing.count += 1;
    return { allowed: true, retryAfter: 0 };
  }

  if (existing) rateLimitBuckets.delete(key);

  if (rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS) {
    for (const [bucketKey, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(bucketKey);
    }
  }

  if (rateLimitBuckets.size >= RATE_LIMIT_MAX_BUCKETS) {
    return { allowed: false, retryAfter: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000) };
  }

  rateLimitBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  return { allowed: true, retryAfter: 0 };
}

function isUsableProviderToken(token: string): boolean {
  return token.length >= 20 && token.length <= 8_192 && !/\s/.test(token);
}

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return jsonError("forbidden_origin", 403);
  }

  const profile = await getProfile();
  if (!profile) return jsonError("unauthenticated", 401);
  if (!profile.active) return jsonError("forbidden", 403);
  if (profile.role === "workshop") return jsonError("forbidden", 403);

  const farmId = await currentFarmId(profile);
  if (!farmId) return jsonError("farm_context_required", 409);
  const role = await effectiveFarmRole(farmId, profile);
  if (!role) return jsonError("forbidden", 403);

  if (role !== "rr_admin") {
    const plan = await getFarmPlan(farmId);
    if (!planAllows(plan, "voice_ai")) return jsonError("upgrade_required", 403);
  }

  const now = Date.now();
  const rateLimit = takeRateLimitSlot(profile.id, now);
  if (!rateLimit.allowed) {
    return jsonError("rate_limited", 429, { "Retry-After": String(rateLimit.retryAfter) });
  }

  let provider: ReturnType<typeof getAzureSpeechProviderEnv>;
  try {
    provider = getAzureSpeechProviderEnv();
  } catch {
    return jsonError("speech_unavailable", 503);
  }

  try {
    const response = await fetch(provider.tokenEndpoint, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": provider.key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });

    if (!response.ok) return jsonError("speech_unavailable", 502);

    const token = (await response.text()).trim();
    if (!isUsableProviderToken(token)) return jsonError("speech_unavailable", 502);

    return NextResponse.json(
      {
        token,
        region: provider.region,
        expiresAt: new Date(Date.now() + CLIENT_TOKEN_LIFETIME_MS).toISOString(),
      },
      { status: 200, headers: PRIVATE_NO_STORE_HEADERS }
    );
  } catch {
    return jsonError("speech_unavailable", 502);
  }
}
