/**
 * `fetch` that gives up. None of the screen's own requests had a limit, so on a stalled
 * farm connection a spinner turned for minutes and its button stayed disabled until the
 * browser itself gave up; the offline sync waited behind the same stalled request.
 *
 * Two minutes by default: long enough for a photo on slow signal, short enough that the
 * person is told and can try again. A timeout rejects like any network failure, so the
 * caller's existing catch shows its message.
 */
export const DEFAULT_TIMEOUT_MS = 120_000;

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The request took too long.", "TimeoutError")), timeoutMs);
  // A caller's own signal still cancels it.
  const forward = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener("abort", forward, { once: true });
  }
  try {
    return await fetch(input, { ...rest, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
