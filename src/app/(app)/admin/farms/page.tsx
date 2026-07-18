import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createFarm } from "./actions";

type FarmRow = {
  id: string;
  name: string;
  tier: string;
  status: string;
  created_at: string;
};

export default async function AdminFarmsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; created?: string }>;
}) {
  await requireRole(["rr_admin"]);
  const sp = await searchParams;

  const supabase = await createClient();
  const { data } = await supabase
    .from("farms")
    .select("id, name, tier, status, created_at")
    .order("created_at", { ascending: false });
  const farms = (data as FarmRow[] | null) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold">Farms</h1>

      {sp.error ? (
        <p className="rounded bg-red-50 p-2 text-sm text-red-700">{sp.error}</p>
      ) : null}
      {sp.created ? (
        <p className="rounded bg-green-50 p-2 text-sm text-green-700">Farm created.</p>
      ) : null}

      <form action={createFarm} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-4">
        <h2 className="font-medium">Create farm</h2>
        <input
          name="name"
          required
          placeholder="Farm name"
          className="rounded border border-gray-300 p-2"
        />
        <select name="tier" className="rounded border border-gray-300 p-2" defaultValue="starter">
          <option value="starter">Starter (≤10 machines)</option>
          <option value="standard">Standard (≤25)</option>
          <option value="large">Large (unlimited)</option>
        </select>
        <button className="rounded-lg bg-status-ok px-4 py-2 font-medium text-white">
          Create farm
        </button>
      </form>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-gray-500">
            <tr>
              <th className="py-2">Name</th>
              <th>Tier</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {farms.map((f) => (
              <tr key={f.id} className="border-t border-gray-100">
                <td className="py-2">
                  <Link href={`/admin/farms/${f.id}`} className="text-status-ok">
                    {f.name}
                  </Link>
                </td>
                <td>{f.tier}</td>
                <td>{f.status}</td>
              </tr>
            ))}
            {farms.length === 0 ? (
              <tr>
                <td colSpan={3} className="py-4 text-gray-400">
                  No farms yet — create the first one above.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
