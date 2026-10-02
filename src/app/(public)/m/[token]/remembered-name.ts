import { cookies } from "next/headers";

/**
 * The worker's name, remembered on their own phone for the next scan.
 *
 * == Why a cookie and not the database =======================================
 * The QR page has ZERO anonymous database access, and a name lookup would be the
 * first. A driver who scans every morning typed his name every morning; the phone in
 * his hand already knows who he is, so the phone keeps it. httpOnly, scoped to the
 * kiosk path, set only by the kiosk's own server actions after a capture succeeds.
 *
 * == Clearing it =============================================================
 * Submitting with the name field emptied forgets it. A borrowed phone therefore
 * corrects itself the first time the borrower changes the name, and no extra button
 * or script is needed on a page that must work without JavaScript.
 *
 * Plain module, no "use server": a "use server" file may export only async actions,
 * and the page needs the reader too.
 */
export const QR_NAME_COOKIE = "fw_qr_name";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const MAX_NAME = 200;

/** The remembered name, or null. Reads a cookie only. */
export async function readRememberedName(): Promise<string | null> {
  const raw = (await cookies()).get(QR_NAME_COOKIE)?.value?.trim();
  if (!raw) return null;
  return raw.slice(0, MAX_NAME);
}

/** Remember `name` for next time, or forget it when the person cleared the field. */
export async function rememberName(name: string | null): Promise<void> {
  const jar = await cookies();
  const value = name?.trim().slice(0, MAX_NAME) ?? "";
  if (!value) {
    if (jar.get(QR_NAME_COOKIE)) jar.delete({ name: QR_NAME_COOKIE, path: "/m" });
    return;
  }
  jar.set(QR_NAME_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/m",
    maxAge: ONE_YEAR_SECONDS,
  });
}

/**
 * How long a "sent" link stays a confirmation. The kiosk's redirect carries the time
 * it was made (`at`); a refresh or a tab reopened later than this shows the chooser
 * again instead of thanking somebody for a report this visit never sent.
 *
 * The fault form's link is stamped when the page renders, not when it submits (it is
 * handed to the form up front), so the window allows for a slow report.
 */
export const SENT_FRESH_MS = 3 * 60 * 60 * 1000;

/** The confirmation URL for a capture that just succeeded. */
export function sentHref(token: string, kind: "fault" | "reading" | "fuel", at = Date.now()): string {
  const routeToken = encodeURIComponent(token || "invalid");
  return `/m/${routeToken}?sent=${kind}&at=${at}`;
}

/** Which confirmation to show, or null when the link is missing, unknown or stale. */
export function freshSent(
  sent: string | undefined,
  at: string | undefined,
  now = Date.now(),
): "fault" | "reading" | "fuel" | null {
  if (!sent) return null;
  const stamp = Number(at);
  if (!Number.isFinite(stamp)) return null;
  const age = now - stamp;
  // A small negative age is clock skew between instances, not a forged link.
  if (age < -60_000 || age > SENT_FRESH_MS) return null;
  if (sent === "fuel" || sent === "reading") return sent;
  // "fault", and the "1" older fault links used.
  return "fault";
}
