import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createFault, resolveFault } from "./actions";
import { createJobCard } from "@/app/(app)/jobcards/actions";

type Fault = {
  id: string; machine_id: string; farm_id: string; description: string | null;
  category: string | null; urgency: string | null; status: string;
  created_at: string; reporter_name: string | null; job_card_id: string | null;
};

const URGENCY_STYLE: Record<string, string> = {
  stopped: "bg-status-overdue",
  limping: "bg-status-due",
  can_work: "bg-status-ok",
};

export default async function FaultsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const profile = await requireProfile();
  const sp = await searchParams;
  const supabase = await createClient();

  const { data: fData } = await supabase
    .from("faults")
    .select("id, machine_id, farm_id, description, category, urgency, status, created_at, reporter_name, job_card_id")
    .order("status")
    .order("created_at", { ascending: false })
    .limit(50);
  const faults = (fData as Fault[] | null) ?? [];

  const { data: mData } = await supabase.from("machines").select("id, name, farm_id").order("name");
  const machines = (mData as { id: string; name: string; farm_id: string }[] | null) ?? [];
  const nameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

  const canReport = ["owner", "manager", "mechanic", "operator"].includes(profile.role);
  const canJob = ["owner", "manager", "mechanic", "workshop"].includes(profile.role);
  const input = "rounded border border-gray-300 p-2 text-sm";

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Faults</h1>
      {sp.error ? <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p> : null}
      {sp.saved ? <p className="rounded bg-green-50 p-2 text-sm text-green-700">Saved.</p> : null}

      {canReport && machines.length > 0 ? (
        <form action={createFault} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-3">
          <h2 className="font-medium">Report a fault</h2>
          <select name="machine_id" required className={input}>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          {/* farm_id derived from the first machine's farm for single-farm users; RLS still enforces it */}
          <input type="hidden" name="farm_id" value={machines[0]?.farm_id ?? ""} />
          <textarea name="description" required rows={2} placeholder="What's wrong?" className={input} />
          <div className="flex gap-2">
            <select name="urgency" defaultValue="can_work" className={`${input} flex-1`}>
              <option value="can_work">Can work</option>
              <option value="limping">Limping</option>
              <option value="stopped">Stopped</option>
            </select>
            <input name="category" placeholder="Category (optional)" className={`${input} flex-1`} />
          </div>
          <button className="self-start rounded-lg bg-status-ok px-4 py-2 text-sm font-medium text-white">Report</button>
        </form>
      ) : null}

      <ul className="flex flex-col divide-y divide-gray-100">
        {faults.map((f) => (
          <li key={f.id} className="flex flex-col gap-1 py-3">
            <div className="flex items-center justify-between">
              <span className="font-medium">{nameById[f.machine_id] ?? "—"}</span>
              <span className={`rounded px-2 py-0.5 text-xs text-white ${URGENCY_STYLE[f.urgency ?? "can_work"]}`}>
                {f.urgency}
              </span>
            </div>
            <p className="text-sm text-gray-700">{f.description}</p>
            <p className="text-xs text-gray-400">
              {f.status.replace("_", " ")} · {new Date(f.created_at).toLocaleDateString("en-ZA")}
              {f.reporter_name ? ` · ${f.reporter_name}` : ""}
            </p>
            {f.status !== "resolved" ? (
              <div className="flex gap-2">
                {canJob && !f.job_card_id ? (
                  <form action={createJobCard}>
                    <input type="hidden" name="machine_id" value={f.machine_id} />
                    <input type="hidden" name="farm_id" value={f.farm_id} />
                    <input type="hidden" name="fault_id" value={f.id} />
                    <input type="hidden" name="type" value="repair" />
                    <button className="rounded border border-gray-300 px-2 py-1 text-xs">→ Job card</button>
                  </form>
                ) : null}
                <form action={resolveFault}>
                  <input type="hidden" name="id" value={f.id} />
                  <button className="rounded border border-gray-300 px-2 py-1 text-xs">Resolve</button>
                </form>
              </div>
            ) : null}
          </li>
        ))}
        {faults.length === 0 ? <li className="py-6 text-gray-400">No faults.</li> : null}
      </ul>
    </div>
  );
}
