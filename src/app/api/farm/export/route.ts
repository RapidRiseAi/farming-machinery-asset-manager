import { NextResponse } from "next/server";

import { getProfile, currentFarmId, effectiveFarmRole, accessibleFarms } from "@/lib/auth";
import { farmLifecycle } from "@/lib/billing/service";
import { exportRefusal } from "@/lib/farm-export-policy";
import { canViewFarmCosts, readMachineFinancials } from "@/lib/cost-visibility";
import { captureError } from "@/lib/observability";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { PAGE_ROWS } from "@/lib/supabase/read-all";
import { isUuid } from "@/lib/ids";
import { EXPORT_TABLES } from "@/lib/farm-export/tables";

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

/**
 * Per table, so one enormous business cannot produce a response nothing can open. Rows are
 * read and written a page at a time (B3, BRIEF section 19: no giant in-memory work), so the
 * cap bounds the file and the time, not the memory; it was 5,000 when a table was held whole.
 */
const CAP = 50_000;

/**
 * The tables and how each is read live in one list shared with the complete export job
 * (`src/lib/farm-export/tables.ts`). `attachments` carries metadata only: the files themselves
 * come with the complete export (`/api/farm/export/jobs`), which this file's notes point to.
 */
const TABLES = EXPORT_TABLES;

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
  // Use the lifecycle's gate rather than the screen gate, which deliberately fails open
  // on a read error. A failed export check must not produce an apparently complete file.
  const lifecycle = role === "rr_admin" ? null : await farmLifecycle(supabase, farmId);
  const refusal = exportRefusal(role, lifecycle?.gate ?? null, lifecycle);
  if (refusal) return NextResponse.json({ error: refusal.error }, { status: refusal.status });
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
          // A page at a time, written as it arrives, up to the cap: a single read stops at the
          // API's thousandth row, and holding a whole table was the in-memory work to avoid.
          const key = spec.key ?? "id";
          let wrote = 0;
          let failed = false;
          for (let from = 0; from < CAP; from += PAGE_ROWS) {
            const to = Math.min(from + PAGE_ROWS, CAP) - 1;
            const base = supabase
              .from(spec.source ?? spec.name)
              .select(spec.columns ?? "*")
              .eq(spec.farmColumn ?? "farm_id", farmId);
            const ordered = spec.order ? base.order(spec.order, { ascending: true }) : base;
            const { data, error } = await ordered.order(key, { ascending: true }).range(from, to);
            if (error) {
              // A table this deployment does not have, or one this role cannot read at all.
              // Named rather than silently absent, so nobody reads it as "we had none". A
              // failure after rows were written cannot be undone in a stream: the file errors.
              if (wrote > 0) throw new Error(`export: ${spec.name} failed part-way`);
              failed = true;
              break;
            }
            const rows = (Array.isArray(data) ? data : []) as unknown as Record<string, unknown>[];
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
            if (wrote === 0) write(`${firstTable ? "" : ","}\n${JSON.stringify(spec.name)}:[`);
            for (const row of rows) {
              write(`${wrote ? "," : ""}\n${JSON.stringify(row)}`);
              wrote += 1;
            }
            if (rows.length < to - from + 1) break;
            if (to + 1 >= CAP) truncated.push(spec.name);
          }
          if (failed) {
            unavailable.push(spec.name);
            continue;
          }
          if (wrote === 0) write(`${firstTable ? "" : ","}\n${JSON.stringify(spec.name)}:[`);
          write(wrote ? "\n]" : "]");
          firstTable = false;
        }
        const notes = [
          "Every table here is scoped by the same row-level security that governs the app, and " +
            "to this one farm, so it contains exactly what the person who asked for it may read.",
          "Photos, voice notes and uploaded documents are NOT in this file. They are referenced by " +
            "path (the attachments table); the complete export, prepared in the background with a " +
            "manifest of every file, includes them.",
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
