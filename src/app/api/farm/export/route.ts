import { NextResponse } from "next/server";

import { getProfile, currentFarmId, effectiveFarmRole, accessibleFarms } from "@/lib/auth";
import { farmBillingGate } from "@/lib/billing/service";
import { canViewFarmCosts, readMachineFinancials } from "@/lib/cost-visibility";
import { captureError } from "@/lib/observability";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { readAll } from "@/lib/supabase/read-all";
import { isUuid } from "@/lib/ids";

/**
 * Everything this farm has put into FLEETWISE, as one JSON file.
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
/** `key`: the unique column paging ends on, for a table without an `id`. */
const TABLES: Array<{ name: string; source?: string; columns?: string; order?: string; farmColumn?: string; key?: string }> = [
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
  // Added 2026-11-05 (launch tracker "Farm export: finance tables and large farms"): the
  // finance and lease records, and the operational tables built since this list was made.
  // Finance rows come back only for a role that may read them (`can_view_farm_finance`);
  // a manager without that sees the tables named as unavailable rather than empty.
  { name: "finance_agreements", order: "created_at" },
  { name: "finance_instalments", order: "due_date" },
  { name: "asset_contracts", order: "created_at" },
  { name: "fuel_tanks" },
  { name: "fuel_dips", order: "created_at" },
  { name: "meter_replacements", order: "created_at" },
  { name: "asset_aliases" },
  { name: "watch_items", order: "created_at" },
  { name: "stock_movements", source: "stock_movements_visible", order: "created_at" },
  { name: "service_kits" },
  { name: "checklist_templates" },
  // No id column: its key is the (job card, service line) pair.
  { name: "job_card_service_lines", order: "service_plan_line_id", key: "job_card_id" },
  { name: "tyres" },
  { name: "tyre_fitments", order: "created_at" },
  { name: "tyre_checks", order: "created_at" },
  { name: "incidents", order: "created_at" },
  { name: "warranty_claims", order: "created_at" },
  { name: "fines", order: "created_at" },
  { name: "driver_credentials" },
  { name: "driving_sessions", order: "created_at" },
  { name: "driving_events", order: "occurred_at" },
  { name: "user_farm_memberships" },
  { name: "attachments", order: "created_at" },
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
  // A business that has never paid reads none of its records through its own session
  // (20261112090000). An export now would be a file of empty tables that looks whole, and
  // its stamp below would let an owner go on to close the account on the strength of it.
  if (role !== "rr_admin" && (await farmBillingGate(supabase, farmId)) === "pending") {
    return NextResponse.json({ error: "farm-not-active" }, { status: 402 });
  }
  const costsVisible = await canViewFarmCosts(supabase, farmId);
  const exportedAt = new Date().toISOString();
  const encoder = new TextEncoder();

  /*
    Streamed, one table at a time, one row per line. The whole bundle used to be built as a
    single pretty-printed string in memory and sent as one response, and a large enough farm
    passes the platform's response limit, which a streamed response does not have. The
    file is still one JSON document: the notes, which depend on what was read, close it.
  */
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(text));
      const truncated: string[] = [];
      const unavailable: string[] = [];
      try {
        write(`{"exported_at":${JSON.stringify(exportedAt)},"farm_id":${JSON.stringify(farmId)},` +
          `"exported_by":${JSON.stringify(profile.id)},"data":{`);
        let firstTable = true;
        for (const spec of TABLES) {
          // Every page up to the cap: a single read stops at the API's thousandth row.
          const { data, error, truncated: cut } = await readAll<Record<string, unknown>>(() => {
            const query = supabase
              .from(spec.source ?? spec.name)
              .select(spec.columns ?? "*")
              .eq(spec.farmColumn ?? "farm_id", farmId);
            return spec.order ? query.order(spec.order, { ascending: true }) : query;
          }, { maxRows: CAP, key: spec.key });
          if (error) {
            // A table this deployment does not have, or one this role cannot read at all.
            // Named rather than silently absent, so nobody reads it as "we had none".
            unavailable.push(spec.name);
            continue;
          }
          const rows = data ?? [];
          if (cut) truncated.push(spec.name);
          // Purchase and finance figures for a role that may see the farm's costs: they are
          // not readable from the machines table itself (20260903074350). Ten at a time.
          if (spec.name === "machines" && rows.length > 0 && costsVisible) {
            for (let i = 0; i < rows.length; i += 10) {
              const batch = rows.slice(i, i + 10);
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
          write(`${firstTable ? "" : ","}\n${JSON.stringify(spec.name)}:[`);
          rows.forEach((row, i) => write(`${i ? "," : ""}\n${JSON.stringify(row)}`));
          write(rows.length ? "\n]" : "]");
          firstTable = false;
        }
        const notes = [
          "Every table here is scoped by the same row-level security that governs the app, and " +
            "to this one farm, so it contains exactly what the person who asked for it may read.",
          "Photos, voice notes and uploaded documents are NOT in this file. They live in " +
            "storage and are referenced by path (the attachments table); ask " +
            "team@rapidriseai.com for a copy of the files.",
          truncated.length
            ? `Capped at ${CAP} rows: ${truncated.join(", ")}. Ask us for the rest.`
            : `No table reached the ${CAP}-row cap.`,
          unavailable.length ? `Not available to this account: ${unavailable.join(", ")}.` : null,
        ].filter(Boolean);
        write(`\n},"notes":${JSON.stringify(notes)}}\n`);
        // What lets an owner go on to close the account: a whole file, taken by them.
        if (role === "owner" && truncated.length === 0) {
          const { error: stampError } = await createServiceClient()
            .from("farms")
            .update({ last_export_at: new Date().toISOString() })
            .eq("id", farmId);
          if (stampError) captureError(stampError, { where: "export:stamp" });
        }
        controller.close();
      } catch (failure) {
        // Half a file must not look like a whole one: the stream errors, so the download
        // fails rather than saving a document that silently stops partway.
        controller.error(failure);
      }
    },
  });

  const stamp = exportedAt.slice(0, 10);
  return new NextResponse(stream, {
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
