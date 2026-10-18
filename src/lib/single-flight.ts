/**
 * One run at a time. The rule under every button that does work when tapped.
 *
 * On a farm phone a slow answer looks like a tap that did not register, so people tap
 * again, and again. A button whose work is already running must ignore those taps rather
 * than start the work a second time: a second email, a second record, a second download.
 *
 * The lock is a plain variable, not React state, on purpose: state only changes on the
 * next render, so two taps inside one frame would both see "not busy". A variable is set
 * before the first tap's work even starts.
 */
export type SingleFlight<A extends unknown[]> = {
  /** Starts `fn` unless a run is in flight; resolves true if this call ran it. */
  run: (...args: A) => Promise<boolean>;
  readonly running: boolean;
};

export function createSingleFlight<A extends unknown[]>(fn: (...args: A) => Promise<unknown>): SingleFlight<A> {
  let running = false;
  return {
    get running() {
      return running;
    },
    async run(...args: A) {
      if (running) return false;
      running = true;
      try {
        await fn(...args);
        return true;
      } finally {
        running = false;
      }
    },
  };
}

/**
 * Next's own signals, thrown by `redirect()` and `notFound()` through a server action
 * the browser awaited. They are navigation, not failure: never reported, never shown.
 */
export function isNavigationSignal(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("digest" in error)) return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/** An Error for anything thrown, so the report has a message and a stack to show. */
export function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error) ?? String(error));
  } catch {
    return new Error(String(error));
  }
}

/**
 * Did this fail because the connection did, rather than because the server said no?
 *
 * What a dropped connection looks like varies by browser: Chrome "Failed to fetch",
 * Firefox "NetworkError when attempting to fetch resource.", Safari "Load failed", Node's
 * fetch "fetch failed". A server action whose request never got an answer rejects with one
 * of these, and the honest thing to tell the person is different: the save may or may not
 * have landed, so check before entering it again.
 */
export function isConnectionFailure(error: unknown, online = true): boolean {
  if (!online) return true;
  if (!(error instanceof Error)) return false;
  return /failed to fetch|networkerror|load failed|fetch failed|network request failed|internet connection appears to be offline|err_internet_disconnected|connection (was )?(reset|closed|lost)/i.test(
    error.message,
  );
}
