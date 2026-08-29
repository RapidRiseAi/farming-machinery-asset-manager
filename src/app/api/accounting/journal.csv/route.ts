import { getProfile, currentWorkshop, currentFarmId, checkEntitlement, checkWorkshopEntitlement } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { toCsv, csvResponse } from "@/app/(app)/reports/data";
import {
  journalGrid, journalFilename, isJournalScope, isJournalLayout,
  type JournalLine, type JournalScope, type JournalLayout,
} from "@/lib/accounting";

export const dynamic = "force-dynamic";

/**
 * The general journal as a spreadsheet (FR-17.2).
 *
 * Every status here is a STATUS. A CSV endpoint that answers a denial with a 302 to an
 * HTML page hands the caller a "CSV" full of markup, which is the failure F5 recorded
 * when it gated the farm-side report exports, and 0492 repeated for the VAT routes.
 *
 * Gating, per the F5 rule of enforcing at the route AND the action:
 *   partner side → `financials` (the `books` product, 0492)
 *   farm side    → `advanced_reports` (Professional+, 0251)
 *
 * The rows come from `app.partner_journal` / `app.farm_journal` (0510), which are
 * SECURITY INVOKER — so RLS, not this route, decides whose books are summed. The
 * entitlement check is about who may ASK, and it runs before any query.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const scopeParam = url.searchParams.get("scope");
  const scope: JournalScope = isJournalScope(scopeParam)
    ? scopeParam
    : profile.role === "workshop"
      ? "partner"
      : "farm";
  const layoutParam = url.searchParams.get("layout");
  const layout: JournalLayout = isJournalLayout(layoutParam) ? layoutParam : "dc";

  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return new Response("Bad request", { status: 400 });
  }

  const supabase = await createClient();
  let lines: JournalLine[] = [];

  if (scope === "partner") {
    if (profile.role !== "workshop") return new Response("Forbidden", { status: 403 });
    if (!(await checkWorkshopEntitlement("financials", profile)).allowed) {
      return new Response("Upgrade required", { status: 403 });
    }
    const { workshop } = await currentWorkshop(profile);
    if (!workshop) return new Response("Forbidden", { status: 403 });
    const { data } = await supabase.rpc("partner_journal", {
      p_workshop: workshop.id, p_from: from, p_to: to,
    });
    lines = (data ?? []) as JournalLine[];
  } else {
    if (!(await checkEntitlement("advanced_reports", profile)).allowed) {
      return new Response("Upgrade required", { status: 403 });
    }
    // Multi-site (F7): the journal is for the farm the user is currently in, not a
    // union of everything they can reach — a set of books belongs to one entity.
    const farmId = await currentFarmId(profile);
    if (!farmId) return new Response("Forbidden", { status: 403 });
    const { data } = await supabase.rpc("farm_journal", {
      p_farm: farmId, p_from: from, p_to: to,
    });
    lines = (data ?? []) as JournalLine[];
  }

  const grid = journalGrid(lines, layout, profile.lang);
  return csvResponse(journalFilename(scope, from, to), toCsv(grid));
}
