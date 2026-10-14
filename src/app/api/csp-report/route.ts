import { NextResponse } from "next/server";

/**
 * Where browsers report what the report-only content security policy (next.config.mjs)
 * would have blocked. Logged as one compact line each, read in the Vercel logs, so the policy
 * can be tightened and then enforced. Nothing is blocked while it is report-only.
 *
 * Open to anyone, as browsers send these without a session, so it stores nothing and logs
 * only the directive, the blocked origin and the page's path: never a query string, which in
 * this codebase has carried a credential before.
 */

export const dynamic = "force-dynamic";

/** A report is a few hundred bytes; anything far larger is not one. */
const MAX_BYTES = 16 * 1024;

function originOf(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  try {
    const u = new URL(value);
    return u.protocol === "data:" || u.protocol === "blob:" ? u.protocol : u.origin;
  } catch {
    return value.slice(0, 40); // "inline", "eval", "self"
  }
}

function pathOf(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    return new URL(value).pathname.slice(0, 120);
  } catch {
    return "";
  }
}

export async function POST(request: Request) {
  const text = await request.text().catch(() => "");
  if (text.length === 0 || text.length > MAX_BYTES) return new NextResponse(null, { status: 204 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  // The legacy report-uri shape ({ "csp-report": {...} }) or the Reporting API's array.
  const reports = Array.isArray(body)
    ? body.map((r) => (r as { body?: Record<string, unknown> })?.body ?? {})
    : [((body as { "csp-report"?: Record<string, unknown> })?.["csp-report"] ?? {})];
  for (const r of reports.slice(0, 5)) {
    const directive = String(r["effective-directive"] ?? r.effectiveDirective ?? r["violated-directive"] ?? "?").slice(0, 40);
    const blocked = originOf(r["blocked-uri"] ?? r.blockedURL);
    const page = pathOf(r["document-uri"] ?? r.documentURL);
    console.warn(`csp-report-only ${directive} blocked=${blocked} page=${page}`);
  }
  return new NextResponse(null, { status: 204 });
}
