/**
 * Free-text terms that are about to be spliced into a PostgREST filter.
 *
 * `or=(name.ilike.%x%,make.ilike.%x%)` is parsed as an EXPRESSION, not as a
 * value, so a comma or a parenthesis inside `x` ends one condition and begins
 * another. Row-level security still bounds the result to rows the caller may
 * read, so the ceiling on this is "somebody filters their own data in a way the
 * interface did not intend" rather than a cross-tenant leak — but a string
 * going to a parser should not arrive unexamined, and the day somebody reuses
 * the pattern on a query that is not RLS-bounded, the habit is what saves it.
 *
 * The punctuation is REMOVED rather than escaped: PostgREST has no escape for
 * these inside `or=(…)`, and none of them is meaningful in a machine's name, a
 * make, a model or a registration. `%` and `*` go too — they are LIKE
 * wildcards, so a lone `%` would otherwise match the entire table.
 */
export function sanitiseFilterTerm(raw: string, maxLength = 60): string {
  return raw
    .replace(/[,()."'\\%*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
