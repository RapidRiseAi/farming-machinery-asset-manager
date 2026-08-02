import { cookies } from "next/headers";

/**
 * Short-lived handoff for a contractor's magic login URL.
 *
 * The invite flow used to hand the URL back in the query string:
 *
 *     redirect(`/partners?connected=1&pid=${id}&loginUrl=${encodeURIComponent(url)}`)
 *
 * A Supabase `action_link` is a BEARER CREDENTIAL — whoever holds it signs in as that
 * contractor and reaches every farm the contractor is linked to. In a query string it
 * lands in the browser's history (which syncs across devices), in the platform's access
 * logs (query strings are logged), in the `Referer` header of any outbound request the
 * page makes, and in the address bar for anyone standing behind the farmer. The back
 * button restores it. None of that is recoverable once it has happened.
 *
 * So the link never travels in a URL now. It goes in a short-lived, httpOnly,
 * SameSite=Strict cookie scoped to `/partners`, read once by the server render and
 * cleared explicitly when the farmer says they are done with it (or by its own TTL).
 * httpOnly matters: no client script can read it, so an injected script or a browser
 * extension cannot lift the credential off the page.
 */
export const PARTNER_LINK_COOKIE = "fw_partner_link";

/** Ten minutes is long enough to copy it into WhatsApp and short enough to matter. */
export const PARTNER_LINK_TTL_SECONDS = 600;

export type PartnerLink = { pid: string; url: string };

export async function setPartnerLink(link: PartnerLink): Promise<void> {
  (await cookies()).set(PARTNER_LINK_COOKIE, JSON.stringify(link), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/partners",
    maxAge: PARTNER_LINK_TTL_SECONDS,
  });
}

/** The pending link, if one is still in its window. Never throws on a malformed value. */
export async function readPartnerLink(): Promise<PartnerLink | null> {
  const raw = (await cookies()).get(PARTNER_LINK_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PartnerLink>;
    if (typeof parsed?.pid !== "string" || typeof parsed?.url !== "string") return null;
    // Only ever surface an http(s) link — this string is rendered into an anchor.
    const u = new URL(parsed.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { pid: parsed.pid, url: parsed.url };
  } catch {
    return null;
  }
}

export async function clearPartnerLink(): Promise<void> {
  (await cookies()).set(PARTNER_LINK_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/partners",
    maxAge: 0,
  });
}
