import { NextResponse } from "next/server";

import { getProfile, currentFarmId, effectiveFarmRole, accessibleFarms } from "@/lib/auth";
import { canViewFarmCosts, readMachineFinancials } from "@/lib/cost-visibility";
import { createClient } from "@/lib/supabase/server";
import { readAll } from "@/lib/supabase/read-all";
import { isUuid } from "@/lib/ids";

/**
 * Everything this farm has put into FleetWise, as one JSON file.
 *
 * == Why it exists ============================================================
 * Closing a lapsed farm's access is only defensible because their records stay theirs.
 * The product has said "nothing is deleted" since the downgrade design shipped, and a
 * promise nobody can act on is not a promise. This is the acting-on-it.
 *
 * It is deliberately reachable while a farm is CLOSED: the gate lives in `(app)/layout.tsx`
 * and API routes are not inside it, so somebody who can no longer use the product can still
 * take their history with them. That is the point, not an oversight.
 *
 * == Scoping =================================================================
 * Every read goes through the CALLER's own client, so what comes back is exactly what this
 * person may read, by the same policies that govern every screen. RLS is the isolation. Each
 * read is ALSO filtered to the farm being worked in: that is narrowing, not isolation, the
 * same rule as the PDF packs. Without it a person on three farms got all three blended into
 * one file, and Rapid Rise in support mode got every farm on the platform.
 *
 * Money columns are granted only through the `_visible` projections (20260903074350,
 * 20260908112728), so those tables are read through them: a plain `select *` on the base
 * table is refused, and used to leave job cards, fuel, work and machines out of every
 * export. Machines are read by their readable columns, with the purchase and finance
 * figures added through `machine_financials` for a role that may see costs.
 *
 * The role check is a separate question from RLS: a farm's costs, suppliers and staff are
 * owner/manager material, and an operator who may legitimately read their own assigned
 * vehicles has no business pulling the whole book.
 */

/** Per table, so one enormous farm cannot produce a response nothing can open. */
const CAP = 5000;

/** Every column of `machines` a farm user may read, less the QR capture token. */
const MACHINE_COLUMNS =
  "id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type, status, " +
  "current_reading, current_reading_date, purchase_date, warranty_expiry_date, " +
  "warranty_expiry_hours, assigned_operator_id, location, notes, created_at, deleted_at, " +
  "cost_centre, department, primary_attachment_id";

/**
 * The tables a farm would actually want back, where each is read from, and the ordering
 * that makes the file readable. `attachments` carries metadata only, the files themselves
 * live in Storage and are served by signed URL; listing their paths without the bytes would
 * be a tease, so the export says so in `notes` rather than pretending.
 */
const TABLES: Array<{ name: string; source?: string; columns?: string; order?: string; farmColumn?: string }> = [
  { name: "farms", farmColumn: "id" },
  { name: "machines", columns: MACHINE_COLUMNS, order: "name" },
  { name: "meter_readings", order: "reading_date" },
  { name: "service_plan_lines" },
  { name: "job_cards", source: "job_cards_visible", order: "created_at" },
  { name: "job_card_lines", source: "job_card_lines_visible" },
  { name: "faults", order: "created_at" },
  { name: "cost_entries", order: "occurred_on" },
  { name: "fuel_issues", source: "fuel_issues_visible", order: "date" },
  { name: "fuel_deliveries", source: "fuel_deliveries_visible", order: "date" },
  { name: "licences", order: "expiry_date" },
  { name: "work_requests", source: "work_requests_visible", order: "created_at" },
  { name: "budgets" },
  { name: "stock_items" },
  { name: "checklist_instances", order: "created_at" },
  { name: "usage_logs", order: "occurred_on" },
  { name: "billing_invoices", order: "issued_on" },
];

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Not `requireProfile`, which redirects: a caller following that redirect would save the
  // login page as their data export. Same reasoning as the receipt route and the VAT ones.
  const profile = await getProfile();
  if (!profile || !profile.active) {
    return NextResponse.json({ error: "auth" }, { status: 401 });
  }
  // ?farm= names the farm a stopped page is about (a paused home farm, say, while another
  // farm is in use); it must be one the person reaches, and the role is checked on it below.
  const asked = new URL(request.url).searchParams.get("farm");
  const farmId = isUuid(asked) && (await accessibleFarms(profile)).some((f) => f.id === asked)
    ? asked
    : await currentFarmId(profile);
  if (!farmId) {
    return NextResponse.json({ error: "no-farm" }, { status: 403 });
  }

  const role = await effectiveFarmRole(farmId, profile);
  if (role !== "owner" && role !== "manager" && role !== "rr_admin") {
    // 403 rather than a redirect: this is a file endpoint, and handing a caller a page of
    // HTML with a .json name is worse than refusing.
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const supabase = await createClient();
  const bundle: Record<string, unknown> = {};
  const truncated: string[] = [];
  const unavailable: string[] = [];

  for (const spec of TABLES) {
    // Every page up to the cap: a single read stops at the API's thousandth row, so the cap
    // could never be reached and the note below said so while rows were missing.
    const { data, error, truncated: cut } = await readAll<Record<string, unknown>>(() => {
      const query = supabase
        .from(spec.source ?? spec.name)
        .select(spec.columns ?? "*")
        .eq(spec.farmColumn ?? "farm_id", farmId);
      return spec.order ? query.order(spec.order, { ascending: true }) : query;
    }, { maxRows: CAP });
    if (error) {
      // A table this deployment does not have, or one this role cannot read at all. Named
      // rather than silently absent, so nobody reads a missing section as "we had none".
      unavailable.push(spec.name);
      continue;
    }
    bundle[spec.name] = data ?? [];
    if (cut) truncated.push(spec.name);
  }

  // Purchase and finance figures, for a role that may see the farm's costs: they are not
  // readable from the table itself (20260903074350). Ten machines at a time.
  const machines = (bundle.machines as Record<string, unknown>[] | undefined) ?? [];
  if (machines.length > 0 && (await canViewFarmCosts(supabase, farmId))) {
    for (let i = 0; i < machines.length; i += 10) {
      const batch = machines.slice(i, i + 10);
      const figures = await Promise.all(batch.map((m) => readMachineFinancials(supabase, String(m.id))));
      batch.forEach((m, j) => {
        const f = figures[j];
        if (!f) return;
        const money: Record<string, unknown> = { ...f };
        delete money.machine_id;
        delete money.farm_id;
        Object.assign(m, money);
      });
    }
  }

  const body = {
    exported_at: new Date().toISOString(),
    farm_id: farmId,
    exported_by: profile.id,
    notes: [
      "Every table here is scoped by the same row-level security that governs the app, and " +
        "to this one farm, so it contains exactly what the person who asked for it may read.",
      "Photos, voice notes and uploaded documents are NOT in this file. They live in " +
        "storage and are referenced by path; ask team@rapidriseai.com for a copy of the files.",
      truncated.length
        ? `Capped at ${CAP} rows: ${truncated.join(", ")}. Ask us for the rest.`
        : `No table reached the ${CAP}-row cap.`,
      unavailable.length ? `Not available to this account: ${unavailable.join(", ")}.` : null,
    ].filter(Boolean),
    data: bundle,
  };

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="fleetwise-export-${stamp}.json"`,
      // Somebody's whole business history: never cached by a proxy, never stored by the
      // browser for the next person on a shared farm-office machine.
      "cache-control": "no-store, private",
    },
  });
}
