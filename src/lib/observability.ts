import "server-only";

/**
 * Error reporting (NFR-6), without the SDK.
 *
 * ── Why not `@sentry/nextjs` ──────────────────────────────────────────────────
 *
 * This product is built for a mid-range Android on a farm with poor signal, and the shared
 * first-load bundle has been held at 102 kB for the entire project — every wave in
 * CLAUDE.md reports that number because it is a real constraint, not a vanity metric. The
 * official SDK is the single largest thing that could be added to it, and most of what it
 * buys (session replay, performance traces, breadcrumb capture) is weight a farmer pays for
 * so that we can watch.
 *
 * So this module speaks Sentry's ingest protocol directly over `fetch`. No dependency, no
 * client runtime, **zero bytes** added to the shared bundle. If a DSN is set it reports; if
 * not it falls through to `console.error`, which Vercel already collects — so the product
 * is never worse off than it is today, and turning it on is one environment variable.
 *
 * The trade is honest and worth stating: no automatic breadcrumbs, no release health, no
 * source-map symbolication unless someone uploads maps separately. What you get is the
 * thing that was actually missing — a stack trace, the route, the user and farm it happened
 * to, and a notification. If that proves too thin, swapping in the real SDK later touches
 * only this file's callers.
 *
 * ── What is deliberately NOT sent ─────────────────────────────────────────────
 *
 * `docs/POPIA.md` governs personal data. An error report carries the user's id and their
 * farm's id — both opaque uuids, needed to answer "is this one farm or all of them" — and
 * never their name, email, phone, or any row content. Query strings are dropped rather than
 * forwarded, because this codebase has put a login credential in one before (the contractor
 * `action_link`, fixed in the backend/security pass) and an error reporter must not become
 * the thing that exfiltrates the next one.
 */

type Level = "error" | "warning" | "info";

export type ErrorContext = {
  /** Where it happened — a route path, a cron step, a server action name. */
  where?: string;
  /** Opaque ids only. Never a name, email or phone. */
  userId?: string | null;
  farmId?: string | null;
  workshopId?: string | null;
  /** Anything else worth knowing. Keep it free of row content. */
  extra?: Record<string, string | number | boolean | null>;
  level?: Level;
};

type Dsn = { host: string; projectId: string; publicKey: string };

/**
 * `https://<publicKey>@<host>/<projectId>` — the only DSN shape Sentry issues.
 * Parsed once per process; a malformed DSN disables reporting rather than throwing, because
 * a typo in an environment variable must never take the app down with it.
 */
function parseDsn(raw: string | undefined): Dsn | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const projectId = u.pathname.replace(/^\/+/, "");
    if (!u.username || !u.host || !projectId) return null;
    return { host: u.host, projectId, publicKey: u.username };
  } catch {
    return null;
  }
}

let cached: Dsn | null | undefined;
function dsn(): Dsn | null {
  if (cached === undefined) cached = parseDsn(process.env.SENTRY_DSN);
  return cached;
}

/** Is reporting configured at all? Useful for a health check. */
export function observabilityEnabled(): boolean {
  return dsn() !== null;
}

function frames(stack: string | undefined) {
  if (!stack) return undefined;
  // Sentry renders frames innermost-last; a stack string is outermost-last, so reverse.
  const parsed = stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .map((line) => {
      const m = line.match(/^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (!m) return { function: line.replace(/^at\s+/, "") };
      return {
        function: m[1] || "<anonymous>",
        filename: m[2],
        lineno: Number(m[3]),
        colno: Number(m[4]),
      };
    });
  return parsed.length ? { frames: parsed.reverse() } : undefined;
}

/**
 * Report an error. Never throws and never rejects — an error in the error reporter must not
 * become the error the user sees. Fire-and-forget by design: nothing awaits delivery,
 * because a farmer waiting on a round trip to Sentry is a worse outcome than a lost report.
 */
export function captureError(err: unknown, ctx: ErrorContext = {}): void {
  const target = dsn();
  const error = err instanceof Error ? err : new Error(String(err));

  if (!target) {
    // No DSN: still surface it where Vercel's log drain will find it.
    console.error(`[observability]${ctx.where ? ` ${ctx.where}` : ""}`, error);
    return;
  }

  const event = {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "node",
    level: ctx.level ?? "error",
    logger: ctx.where ?? "app",
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    server_name: process.env.VERCEL_URL ?? undefined,
    exception: {
      values: [
        {
          type: error.name,
          value: error.message,
          stacktrace: frames(error.stack),
        },
      ],
    },
    tags: {
      where: ctx.where ?? "unknown",
      // Opaque ids only — see the header. These are what answer "one farm or all of them".
      farm: ctx.farmId ?? "none",
      workshop: ctx.workshopId ?? "none",
    },
    user: ctx.userId ? { id: ctx.userId } : undefined,
    extra: ctx.extra,
  };

  void fetch(`https://${target.host}/api/${target.projectId}/store/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.publicKey}, sentry_client=fleetwise/1.0`,
    },
    body: JSON.stringify(event),
    // Never let reporting hold a response open.
    signal: AbortSignal.timeout(3000),
  }).catch((e) => {
    console.error("[observability] could not report:", e instanceof Error ? e.message : e);
  });
}

/**
 * Run something and report if it throws, then rethrow. For wrapping a cron step, where the
 * point is that step 7 failing must be visible without stopping steps 8 through 11.
 */
export async function reporting<T>(where: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    captureError(e, { where });
    throw e;
  }
}
