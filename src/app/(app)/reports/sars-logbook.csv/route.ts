import { getProfile, checkEntitlement, currentFarmId } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { csvResponse, parseFilters, toCsv } from "../data";
import {
  storageLogbookRows,
  usageLogbookRows,
  type LogbookDelivery,
  type LogbookIssue,
  type LogbookMachine,
} from "@/lib/fuel-logbook";

/**
 * The SARS diesel-refund logbooks (Scope §9), storage or usage, as a CSV.
 *
 * `?book=storage` walks every litre into and out of each tank with a running balance;
 * `?book=usage` lists every draw with the machine, the activity, the meter and the driver.
 * Both are the records a rebate claim is audited against, and both carry a first line
 * saying an accountant must check them before anything is claimed.
 *
 * Deliberately NOT gated on cost visibility, unlike `fuel.csv`: a logbook is litres and
 * activities, not money. Nothing here names a price, so an operator who may not see costs
 * can still produce the trail, and the plan gate above still applies.
 */
export async function GET(request: Request) {
  const profile = await getProfile();
  if (!profile || !profile.active) return new Response("Unauthorized", { status: 401 });
  if (!(await checkEntitlement("fuel", profile)).allowed) {
    return new Response("Upgrade required", { status: 403 });
  }

  const url = new URL(request.url);
  const sp = Object.fromEntries(url.searchParams);
  const filters = parseFilters(sp);
  const book = url.searchParams.get("book") === "storage" ? "storage" : "usage";

  const supabase = await createClient();
  const farmId = await currentFarmId(profile);
  if (!farmId) return new Response("No farm", { status: 404 });

  const inRange = <Q extends { gte(c: string, v: string): Q; lte(c: string, v: string): Q }>(q: Q): Q => {
    let out = q;
    if (filters.from) out = out.gte("date", filters.from);
    if (filters.to) out = out.lte("date", filters.to);
    return out;
  };

  const [tankRes, machineRes, delRes, issRes, userRes] = await Promise.all([
    supabase.from("fuel_tanks").select("id, name").eq("farm_id", farmId).is("deleted_at", null).order("name"),
    supabase.from("machines").select("id, name, reg_no, meter_type").eq("farm_id", farmId).is("deleted_at", null),
    inRange(supabase.from("fuel_deliveries").select("tank_id, date, litres, supplier, invoice_no")
      .eq("farm_id", farmId).is("deleted_at", null)),
    inRange(supabase.from("fuel_issues").select("tank_id, machine_id, date, litres, meter_reading, activity, by_user, driver_name")
      .eq("farm_id", farmId).is("deleted_at", null)),
    supabase.from("users").select("id, name").is("deleted_at", null),
  ]);

  const tanks = (tankRes.data as { id: string; name: string }[] | null) ?? [];
  const machines = new Map(
    ((machineRes.data as LogbookMachine[] | null) ?? []).map((m) => [m.id, m]),
  );
  const userName = new Map(((userRes.data as { id: string; name: string }[] | null) ?? [])
    .map((u) => [u.id, u.name]));
  const deliveries = (delRes.data as LogbookDelivery[] | null) ?? [];
  const issues = (((issRes.data as (Omit<LogbookIssue, "driver"> & {
    by_user: string | null; driver_name: string | null;
  })[] | null) ?? []).map((i) => ({
    ...i,
    // Whoever drew it: the signed-in person, else the name a QR capture carried.
    driver: (i.by_user ? userName.get(i.by_user) : null) ?? i.driver_name ?? null,
  })) as LogbookIssue[]);

  const locale = profile.lang;
  const stamp = `${filters.from ?? "all"}_${filters.to ?? "all"}`;

  if (book === "usage") {
    const tankNames = new Map(tanks.map((tk) => [tk.id, tk.name]));
    return csvResponse(
      `sars-usage-logbook_${stamp}.csv`,
      toCsv(usageLogbookRows(issues, machines, tankNames, locale)),
    );
  }

  // One file covering every tank, each with its own heading and running balance: a farm
  // with three tanks should not have to download three times and staple them together.
  const rows: (string | number)[][] = [];
  for (const tank of tanks) {
    const block = storageLogbookRows(
      tank.name,
      deliveries.filter((d) => d.tank_id === tank.id),
      issues.filter((i) => i.tank_id === tank.id),
      machines,
      locale,
    );
    // The draft notice belongs at the top of the file, not above every tank.
    rows.push(...(rows.length === 0 ? block : block.slice(1)), []);
  }
  return csvResponse(`sars-storage-logbook_${stamp}.csv`, toCsv(rows));
}
