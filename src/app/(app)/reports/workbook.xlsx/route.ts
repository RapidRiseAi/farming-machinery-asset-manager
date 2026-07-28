import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getReportData, parseFilters } from "../data";
import { buildXlsx, heading, text, num, moneyCell, type XlsxCell, type XlsxSheet } from "@/lib/xlsx";

/**
 * Single multi-sheet Excel (.xlsx) workbook covering every report family
 * (FR-11.4). One worksheet per family the CSV routes cover, reusing the SAME
 * header labels + row data, but money as REAL NUMBERS in Rands (server-only
 * OOXML writer; nothing ships to the client). Farm-scoped by RLS; gated on the
 * "advanced_reports" entitlement exactly like the CSV routes.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("advanced_reports", profile)).allowed)
    return new Response("Upgrade required", { status: 403 });

  const sp = Object.fromEntries(new URL(request.url).searchParams);
  const supabase = await createClient();
  const data = await getReportData(supabase, parseFilters(sp), await currentFarmId(profile));

  const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

  // 1) Cost per machine — mirrors cost.csv.
  const cost: XlsxCell[][] = [
    ["Machine", "Parts (R)", "Labour (R)", "Other (R)", "Spend in period (R)", "TCO (R)", "Cost per hour (R)", "Cost per km (R)"].map(heading),
  ];
  for (const r of data.costPerMachine) {
    cost.push([
      text(r.name),
      moneyCell(r.parts), moneyCell(r.labour), moneyCell(r.other), moneyCell(r.total), moneyCell(r.tco),
      moneyCell(r.perHour), moneyCell(r.perKm),
    ]);
  }

  // 2) Spend by type — mirrors by-type.csv.
  const byType: XlsxCell[][] = [["Job type", "Total (R)"].map(heading)];
  for (const r of data.byType) byType.push([text(r.type.replace(/_/g, " ")), moneyCell(r.total)]);

  // 3) Recurring problems — mirrors problems.csv (stacked sections).
  const problems: XlsxCell[][] = [["Machine (breaks most often)", "Count"].map(heading)];
  for (const b of data.problems.breaksMostOften) problems.push([text(b.name), num(b.count)]);
  problems.push([], ["Most-replaced part", "Count"].map(heading));
  for (const p of data.problems.topParts) problems.push([text(p.name), num(p.count)]);
  problems.push([], ["Top fault category", "Count"].map(heading));
  for (const ft of data.problems.topFaults) problems.push([text(ft.name), num(ft.count)]);

  // 4) Service compliance — mirrors compliance.csv.
  const compliance: XlsxCell[][] = [
    ["Metric", "Value"].map(heading),
    [text("OK"), num(data.compliance.ok)],
    [text("Due soon"), num(data.compliance.dueSoon)],
    [text("Overdue"), num(data.compliance.overdue)],
    [],
    ["Overdue machine", "Task"].map(heading),
  ];
  for (const o of data.compliance.overdueList) compliance.push([text(o.name), text(o.task)]);

  // 5) Fuel — mirrors fuel.csv.
  const fuel: XlsxCell[][] = [["Machine", "Litres", "Fuel spend (R)", "Consumption", "Unit"].map(heading)];
  for (const r of data.fuel.perMachine) {
    fuel.push([
      text(r.name),
      num(r.litres),
      moneyCell(r.spend),
      r.consumption != null ? num(round(r.consumption, 2)) : null,
      r.consumption != null ? text(r.meterType === "km" ? "L/100km" : "L/hr") : null,
    ]);
  }
  fuel.push(
    [],
    [text("Purchased (deliveries) litres"), num(data.fuel.purchasedLitres), text("spend (R)"), moneyCell(data.fuel.purchasedSpend)],
    [text("Used by machines (draws) litres"), num(data.fuel.totalLitres), text("spend (R)"), moneyCell(data.fuel.totalSpend)],
  );

  // 6) Contractors — mirrors contractors.csv (stacked sections).
  const c = data.contractors;
  const contractors: XlsxCell[][] = [
    ["Metric", "Count", "Value (R)"].map(heading),
    [text("Outstanding quotes"), num(c.outstandingQuotes.count), moneyCell(c.outstandingQuotes.value)],
    [text("Outstanding invoices"), num(c.outstandingInvoices.count), moneyCell(c.outstandingInvoices.value)],
    [text("Spend via contractors"), null, moneyCell(c.spendViaContractors)],
    [],
    [heading("Responsiveness (avg hours)"), text("requested→viewed"), num(c.responsiveness.requestedToViewedHrs)],
    [null, text("viewed→quoted"), num(c.responsiveness.viewedToQuotedHrs)],
    [null, text("sample (requests)"), num(c.responsiveness.sample)],
    [],
    [heading("Work requests by status")],
  ];
  for (const s of c.byStatus) contractors.push([text(s.status), num(s.count)]);
  contractors.push([], ["Contractor", "Requests", "Invoiced", "Spend (R)"].map(heading));
  for (const p of c.perContractor) contractors.push([text(p.name), num(p.requests), num(p.invoiced), moneyCell(p.spend)]);

  // 7) Budget vs actual — mirrors budgets.csv.
  const budgets: XlsxCell[][] = [
    ["Scope", "Category", "Period", "From", "To", "Budget (R)", "Actual (R)", "Variance (R)", "Used %", "Status"].map(heading),
  ];
  for (const b of data.budgets) {
    budgets.push([
      text(b.machineId ? b.scope : "Whole farm"),
      text(b.category ?? "All categories"),
      text(b.periodType),
      text(b.periodStart),
      text(b.periodEnd),
      moneyCell(b.amount),
      moneyCell(b.actual),
      moneyCell(b.variance),
      b.pct != null ? num(Math.round(b.pct)) : null,
      text(b.status === "over" ? "Over budget" : b.status === "warning" ? "Near limit" : "Under budget"),
    ]);
  }

  // 8) Utilisation & downtime — mirrors utilisation.csv.
  const w = data.utilisation.window;
  const utilisation: XlsxCell[][] = [
    [heading(`Utilisation & downtime — ${w.from} to ${w.to}`)],
    ["Machine", "Meter", "Used", "Utilisation %", "Idle", "Downtime (days)"].map(heading),
  ];
  for (const r of data.utilisation.perMachine) {
    const unit = r.meterType === "km" ? "km" : r.meterType === "hours" ? "h" : "";
    const dp = r.meterType === "km" ? 0 : 1;
    const withUnit = (v: number) => `${v.toFixed(dp)} ${unit}`.trim();
    utilisation.push([
      text(r.name),
      text(r.meterType),
      r.used != null ? text(withUnit(r.used)) : null,
      r.pct != null ? num(Math.round(r.pct)) : null,
      r.idle != null ? text(withUnit(r.idle)) : null,
      num(round(r.downtimeDays, 1)),
    ]);
  }

  const sheets: XlsxSheet[] = [
    { name: "Cost per machine", rows: cost },
    { name: "Spend by type", rows: byType },
    { name: "Recurring problems", rows: problems },
    { name: "Service compliance", rows: compliance },
    { name: "Fuel", rows: fuel },
    { name: "Contractors", rows: contractors },
    { name: "Budgets", rows: budgets },
    { name: "Utilisation", rows: utilisation },
  ];

  const workbook = buildXlsx(sheets);
  return new Response(new Uint8Array(workbook), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="fleetwise-reports.xlsx"',
    },
  });
}
