import { cookies } from "next/headers";

/**
 * Short-lived handoff of a contractor's access link, from the action that made it to the
 * card that shows it.
 *
 * The link and its code exist in plain form only here: the database keeps hashes, so this is
 * the one moment they can be shown. Neither is a sign-in by itself (the contractor still has
 * to prove their own email address), but together they are worth keeping out of a URL, where
 * they would land in the browser's synced history, in access logs and in the `Referer` of
 * anything the page loads. So they ride in a ten-minute, httpOnly, SameSite=Strict cookie
 * scoped to `/partners`, cleared when the farmer says they are done with it.
 */
export const PARTNER_LINK_COOKIE = "fw_partner_link";

/** Ten minutes is long enough to copy it into WhatsApp and short enough to matter. */
export const PARTNER_LINK_TTL_SECONDS = 600;

export type PartnerLink = { pid: string; url: string; code: string };

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
    if (typeof parsed?.pid !== "string" || typeof parsed?.url !== "string" || typeof parsed?.code !== "string") {
      return null;
    }
    // Only ever surface an http(s) link, this string is rendered into a message.
    const u = new URL(parsed.url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { pid: parsed.pid, url: parsed.url, code: parsed.code };
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
