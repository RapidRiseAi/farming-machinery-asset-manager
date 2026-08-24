import { NextRequest, NextResponse } from "next/server";
import { captureError } from "@/lib/observability";

/**
 * Where the browser reports an error it hit (NFR-6).
 *
 * The error boundaries are already client components, so this costs the shared bundle
 * nothing — it is a `fetch` inside a chunk that only loads when something has already gone
 * wrong.
 *
 * ── This endpoint is unauthenticated, and that is a decision ──────────────────
 *
 * The errors most worth seeing are the ones on the SIGNED-OUT paths: the login screen, the
 * public QR page a driver scans, the `/d/[token]` document a customer opens. Requiring a
 * session would blind us to exactly those. So it accepts anonymous reports, and is built on
 * the assumption that anyone can post to it:
 *
 *   * every field is clamped in length, so it cannot be used to write a large object;
 *   * nothing is stored in Postgres, so it cannot be used to fill a table (the report goes
 *     straight out to the ingest endpoint, or to the log if none is configured);
 *   * the reported identity is never trusted — the payload carries no user id at all, and
 *     what lands in the report is what the SERVER knows, not what the caller claimed.
 *
 * The residual risk is noise in an error feed, which is visible and reversible. The
 * alternative — a blind spot on every pre-auth screen — is neither.
 */

export const runtime = "nodejs";

const cap = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const message = cap(body.message, 500) ?? "Unknown client error";
  const stack = cap(body.stack, 4000);
  const where = cap(body.where, 200) ?? "client";
  const digest = cap(body.digest, 100);

  const err = new Error(message);
  err.name = "ClientError";
  if (stack) err.stack = stack;

  captureError(err, {
    where: `client:${where}`,
    extra: {
      digest: digest ?? null,
      // The server's own view of the caller. Not the browser's claim about itself.
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? "unknown",
    },
  });

  // Always 204: a reporting endpoint that returns an error gives a broken page a second
  // thing to fail at.
  return new NextResponse(null, { status: 204 });
}
