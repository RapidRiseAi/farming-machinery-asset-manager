"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const PREFIX = "fw:view:";

/**
 * Remembers which view of a books screen this device last chose, and reopens it.
 *
 * The period on `/money` and the window and bank balance on `/cashflow` were forgotten
 * on every visit, so somebody who always reads "This quarter", or who types the same
 * bank balance each Monday, set it again every time. This keeps the last choice in this
 * browser's localStorage (`fw:view:<key>`), never on the server: the bank balance in
 * particular is something the reader typed, not a fact the books hold.
 *
 *   · `value` is what THIS visit's URL chose, as the string to keep. `null` means the
 *     URL chose nothing, so the remembered view (if any) is restored with
 *     `router.replace`, which shows as the ordinary selected chip and is undone by
 *     choosing another. `""` forgets.
 *   · `restore` turns a remembered value into the URL that reopens it: a map of value
 *     to href (a remembered value that is no longer offered is dropped), or a fixed
 *     path that the remembered query string is appended to. Either way the result is a
 *     same-origin path this screen built, so a stored value cannot send anyone elsewhere.
 *
 * Renders nothing. Storage that is unavailable (private mode) simply remembers nothing.
 */
export function RememberView({
  storageKey,
  value,
  restore,
}: {
  storageKey: string;
  value: string | null;
  restore: Readonly<Record<string, string>> | string;
}) {
  const router = useRouter();
  const restoreKey = typeof restore === "string" ? restore : JSON.stringify(restore);

  useEffect(() => {
    const key = PREFIX + storageKey;
    try {
      if (value === null) {
        const saved = window.localStorage.getItem(key);
        if (!saved) return;
        const href =
          typeof restore === "string"
            ? /^[A-Za-z0-9=&%+._-]+$/.test(saved)
              ? `${restore}?${saved}`
              : null
            : restore[saved] ?? null;
        if (href) router.replace(href, { scroll: false });
        else window.localStorage.removeItem(key);
      } else if (value === "") {
        window.localStorage.removeItem(key);
      } else {
        window.localStorage.setItem(key, value);
      }
    } catch {
      /* storage unavailable: remembering is a convenience, not a requirement */
    }
    // `restore` is compared by content: a server-built object is a new one each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, value, restoreKey, router]);

  return null;
}
