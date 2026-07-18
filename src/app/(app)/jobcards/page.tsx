import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rands } from "@/lib/money";

const STATUSES = ["reported", "open", "in_progress", "waiting_parts", "completed", "approved"];

type JobCard = {
  id: string;
  type: string;
  status: string;
  date_in: string | null;
  total_cents: number;
  machine_id: string;
};

export default async function JobCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requireProfile();
  const sp = await searchParams;

  const supabase = await createClient();
  let q = supabase
    .from("job_cards")
    .select("id, type, status, date_in, total_cents, machine_id")
    .order("created_at", { ascending: false });
  if (sp.status) q = q.eq("status", sp.status);
  const { data } = await q;
  const cards = (data as JobCard[] | null) ?? [];

  const ids = [...new Set(cards.map((c) => c.machine_id))];
  const { data: ms } = ids.length
    ? await supabase.from("machines").select("id, name").in("id", ids)
    : { data: [] };
  const nameById = Object.fromEntries(((ms as { id: string; name: string }[] | null) ?? []).map((m) => [m.id, m.name]));

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">Job cards</h1>
      <form className="flex gap-2">
        <select name="status" defaultValue={sp.status ?? ""} className="rounded border border-gray-300 p-2 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
        <button className="rounded border border-gray-300 px-3 py-2 text-sm">Filter</button>
      </form>
      <ul className="flex flex-col divide-y divide-gray-100">
        {cards.map((c) => (
          <li key={c.id}>
            <Link href={`/jobcards/${c.id}`} className="flex items-center justify-between py-3">
              <span>
                <span className="font-medium">{nameById[c.machine_id] ?? "—"}</span>
                <span className="ml-2 text-sm text-gray-500">
                  {c.type.replace("_", " ")} · {c.status.replace("_", " ")}
                </span>
              </span>
              <span className="text-sm text-gray-600">{rands(c.total_cents)}</span>
            </Link>
          </li>
        ))}
        {cards.length === 0 ? <li className="py-6 text-gray-400">No job cards.</li> : null}
      </ul>
    </div>
  );
}
