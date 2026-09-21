/**
 * Vocabulary shared by the two places that classify a request.
 *
 * `local-read.ts` decides whether a sentence is a read it can answer without a
 * provider. `parser.ts` decides which deterministic intent it carries. Both kept
 * their own copy of "words that mean service timing", and the copies had drifted
 * in OPPOSITE directions: the local reader knew `verskuldig` but not `volgende`,
 * the parser knew `soon` but not `binnekort`. So the same question took a
 * different route depending on the language it was asked in, and before
 * `serviceDueAnswer` was shared, one route answered it precisely while the other
 * replied with the fleet sentence.
 *
 * Keep both languages in one list. A word added for English belongs here with its
 * Afrikaans counterpart beside it, where an omission is visible on the same line
 * instead of hiding in another file.
 */
export const SERVICE_DUE_CUE =
  /\b(due|next|overdue|soon|verskuldig|volgende|agterstallig|binnekort)\b/;

/**
 * Words saying a request is about machines rather than documents, faults or job
 * cards. Singular forms included: "is the machine due for service" is the same
 * question as "which machines are due".
 */
export const FLEET_SCOPE_CUE =
  /\b(machine|machines|asset|assets|fleet|masjien|masjiene|bate|bates|vloot)\b/;
