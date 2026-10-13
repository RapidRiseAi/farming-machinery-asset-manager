/**
 * Claim a batch, handle it, claim the next, for as long as there is time.
 *
 * The shape every queue the nightly run works through needs (scheduled reports now,
 * notifications next): claiming everything in one call returned only the API's first
 * thousand rows, and whatever the function did not reach before its time limit sat claimed
 * and unhandled. Claiming a batch only when there is time to handle it means nothing is
 * claimed that is not about to be dealt with, and what is left stays queued for the next run.
 */
export async function drainInBatches<T>(
  claim: (limit: number) => Promise<{ rows: T[]; error?: string }>,
  handle: (row: T) => Promise<boolean>,
  options: { batch: number; budgetMs: number; now?: () => number },
): Promise<{ claimed: number; ok: number; failed: number; more: boolean; error?: string }> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.budgetMs;
  let claimed = 0;
  let ok = 0;
  let failed = 0;
  for (;;) {
    const { rows, error } = await claim(options.batch);
    if (error) return { claimed, ok, failed, more: false, error };
    claimed += rows.length;
    for (const row of rows) {
      if (await handle(row)) ok += 1;
      else failed += 1;
    }
    // A short batch means nothing else is waiting; a full one, that more may be.
    if (rows.length < options.batch) return { claimed, ok, failed, more: false };
    if (now() >= deadline) return { claimed, ok, failed, more: true };
  }
}
