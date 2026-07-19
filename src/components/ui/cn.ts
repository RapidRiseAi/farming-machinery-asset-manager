/**
 * Tiny className joiner. Filters falsy values and joins with spaces — no
 * dependency (keeps the mobile bundle lean, Scope §7). Later strings win by
 * source order only; this does not de-duplicate conflicting Tailwind classes,
 * so pass overrides last and avoid contradictory utilities in one call.
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
