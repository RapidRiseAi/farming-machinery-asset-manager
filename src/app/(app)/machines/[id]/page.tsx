import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { MachineFields } from "@/components/machine-fields";
import { MACHINE_STATUSES, STATUS_LABELS, TYPE_LABELS, METER_LABELS } from "@/lib/machine-options";
import { updateMachine } from "../actions";

type Machine = {
  id: string;
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serial_no: string | null;
  reg_no: string | null;
  meter_type: string;
  current_reading: number | null;
  current_reading_date: string | null;
  status: string;
};

export default async function MachineDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const { id } = await params;
  const sp = await searchParams;
  const canEdit = profile.role === "owner" || profile.role === "manager";

  const supabase = await createClient();
  const { data } = await supabase
    .from("machines")
    .select(
      "id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status"
    )
    .eq("id", id)
    .maybeSingle();
  const machine = data as Machine | null;
  if (!machine) notFound();

  return (
    <div className="flex flex-col gap-4">
      <Link href="/machines" className="text-sm text-gray-500">
        ← Machines
      </Link>
      <div>
        <h1 className="text-xl font-bold">{machine.name}</h1>
        <p className="text-sm text-gray-500">
          {TYPE_LABELS[machine.type] ?? machine.type}
          {machine.make ? ` · ${machine.make} ${machine.model ?? ""}` : ""} ·{" "}
          {STATUS_LABELS[machine.status] ?? machine.status}
        </p>
        <p className="mt-1 text-sm text-gray-500">
          {METER_LABELS[machine.meter_type] ?? machine.meter_type}
          {machine.current_reading != null
            ? `: ${machine.current_reading}${machine.current_reading_date ? ` (${machine.current_reading_date})` : ""}`
            : ""}
        </p>
      </div>

      {sp.error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p> : null}
      {sp.saved ? <p className="rounded bg-green-50 p-2 text-sm text-green-700">Saved.</p> : null}

      {canEdit ? (
        <form action={updateMachine} className="flex flex-col gap-3 rounded-lg border border-gray-200 p-4">
          <h2 className="font-medium">Edit</h2>
          <input type="hidden" name="id" value={machine.id} />
          <MachineFields machine={machine} />
          <select name="status" defaultValue={machine.status} className="rounded border border-gray-300 p-2">
            {MACHINE_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <button className="rounded-lg bg-status-ok px-4 py-3 font-medium text-white">Save</button>
        </form>
      ) : null}

      <p className="text-xs text-gray-400">
        Meter readings, QR code, service plan &amp; job-card history attach here in the next increments.
      </p>
    </div>
  );
}
