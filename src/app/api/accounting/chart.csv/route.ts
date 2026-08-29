import { getProfile, currentFarmId, checkEntitlement, checkWorkshopEntitlement } from "@/lib/auth";
import { toCsv, csvResponse } from "@/app/(app)/reports/data";
import { chartGrid, isJournalScope, type JournalScope } from "@/lib/accounting";

export const dynamic = "force-dynamic";

/**
 * The chart of accounts the journal export posts to, as its own file.
 *
 * Separate from the journal on purpose: an import wizard reads row 1 of a CSV as the
 * header and everything after it as data, so a chart pasted into the top of the journal
 * is what makes the journal fail on line 1. The accountant needs both — one to set the
 * accounts up, one to post — and they are two files because they are two jobs.
 *
 * Gated identically to the journal itself. A denial is a 403, never a redirect.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });

  const scopeParam = new URL(request.url).searchParams.get("scope");
  const scope: JournalScope = isJournalScope(scopeParam)
    ? scopeParam
    : profile.role === "workshop"
      ? "partner"
      : "farm";

  if (scope === "partner") {
    if (profile.role !== "workshop") return new Response("Forbidden", { status: 403 });
    if (!(await checkWorkshopEntitlement("financials", profile)).allowed) {
      return new Response("Upgrade required", { status: 403 });
    }
  } else {
    if (!(await checkEntitlement("advanced_reports", profile)).allowed) {
      return new Response("Upgrade required", { status: 403 });
    }
    if (!(await currentFarmId(profile))) return new Response("Forbidden", { status: 403 });
  }

  return csvResponse(`chart-of-accounts-${scope}.csv`, toCsv(chartGrid(scope, profile.lang)));
}
