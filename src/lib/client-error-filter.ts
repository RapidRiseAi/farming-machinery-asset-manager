/**
 * Which browser errors are worth a report, for `<ClientErrorReporter/>`.
 *
 * Until now only error boundaries reported, so a failure outside rendering, a promise
 * nobody caught in a click handler, a script that threw after load, reached nobody. The
 * reporter listens for every uncaught error; this decides which are ours and worth
 * reading, and keeps one broken page from sending the same report hundreds of times.
 */

/** Messages that are browser or extension noise, not this app failing. */
const NOISE = [
  /^ResizeObserver loop/i, // a layout notice browsers raise as an error; harmless
  /^Script error\.?$/i, // a cross-origin script: no message, no stack, nothing to act on
  /^AbortError\b/i, // a request we cancelled on purpose
  /The operation was aborted/i,
  /^Non-Error promise rejection captured with value: undefined$/i,
];

/** A stack or file that only ever mentions an extension is not our code. */
const EXTENSION = /(chrome|moz|safari(-web)?)-extension:\/\//i;

export type ReportCandidate = {
  message: string;
  /** Where it came from, `ErrorEvent.filename`, when the browser says. */
  source?: string;
  stack?: string;
  /** Next's digest, present on its redirect and not-found signals. */
  digest?: string;
  name?: string;
};

export function shouldReport(candidate: ReportCandidate): boolean {
  const message = candidate.message.trim();
  if (!message) return false;
  if (candidate.name === "AbortError") return false;
  if (candidate.digest?.startsWith("NEXT_")) return false;
  if (NOISE.some((pattern) => pattern.test(message))) return false;
  if (candidate.source && EXTENSION.test(candidate.source)) return false;
  if (candidate.stack && EXTENSION.test(candidate.stack) && !/\/_next\//.test(candidate.stack)) return false;
  return true;
}

/**
 * At most `limit` reports per page load, and each distinct error once. A render loop or a
 * timer that throws every second would otherwise post until the tab closed.
 */
export function createReportGate(limit = 10): (candidate: ReportCandidate) => boolean {
  const seen = new Set<string>();
  return (candidate) => {
    if (seen.size >= limit) return false;
    const firstFrame = (candidate.stack ?? "").split("\n").find((line) => line.trim().startsWith("at ")) ?? "";
    const key = `${candidate.message.slice(0, 200)}|${firstFrame.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}
