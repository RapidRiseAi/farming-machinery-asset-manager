"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { errorCode } from "@/lib/action-errors";
import { requireEntitlement, requireRole } from "@/lib/auth";
import { checkFills, plainReg, readFills } from "@/lib/fuel-cards";
import { readAll } from "@/lib/supabase/read-all";
import { must } from "@/lib/supabase/must";
import { createClient } from "@/lib/supabase/server";
import { parseCsv } from "../../machines/import/csv";

const HERE = "/fuel/cards";
const MAX_BYTES = 2 * 1024 * 1024;

export async function importStatement(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  await requireEntitlement("fuel", "/fuel");
  const farmId = profile.farm_id;
  if (!farmId) redirect(`${HERE}?error=fuel-card-file`);

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES) redirect(`${HERE}?error=fuel-card-file`);

  const { fills, skipped, missing } = readFills(parseCsv(await file.text()));
  if (missing.length > 0) redirect(`${HERE}?error=fuel-card-columns`);
  if (fills.length === 0) redirect(`${HERE}?error=fuel-card-empty`);

  const supabase = await createClient();
  const vehicles = must(
    await readAll(() => supabase.from("machines").select("id, reg_no, fuel_tank_litres").eq("farm_id", farmId).is("deleted_at", null)),
    "fuel-cards:vehicles",
  ) as { id: string; reg_no: string | null; fuel_tank_litres: number | null }[] | null;

  const earliest = fills.map((f) => f.occurredAt).sort()[0];
  const since = new Date(Date.parse(earliest) - 7 * 24 * 60 * 60 * 1000).toISOString();
  const history = must(
    await supabase
      .from("fuel_card_transactions")
      .select("machine_id, occurred_at, odometer")
      .eq("farm_id", farmId)
      .gte("occurred_at", since)
      .not("machine_id", "is", null)
      .limit(5000),
    "fuel-cards:history",
  ) as { machine_id: string; occurred_at: string; odometer: number | null }[] | null;

  const checked = checkFills(
    fills,
    (vehicles ?? []).map((v) => ({ id: v.id, regKey: plainReg(v.reg_no), tankLitres: v.fuel_tank_litres })),
    (history ?? []).map((h) => ({ machineId: h.machine_id, occurredAt: h.occurred_at, odometer: h.odometer })),
  );

  const { data: statement, error: statementError } = await supabase
    .from("fuel_card_statements")
    .insert({ farm_id: farmId, file_name: file.name.slice(0, 200), uploaded_by: profile.id })
    .select("id")
    .single();
  if (statementError || !statement) {
    redirect(`${HERE}?error=${errorCode(statementError, "app/fuel/cards:statement", "fuel-card-file")}`);
  }

  // Bringing the same statement in twice adds nothing: those fills are already here.
  const { data: added, error } = await supabase
    .from("fuel_card_transactions")
    .upsert(
      checked.map((c) => ({
        farm_id: farmId,
        statement_id: statement.id,
        occurred_at: c.occurredAt,
        card_ref: c.cardRef,
        vehicle_ref: c.vehicleRef,
        machine_id: c.machineId,
        driver_ref: c.driverRef,
        merchant: c.merchant,
        litres: c.litres,
        amount_cents: c.amountCents,
        odometer: c.odometer,
        flags: c.flags,
      })),
      { onConflict: "farm_id,occurred_at,card_ref,litres,amount_cents", ignoreDuplicates: true },
    )
    .select("id");
  if (error) redirect(`${HERE}?error=${errorCode(error, "app/fuel/cards:import", "fuel-card-file")}`);

  revalidatePath(HERE);
  redirect(`${HERE}?added=${added?.length ?? 0}&skipped=${skipped}`);
}

/** Somebody looked at a flagged fill. It stays on record, marked as dealt with. */
export async function markFillChecked(formData: FormData) {
  const profile = await requireRole(["owner", "manager"]);
  const id = String(formData.get("id") ?? "");
  if (!id || !profile.farm_id) redirect(HERE);
  const supabase = await createClient();
  const { error } = await supabase
    .from("fuel_card_transactions")
    .update({ checked_by: profile.id, checked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("farm_id", profile.farm_id);
  if (error) redirect(`${HERE}?error=${errorCode(error, "app/fuel/cards:check", "fuel-card-file")}`);
  revalidatePath(HERE);
  redirect(HERE);
}
