import { cashflowWorkbook, loadCashflowExport } from "@/lib/asset-finance-export";

export const dynamic = "force-dynamic";

/** The same cash flow as a workbook: a month sheet and a line sheet, money as numbers. */
export async function GET() {
  const loaded = await loadCashflowExport();
  if (!loaded.ok) return loaded.response;
  const workbook = cashflowWorkbook(loaded.commitments, loaded.today, loaded.locale);
  return new Response(new Uint8Array(workbook), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="fleetwise-finance-cashflow-${loaded.today}.xlsx"`,
    },
  });
}
