/**
 * The support desk's own refusals, by the words its SQL raises.
 *
 * The support functions (20261028100900 to 20261028101300) refuse on purpose with a slug
 * as the message: `support-slow-down` from the rate limit, `support-farm-not-yours` when a
 * farm was chosen that the person is not on, and so on. `errorCode()` keeps a refusal's
 * words only for the codes it knows are refusals (22023, P0001 and two constraint codes),
 * so a 42501 slug would be shown as "forbidden" and the rate limit's 53400 as "try again"
 * and reported as our fault. This picks out the ones that are the person's to fix, so the
 * action can put the slug in `?error=` and `lib/errors.ts` can say it in their language.
 *
 * Plain module (no "server-only"): the actions import it and the unit test pins it.
 */

export const SUPPORT_REFUSALS = [
  "support-slow-down",
  "support-farm-not-yours",
  "support-export-owner",
  "support-kind-invalid",
  "support-need-message",
  "support-message-long",
  "support-closed",
  "support-status-invalid",
  "support-need-resolution",
  "support-assignee-invalid",
  "support-person-invalid",
  "support-channel-invalid",
  "support-no-customer",
  "support-visit-reason",
  "support-visit-ticket",
  "support-visit-farm",
  "support-settings-invalid",
  "support-holiday-invalid",
  "admin-user-invalid",
  "admin-user-self",
] as const;

export type SupportRefusal = (typeof SUPPORT_REFUSALS)[number] | "help-too-many";

const KNOWN = new Set<string>(SUPPORT_REFUSALS);

/**
 * The slug to show for a refusal the support SQL raised on purpose, or null when the
 * failure is something else (which the caller hands to `errorCode()` to report).
 */
export function supportRefusal(error: { code?: string; message?: string } | null | undefined): SupportRefusal | null {
  if (!error) return null;
  // The five-open ceiling (open_help_request) and the per-person message limit.
  if (error.code === "53000") return "help-too-many";
  if (error.code === "53400") return "support-slow-down";
  const message = (error.message ?? "").trim();
  return KNOWN.has(message) ? (message as SupportRefusal) : null;
}
