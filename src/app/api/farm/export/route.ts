import { NextResponse } from "next/server";

import { requireProfile, currentFarmId, effectiveFarmRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Everything this farm has put into FleetWise, as one JSON file.
 *
 * ── Why it exists ────────────────────────────────────────────────────────────
 * Closing a lapsed farm's access is only defensible because their records stay theirs.
 * The product has said "nothing is deleted" since the downgrade design shipped, and a
 * promise nobody can act on is not a promise. This is the acting-on-it.
 *
 * It is deliberately reachable while a farm is CLOSED: the gate lives in `(app)/layout.tsx`
 * and API routes are not inside it, so somebody who can no longer use the product can still
 * take their history with them. That is the point, not an oversight.
 *
 * ── Scoping is RLS's job, not this file's ────────────────────────────────────
 * Every read goes through the CALLER's own client. There is no `farm_id` filter written
 * here for the farm-scoped tables, because adding one would imply the export is trusted to
 * scope itself — and then a table added later without that filter would leak. What comes
 * back is exactly what this person is allowed to read, by the same policies that govern
 * every screen. Multi-site users get the farm they are currently working in, for the same
 * reason the dashboard does.
 *
 * The role check is a separate question from RLS: a farm's costs, suppliers and staff are
 * owner/manager material, and an operator who may legitimately read their own assigned
 * vehicles has no business pulling the whole book.
 */

/** Per table, so one enormous farm cannot produce a response nothing can open. */
const CAP = 5000;

/**
 * The tables a farm would actually want back, with the ordering that makes the file
 * readable. `attachments` carries metadata only — the files themselves live in Storage and
 * are served by signed URL; listing their paths without the bytes would be a tease, so the
 * export says so in `notes` rather than pretending.
 */
const TABLES: Array<{ name: string; order?: string }> = [
  { name: "farms" },
  { name: "machines", order: "name" },
  { name: "meter_readings", order: "reading_at" },
  { name: "service_plan_lines" },
  { name: "job_cards", order: "opened_at" },
  { name: "job_card_lines" },
  { name: "faults", order: "reported_at" },
  { name: "cost_entries", order: "incurred_on" },
  { name: "fuel_issues", order: "issued_at" },
  { name: "fuel_deliveries", order: "delivered_at" },
  { name: "licences", order: "expiry_date" },
  { name: "work_requests", order: "created_at" },
  { name: "budgets" },
  { name: "stock_items" },
  { name: "checklist_instances", order: "created_at" },
  { name: "usage_logs", order: "started_at" },
  { name: "billing_invoices", order: "issued_on" },
];

export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await requireProfile();
  const farmId = await currentFarmId(profile);
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
    let query = supabase.from(spec.name).select("*").limit(CAP);
    if (spec.order) query = query.order(spec.order, { ascending: true });
    const { data, error } = await query;
    if (error) {
      // A table this deployment does not have, or one this role cannot read at all. Named
      // rather than silently absent, so nobody reads a missing section as "we had none".
      unavailable.push(spec.name);
      continue;
    }
    bundle[spec.name] = data ?? [];
    if ((data?.length ?? 0) >= CAP) truncated.push(spec.name);
  }

  const body = {
    exported_at: new Date().toISOString(),
    farm_id: farmId,
    exported_by: profile.id,
    notes: [
      "Every table here is scoped by the same row-level security that governs the app, so " +
        "this contains exactly what the person who asked for it may read.",
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
