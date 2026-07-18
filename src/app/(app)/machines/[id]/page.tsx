import Link from "next/link";
import { notFound } from "next/navigation";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { MachineFields } from "@/components/machine-fields";
import { MACHINE_STATUSES, STATUS_LABELS, TYPE_LABELS, METER_LABELS } from "@/lib/machine-options";
import { updateMachine } from "../actions";
import { addReading } from "./reading-actions";
import { createJobCard } from "@/app/(app)/jobcards/actions";
import { MachinePhotos } from "@/components/machine-photos";
import { setWatchStatus } from "./watch-actions";
import { rands } from "@/lib/money";

type Machine = {
  id: string;
  farm_id: string;
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
      "id, farm_id, name, type, make, model, year, serial_no, reg_no, meter_type, current_reading, current_reading_date, status"
    )
    .eq("id", id)
    .maybeSingle();
  const machine = data as Machine | null;
  if (!machine) notFound();

  const { data: readingsData } = await supabase
    .from("meter_readings")
    .select("id, reading, reading_date, source")
    .eq("machine_id", id)
    .order("reading_date", { ascending: false })
    .limit(10);
  const readings =
    (readingsData as { id: string; reading: number; reading_date: string; source: string }[] | null) ?? [];
  const canAddReading =
    machine.meter_type !== "none" &&
    (profile.role === "owner" || profile.role === "manager" || profile.role === "mechanic");
  const canJob = ["owner", "manager", "mechanic", "workshop"].includes(profile.role);

  const { data: jcData } = await supabase
    .from("job_cards")
    .select("id, type, status, total_cents")
    .eq("machine_id", id)
    .order("created_at", { ascending: false })
    .limit(8);
  const jobCards = (jcData as { id: string; type: string; status: string; total_cents: number }[] | null) ?? [];

  const { data: watchData } = await supabase
    .from("watch_items")
    .select("id, text, status")
    .eq("machine_id", id)
    .eq("status", "open")
    .order("created_at", { ascending: false });
  const watchItems = (watchData as { id: string; text: string; status: string }[] | null) ?? [];

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
        <Link href={`/machines/${machine.id}/qr`} className="mt-1 inline-block text-sm text-status-ok">
          QR code →
        </Link>
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

      {machine.meter_type !== "none" ? (
        <section className="rounded-lg border border-gray-200 p-4">
          <h2 className="font-medium">Meter readings</h2>
          {canAddReading ? (
            <form action={addReading} className="mt-2 flex flex-wrap items-end gap-2">
              <input type="hidden" name="machine_id" value={machine.id} />
              <input type="hidden" name="farm_id" value={machine.farm_id} />
              <input
                name="reading"
                type="number"
                inputMode="decimal"
                step="0.1"
                required
                placeholder={`New ${machine.meter_type}`}
                className="rounded border border-gray-300 p-2"
              />
              <input name="reading_date" type="date" className="rounded border border-gray-300 p-2" />
              <button className="rounded-lg bg-status-ok px-4 py-2 font-medium text-white">Log</button>
            </form>
          ) : null}
          <ul className="mt-3 flex flex-col divide-y divide-gray-100 text-sm">
            {readings.map((r) => (
              <li key={r.id} className="flex justify-between py-1.5">
                <span>
                  {r.reading} {machine.meter_type}
                </span>
                <span className="text-gray-500">
                  {r.reading_date} · {r.source}
                </span>
              </li>
            ))}
            {readings.length === 0 ? <li className="py-2 text-gray-400">No readings yet.</li> : null}
          </ul>
        </section>
      ) : null}

      {watchItems.length > 0 ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="font-medium">Watch items</h2>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {watchItems.map((w) => (
              <li key={w.id} className="flex items-center justify-between gap-2">
                <span>{w.text}</span>
                {canEdit ? (
                  <span className="flex gap-1">
                    <form action={setWatchStatus}>
                      <input type="hidden" name="id" value={w.id} />
                      <input type="hidden" name="machine_id" value={machine.id} />
                      <input type="hidden" name="status" value="done" />
                      <button className="rounded border border-gray-300 px-2 text-xs">Done</button>
                    </form>
                    <form action={setWatchStatus}>
                      <input type="hidden" name="id" value={w.id} />
                      <input type="hidden" name="machine_id" value={machine.id} />
                      <input type="hidden" name="status" value="dismissed" />
                      <button className="rounded border border-gray-300 px-2 text-xs">Dismiss</button>
                    </form>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-lg border border-gray-200 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Job cards</h2>
          {canJob ? (
            <form action={createJobCard} className="flex gap-1">
              <input type="hidden" name="machine_id" value={machine.id} />
              <input type="hidden" name="farm_id" value={machine.farm_id} />
              <select name="type" className="rounded border border-gray-300 p-1 text-sm" defaultValue="repair">
                <option value="repair">Repair</option>
                <option value="scheduled_service">Service</option>
                <option value="inspection">Inspection</option>
                <option value="other">Other</option>
              </select>
              <button className="rounded bg-status-ok px-3 py-1 text-sm font-medium text-white">+ New</button>
            </form>
          ) : null}
        </div>
        <ul className="mt-2 flex flex-col divide-y divide-gray-100 text-sm">
          {jobCards.map((j) => (
            <li key={j.id}>
              <Link href={`/jobcards/${j.id}`} className="flex justify-between py-1.5">
                <span>{j.type.replace("_", " ")} · {j.status.replace("_", " ")}</span>
                <span className="text-gray-500">{rands(j.total_cents)}</span>
              </Link>
            </li>
          ))}
          {jobCards.length === 0 ? <li className="py-1.5 text-gray-400">None yet.</li> : null}
        </ul>
      </section>

      <MachinePhotos farmId={machine.farm_id} machineId={machine.id} canEdit={canEdit} />

      <p className="text-xs text-gray-400">
        QR code, service plan &amp; job-card history attach here in the next increments.
      </p>
    </div>
  );
}
