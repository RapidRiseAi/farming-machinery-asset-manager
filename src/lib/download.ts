/**
 * The rules behind `DownloadLink`: what to call a downloaded file, and how to tell a file
 * from a failure. Pure, so both have tests; the component is the only caller.
 *
 * A download used to be a plain link, so every extra tap on a slow phone started another
 * download and another server render of the same PDF, and a failure arrived as a file:
 * an expired session saved the login page as `statement.pdf`. `DownloadLink` fetches the
 * file itself instead, which is what lets it ignore repeat taps and say what went wrong;
 * these functions read the response it gets back.
 */

/** Why a download did not produce a file. Each has its own sentence in `DownloadLabels`. */
export type DownloadFailure = "signed-out" | "not-allowed" | "not-found" | "busy" | "failed";

/**
 * The header the service worker looks for. A download must come from the server every
 * time: the worker answers other script requests from its cache first, which would hand
 * back yesterday's report as today's.
 */
export const DOWNLOAD_HEADER = "x-fw-download";

/** Pages the app sends a person to when their session cannot open the file. */
const SIGN_IN_PATHS = ["/login", "/mfa/", "/test-account", "/closed", "/billing/locked"];

/** What the response looked like, the parts of `Response` the classification needs. */
export type DownloadResponse = {
  ok: boolean;
  status: number;
  redirected: boolean;
  /** The final URL, after any redirects. */
  url: string;
  contentType: string | null;
};

/**
 * Null when the response is the file. Otherwise the reason, most specific first.
 *
 * A page coming back (HTML) is never the file: every file route here answers with a PDF,
 * CSV, spreadsheet or JSON body, so HTML means a redirect to a sign-in or error page, or
 * a server error page. Redirected to a sign-in path is "signed out"; any other HTML is a
 * plain failure rather than a guess.
 */
export function classifyDownload(res: DownloadResponse): DownloadFailure | null {
  if (res.redirected && SIGN_IN_PATHS.some((path) => pathOf(res.url).startsWith(path))) return "signed-out";
  if (res.status === 401) return "signed-out";
  if (res.status === 403) return "not-allowed";
  if (res.status === 404) return "not-found";
  if (res.status === 429) return "busy";
  if (!res.ok) return "failed";
  if ((res.contentType ?? "").toLowerCase().includes("text/html")) return "failed";
  return null;
}

function pathOf(url: string): string {
  try {
    return new URL(url, "http://local").pathname;
  } catch {
    return "";
  }
}

/** Characters no file system accepts in a name, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

function clean(name: string): string {
  return name.replace(UNSAFE, "-").replace(/^[.\s-]+|[.\s]+$/g, "").slice(0, 150);
}

/**
 * The file name the server gave in `Content-Disposition`, or `fallback`.
 *
 * Reads the RFC 6266 `filename*=UTF-8''...` form first (what a name with non-ASCII
 * characters needs), then the plain `filename="..."`. The result is cleaned of anything
 * a file system rejects, because the name is the server's word, not the person's.
 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (header) {
    const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (extended) {
      try {
        const name = clean(decodeURIComponent(extended[1].trim().replace(/^"|"$/g, "")));
        if (name) return name;
      } catch {
        /* malformed percent-encoding: fall through to the plain form */
      }
    }
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;\s]+))/.exec(header);
    const name = clean((plain?.[1] ?? plain?.[2] ?? "").trim());
    if (name) return name;
  }
  return clean(fallback) || "download";
}

/** A name from the link itself when the server gave none: the last part of its path. */
export function filenameFromHref(href: string): string {
  const last = pathOf(href).split("/").filter(Boolean).pop() ?? "";
  try {
    return clean(decodeURIComponent(last)) || "download";
  } catch {
    return clean(last) || "download";
  }
}
