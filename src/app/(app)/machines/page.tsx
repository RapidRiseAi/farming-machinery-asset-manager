import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MACHINE_TYPES,
  MACHINE_STATUSES,
  TYPE_LABELS,
  STATUS_LABELS,
} from "@/lib/machine-options";

type MachineRow = {
  id: string;
  name: string;
  type: string;
  make: string | null;
  model: string | null;
  status: string;
  meter_type: string;
  current_reading: number | null;
};

export default async function MachinesPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; status?: string; q?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const canEdit = profile.role === "owner" || profile.role === "manager";

  const supabase = await createClient();
  let query = supabase
    .from("machines")
    .select("id, name, type, make, model, status, meter_type, current_reading")
    .order("name");
  if (sp.type) query = query.eq("type", sp.type);
  if (sp.status) query = query.eq("status", sp.status);
  if (sp.q) query = query.ilike("name", `%${sp.q}%`);
  const { data } = await query;
  const machines = (data as MachineRow[] | null) ?? [];

  const select = "rounded border border-gray-300 p-2 text-sm";
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Machines</h1>
        {canEdit ? (
          <Link href="/machines/new" className="rounded-lg bg-status-ok px-3 py-2 text-sm font-medium text-white">
            + Add
          </Link>
        ) : null}
      </div>

      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search name" className={select} />
        <select name="type" defaultValue={sp.type ?? ""} className={select}>
          <option value="">All types</option>
          {MACHINE_TYPES.map((t) => (
            <option key={t} value={t}>{TYPE_LABELS[t]}</option>
          ))}
        </select>
        <select name="status" defaultValue={sp.status ?? ""} className={select}>
          <option value="">All statuses</option>
          {MACHINE_STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </select>
        <button className="rounded border border-gray-300 px-3 py-2 text-sm">Filter</button>
      </form>

      <ul className="flex flex-col divide-y divide-gray-100">
        {machines.map((m) => (
          <li key={m.id}>
            <Link href={`/machines/${m.id}`} className="flex items-center justify-between py-3">
              <span>
                <span className="font-medium">{m.name}</span>
                <span className="ml-2 text-sm text-gray-500">
                  {TYPE_LABELS[m.type] ?? m.type}
                  {m.make ? ` · ${m.make}` : ""}
                </span>
              </span>
              <span className="text-sm text-gray-500">{STATUS_LABELS[m.status] ?? m.status}</span>
            </Link>
          </li>
        ))}
        {machines.length === 0 ? (
          <li className="py-6 text-gray-400">No machines match.</li>
        ) : null}
      </ul>
    </div>
  );
}
