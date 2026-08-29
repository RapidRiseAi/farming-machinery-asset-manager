import { headers } from "next/headers";
import { t, type Lang } from "@/lib/i18n";

/**
 * Where an audited action happened (FR-1.4).
 *
 * `audit_log` has recorded who and when since 0008. The spec asked for where and it was
 * never built. The audit trigger is database-side and cannot see an HTTP request, so the
 * server has to hand the context in.
 *
 * ── The boundary, because this is the shape that goes wrong ─────────────────
 *
 * Everything below is CLIENT-SUPPLIED. `x-forwarded-for` is a header, geo is derived
 * from it at the edge, and a user agent is whatever the caller typed. Migration 0510
 * therefore keeps all of it inside its own `fleetwise.*` GUC namespace, never
 * `request.jwt.*`; `audit_log.user_id` still comes from `auth.uid()`, and no RLS policy
 * or `app.*` helper reads the namespace (asserted structurally in G33). So the worst a
 * forged value can do is record a WRONG CITY beside a correctly-attributed action.
 *
 * Which is why this is presented as a signal a human reads, never as evidence, and why
 * nothing in the product branches on it.
 *
 * ── Why a header and not a set_config ───────────────────────────────────────
 *
 * The documented pattern is a per-request `set_config` in a custom namespace. supabase-js
 * cannot do that: it issues one HTTP request per statement, so there is no transaction to
 * hold a session GUC across, and a session-level `set_config` would leak into the next
 * user of a pooled connection. PostgREST already exposes every request header to Postgres
 * as `request.headers`, so the context rides in as a header and `app.audit_context()`
 * reads it there — with the `fleetwise.*` settings still honoured first, for callers that
 * DO own their transaction (an RPC, a server-side job, the test harness).
 *
 * `x-forwarded-for` and `user-agent` reach Supabase on their own. Vercel's geo headers do
 * not — those are on the request to Vercel, not to Supabase — so the server client
 * forwards them as one `x-fleetwise-geo`. See pending/accounting/middleware.md for the
 * single change that turns this on; until it is applied, the columns stay null and
 * nothing else about the product changes.
 */

/** The one header the Next.js server adds. `country/region/city`, any part may be empty. */
export const GEO_HEADER = "x-fleetwise-geo";

export type RequestGeo = {
  country: string | null;
  region: string | null;
  city: string | null;
};

/**
 * Vercel's geo headers, read from the incoming request.
 *
 * Deliberately NOT latitude/longitude, which Vercel also offers, and deliberately not
 * the browser Geolocation API: this is an audit trail, not a tracker. docs/POPIA.md
 * governs what may be collected, and city-level is both the most that helps a human
 * ("this was approved from an unfamiliar city at 02:00") and the least that does.
 */
export async function requestGeo(): Promise<RequestGeo> {
  const h = await headers();
  const pick = (name: string) => {
    const v = h.get(name);
    const trimmed = v?.trim() ?? "";
    if (!trimmed) return null;
    // Vercel percent-encodes non-ASCII city names ("Pieterse%20Burg").
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  };
  return {
    country: pick("x-vercel-ip-country"),
    region: pick("x-vercel-ip-country-region"),
    city: pick("x-vercel-ip-city"),
  };
}

/**
 * Pack geo into the single header `app.audit_context()` parses. Slashes are stripped
 * from each part rather than escaped: the parser splits on `/`, and a city called
 * "Foo/Bar" recording as "FooBar" is better than one that shifts every field along.
 * Returns null when the edge told us nothing, so no empty header is sent.
 */
export function geoHeaderValue(geo: RequestGeo): string | null {
  const clean = (v: string | null, max: number) =>
    (v ?? "").replace(/[/\r\n]/g, " ").trim().slice(0, max);
  const value = [clean(geo.country, 8), clean(geo.region, 60), clean(geo.city, 80)].join("/");
  return value === "//" ? null : value;
}

/** The headers a Supabase client should carry so writes record where they came from. */
export async function auditContextHeaders(): Promise<Record<string, string>> {
  const value = geoHeaderValue(await requestGeo());
  return value ? { [GEO_HEADER]: value } : {};
}

// ── Reading it back ──────────────────────────────────────────────────────────

export type AuditLocation = {
  ip?: string | null;
  geo_country?: string | null;
  geo_region?: string | null;
  geo_city?: string | null;
  user_agent?: string | null;
};

/**
 * One short phrase for a timeline or a table cell: "Bloemfontein, ZA" — or the IP when
 * the edge had no geo, which is the honest fallback rather than an invented "Unknown".
 * Returns null when there is genuinely nothing to show, so a caller can render nothing
 * instead of an empty parenthesis.
 */
export function auditPlace(row: AuditLocation | null | undefined): string | null {
  if (!row) return null;
  const parts = [row.geo_city, row.geo_region, row.geo_country]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  // City and region are frequently the same string at the edge ("Gauteng, Gauteng").
  const deduped = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  if (deduped.length) return deduped.join(", ");
  return row.ip?.trim() || null;
}

/**
 * The same thing with the leading preposition, translated — "from Bloemfontein, ZA".
 * Null when there is nothing to say, so the caller renders no fragment at all.
 */
export function auditPlaceLabel(row: AuditLocation | null | undefined, locale: Lang): string | null {
  const place = auditPlace(row);
  return place ? t("audit.fromPlace", locale).replace("{place}", place) : null;
}

/**
 * A device word from a user agent — "Android phone", "iPhone", "Windows computer".
 *
 * Coarse on purpose. The full string is stored and can be read by anyone entitled to the
 * row, but rendering 250 characters of `Mozilla/5.0 (Linux; Android 13; SM-A536B)` in a
 * timeline tells a farmer nothing they can act on, and the question they are actually
 * asking is "was that from the office computer or somebody's phone".
 */
// ── Which audit rows are worth showing a human ───────────────────────────────

export type AuditRow = AuditLocation & {
  id: number | string;
  user_id: string | null;
  action: string;
  at: string;
  diff: { old?: Record<string, unknown>; new?: Record<string, unknown> } | null;
};

/**
 * Columns on `machines` that the product writes to BY ITSELF, with no human involved.
 *
 * Every meter reading fires `app_meter_reading_after` (0202), which advances
 * `current_reading` and stamps its date — so on a working tractor the great majority of
 * `machines` audit rows are the engine, not a person. The expiry engine (0263) does the
 * same with its two dedupe columns. An audit view that showed all of them would bury the
 * one row somebody is actually looking for.
 *
 * Named explicitly rather than guessed at, so adding an engine means adding a line here
 * and the omission is visible instead of silent. Note what is deliberately ABSENT:
 * `status`, which the fault trigger (0235) writes when a vehicle goes out of service —
 * that is a real event with a real cause and belongs on the list.
 */
export const AUTOMATIC_MACHINE_COLUMNS = new Set([
  "current_reading",
  "current_reading_date",
  "warranty_notified_status",
  "warranty_notified_at",
  "updated_at",
]);

/** The column names an update actually changed, from the audit trigger's before/after. */
export function changedColumns(row: AuditRow): string[] {
  const before = row.diff?.old;
  const after = row.diff?.new;
  if (!before || !after) return [];
  return Object.keys(after).filter(
    (k) => JSON.stringify(after[k]) !== JSON.stringify((before as Record<string, unknown>)[k])
  );
}

/**
 * Did a person do this? An insert or a delete always counts; an update counts only if it
 * touched something outside the automatic set. A row that changed nothing at all counts
 * as automatic — an UPDATE that moved no column is a re-save, not a decision.
 */
export function isHumanChange(row: AuditRow, automatic = AUTOMATIC_MACHINE_COLUMNS): boolean {
  if (row.action !== "update") return true;
  const changed = changedColumns(row);
  return changed.length > 0 && changed.some((c) => !automatic.has(c));
}

export function auditDevice(row: AuditLocation | null | undefined, locale: Lang): string | null {
  const ua = row?.user_agent?.trim();
  if (!ua) return null;
  const s = ua.toLowerCase();
  const key =
    s.includes("iphone") ? "iphone"
    : s.includes("ipad") ? "ipad"
    : s.includes("android") ? (s.includes("mobile") ? "androidPhone" : "androidTablet")
    : s.includes("windows") ? "windows"
    : s.includes("mac os") || s.includes("macintosh") ? "mac"
    : s.includes("linux") ? "linux"
    : null;
  return key ? t(`audit.device${key.charAt(0).toUpperCase()}${key.slice(1)}`, locale) : null;
}
