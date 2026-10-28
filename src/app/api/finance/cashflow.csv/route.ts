import { toCsv, csvResponse } from "@/app/(app)/reports/data";
import { cashflowCsvRows, loadCashflowExport } from "@/lib/asset-finance-export";

export const dynamic = "force-dynamic";

/** The farm's finance and contract cash flow, twelve months ahead, as a CSV (see the lib). */
export async function GET() {
  const loaded = await loadCashflowExport();
  if (!loaded.ok) return loaded.response;
  return csvResponse(
    `fleetwise-finance-cashflow-${loaded.today}.csv`,
    toCsv(cashflowCsvRows(loaded.commitments, loaded.today, loaded.locale)),
  );
}
